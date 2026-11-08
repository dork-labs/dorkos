/**
 * The record of what each turn actually handed its runtime (spec "Agent
 * context viewer + session timeline", phase 1). Principle 1: show what a turn
 * received, never a reconstruction, so this stores the exact text an adapter
 * passed at the moment it passed it.
 *
 * Bodies are content-addressed: each distinct text is stored once in
 * `turn_context_bodies` under its sha256, and each turn's parts name it. A
 * session append that does not change between turns costs one row of text.
 *
 * Retention (Security, Nov 8). A body lives only while a part written in the
 * last 30 days still names it. The reference count is derived from the parts
 * themselves rather than kept in a counter, so it cannot drift: deleting the
 * last session that used a body, or ageing past the window, deletes the text.
 * The turn rows and their parts keep hashes, sizes and token estimates.
 *
 * Private to the person: nothing outside this module reads it yet. No route,
 * no agent tool, no extension, no feedback bundle.
 *
 * @module services/session/turn-context/turn-context-store
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lt,
  sql,
  turnContextBodies,
  turnContextParts,
  turnContexts,
  type Db,
} from '@dorkos/db';
import { estimateTokens } from '../../runtimes/shared/window/context-fit.js';
import { sweepContextBody } from './turn-context-redaction.js';

/** How long a body's full text is kept: 30 days (Security, Nov 8). */
export const TURN_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Where a turn happened. */
export type TurnContextPlace = 'chat' | 'room' | 'dm' | 'task' | 'heartbeat';

/**
 * A runtime's own count of what its context holds, by category. Only ever what
 * the runtime reported: Claude Code counts its preset, tools and memory files,
 * whose text never passes through DorkOS, so the count is all there is of them.
 */
export interface TurnContextUsage {
  /** `measured`: the runtime counted each category. `estimate`: it approximated. */
  kind: 'measured' | 'estimate';
  /** When in the turn it was taken. */
  at: 'turn_start';
  /** The model the counts are for, when the runtime said. */
  model?: string;
  /** Tokens in use across the context. */
  totalTokens: number;
  /** The context window, in tokens. */
  maxTokens: number;
  /** Each category the runtime reported, in its order. */
  categories: { id?: string; name: string; tokens: number; kind: string }[];
}

/** One named piece of what a runtime received, exactly as it received it. */
export interface TurnContextPartInput {
  /** What the piece is: `system_append`, `prompt`, `system`, `synthetic`, ... */
  slot: string;
  /** The text, byte for byte as handed over. */
  text: string;
}

/** Everything one hand-over records. */
export interface TurnContextInput {
  /** The session that took the turn. */
  sessionId: string;
  /** The server-minted id of the message the turn delivered, when there was one. */
  messageId?: string;
  /** Which runtime received it. */
  runtime: string;
  /** Where the turn happened. */
  place: TurnContextPlace;
  /** The permission mode the adapter ran the turn at, when it knows one. */
  permissionMode?: string;
  /**
   * Whether the system part rode this hand-over, or is one the runtime already
   * holds from an earlier turn (a Codex thread's stable half, a warm Claude
   * Code process's append).
   */
  systemSentThisTurn: boolean;
  /** The pieces, in the order the runtime received them. */
  parts: readonly TurnContextPartInput[];
}

/** One stored piece, as the internal reader returns it. */
export interface RecordedTurnContextPart {
  /** What the piece is. */
  slot: string;
  /** sha256 (hex) of the stored body. */
  bodyHash: string;
  /** Size of the stored body in UTF-8 bytes. */
  bytes: number;
  /** Estimated tokens; an estimate, labelled as one. */
  tokensEstimate: number;
  /** True when a secret was swept out, so the body is not the exact bytes sent. */
  redacted: boolean;
  /** The stored text, or `null` once it has been deleted or aged out. */
  body: string | null;
}

/** One stored hand-over. */
export interface RecordedTurnContext {
  /** The record's id. */
  id: string;
  /** The session that took the turn. */
  sessionId: string;
  /** The message the turn delivered, or `null`. */
  messageId: string | null;
  /** Which runtime received it. */
  runtime: string;
  /** Where the turn happened. */
  place: TurnContextPlace;
  /** The permission mode the turn ran at, or `null`. */
  permissionMode: string | null;
  /** Whether the system part rode this hand-over. */
  systemSentThisTurn: boolean;
  /** The runtime's own count of the context, or `null` when it reported none. */
  usage: TurnContextUsage | null;
  /** When it was handed over (ISO 8601). */
  createdAt: string;
  /** The pieces, in order. */
  parts: RecordedTurnContextPart[];
}

/** Options for {@link TurnContextStore}. */
export interface TurnContextStoreOptions {
  /** The clock; injectable so a test can age a record. */
  now?: () => Date;
  /** Live secret values to sweep out of every body before it is stored. */
  knownSecrets?: () => readonly string[];
  /** How long full text is kept; defaults to {@link TURN_CONTEXT_RETENTION_MS}. */
  retentionMs?: number;
}

/** A body's sha256, hex. */
function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Reads and writes the turn-context record. */
export class TurnContextStore {
  private readonly now: () => Date;
  private readonly knownSecrets: () => readonly string[];
  private readonly retentionMs: number;

  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   * @param options - Clock, secret values and retention.
   */
  constructor(
    private readonly db: Db,
    options: TurnContextStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.knownSecrets = options.knownSecrets ?? (() => []);
    this.retentionMs = options.retentionMs ?? TURN_CONTEXT_RETENTION_MS;
  }

  /**
   * Record one hand-over. Each part is swept for secrets, hashed, and stored
   * once; a body already held is referenced, not stored again.
   *
   * @param input - What the runtime received, and where.
   * @returns The new record's id.
   */
  record(input: TurnContextInput): string {
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    const secrets = this.knownSecrets();
    const parts = input.parts.map((part, position) => {
      const swept = sweepContextBody(part.text, secrets);
      return {
        position,
        slot: part.slot,
        body: swept.text,
        bodyHash: hashBody(swept.text),
        bytes: Buffer.byteLength(swept.text, 'utf8'),
        tokensEstimate: estimateTokens(swept.text.length),
        redacted: swept.redacted,
      };
    });
    this.db.transaction((tx) => {
      tx.insert(turnContexts)
        .values({
          id,
          sessionId: input.sessionId,
          messageId: input.messageId ?? null,
          runtime: input.runtime,
          place: input.place,
          permissionMode: input.permissionMode ?? null,
          systemSentThisTurn: input.systemSentThisTurn,
          usage: null,
          usageKind: null,
          createdAt,
        })
        .run();
      for (const part of parts) {
        tx.insert(turnContextBodies)
          .values({ hash: part.bodyHash, body: part.body, createdAt })
          .onConflictDoNothing({ target: turnContextBodies.hash })
          .run();
        tx.insert(turnContextParts)
          .values({
            turnContextId: id,
            position: part.position,
            slot: part.slot,
            bodyHash: part.bodyHash,
            bytes: part.bytes,
            tokensEstimate: part.tokensEstimate,
            redacted: part.redacted,
          })
          .run();
      }
    });
    return id;
  }

  /**
   * Attach the runtime's own count of a turn's context, once it answers. A
   * record whose session has gone since is simply not found.
   *
   * @param id - The record, as {@link record} returned it.
   * @param usage - What the runtime reported.
   */
  attachUsage(id: string, usage: TurnContextUsage): void {
    this.db
      .update(turnContexts)
      .set({ usage: JSON.stringify(usage), usageKind: usage.kind })
      .where(eq(turnContexts.id, id))
      .run();
  }

  /**
   * Every hand-over recorded for a session, oldest first. Internal only: the
   * person-only viewer and its routes come in a later phase, after Security
   * rules on who may read them. A body older than the retention window reads
   * as `null` even while a newer turn still holds the same text.
   *
   * @param sessionId - The session.
   */
  listForSession(sessionId: string): RecordedTurnContext[] {
    const rows = this.db
      .select()
      .from(turnContexts)
      .where(eq(turnContexts.sessionId, sessionId))
      .orderBy(asc(turnContexts.createdAt))
      .all();
    if (rows.length === 0) return [];
    const parts = this.db
      .select({
        turnContextId: turnContextParts.turnContextId,
        position: turnContextParts.position,
        slot: turnContextParts.slot,
        bodyHash: turnContextParts.bodyHash,
        bytes: turnContextParts.bytes,
        tokensEstimate: turnContextParts.tokensEstimate,
        redacted: turnContextParts.redacted,
        body: turnContextBodies.body,
      })
      .from(turnContextParts)
      .leftJoin(turnContextBodies, eq(turnContextBodies.hash, turnContextParts.bodyHash))
      .where(
        inArray(
          turnContextParts.turnContextId,
          rows.map((row) => row.id)
        )
      )
      .orderBy(asc(turnContextParts.position))
      .all();
    const cutoff = this.cutoff();
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      messageId: row.messageId,
      runtime: row.runtime,
      place: row.place as TurnContextPlace,
      permissionMode: row.permissionMode,
      systemSentThisTurn: row.systemSentThisTurn,
      usage: row.usage === null ? null : (JSON.parse(row.usage) as TurnContextUsage),
      createdAt: row.createdAt,
      parts: parts
        .filter((part) => part.turnContextId === row.id)
        .map((part) => ({
          slot: part.slot,
          bodyHash: part.bodyHash,
          bytes: part.bytes,
          tokensEstimate: part.tokensEstimate,
          redacted: part.redacted,
          body: row.createdAt >= cutoff ? part.body : null,
        })),
    }));
  }

  /**
   * Delete every record of the named sessions, and every body no remaining
   * live record names. The storage half of session teardown.
   *
   * @param sessionIds - The sessions that are gone; an empty list does nothing.
   * @returns How many turn records went.
   */
  deleteForSessions(sessionIds: readonly string[]): number {
    if (sessionIds.length === 0) return 0;
    return this.db.transaction((tx) => {
      const doomed = tx
        .select({ id: turnContexts.id })
        .from(turnContexts)
        .where(inArray(turnContexts.sessionId, [...sessionIds]))
        .all()
        .map((row) => row.id);
      if (doomed.length === 0) return 0;
      const hashes = tx
        .selectDistinct({ hash: turnContextParts.bodyHash })
        .from(turnContextParts)
        .where(inArray(turnContextParts.turnContextId, doomed))
        .all()
        .map((row) => row.hash);
      // Parts go with their record through the foreign key's cascade.
      tx.delete(turnContexts).where(inArray(turnContexts.id, doomed)).run();
      this.deleteUnreferenced(tx, hashes);
      return doomed.length;
    });
  }

  /**
   * Move a session's records to the id it is now known by, when a first turn's
   * request id gives way to the runtime's canonical one.
   *
   * @param fromId - The id the records are stored under today.
   * @param toId - The canonical id.
   */
  rekeySession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db
      .update(turnContexts)
      .set({ sessionId: toId })
      .where(eq(turnContexts.sessionId, fromId))
      .run();
  }

  /**
   * Delete the full text of every body that no record from the last 30 days
   * still names. Hashes, sizes and token estimates on the records stay.
   *
   * @returns How many bodies went.
   */
  sweepExpired(): number {
    const cutoff = this.cutoff();
    const stale = this.db
      .select({ hash: turnContextBodies.hash })
      .from(turnContextBodies)
      .where(lt(turnContextBodies.createdAt, cutoff))
      .all()
      .map((row) => row.hash);
    if (stale.length === 0) return 0;
    return this.db.transaction((tx) => this.deleteUnreferenced(tx, stale));
  }

  /** The oldest creation time whose text is still kept. */
  private cutoff(): string {
    return new Date(this.now().getTime() - this.retentionMs).toISOString();
  }

  /**
   * Of the named bodies, delete the ones no record inside the retention window
   * names any more. The derived reference count: a body with no live part
   * pointing at it has a count of zero.
   */
  private deleteUnreferenced(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    hashes: readonly string[]
  ): number {
    let removed = 0;
    const cutoff = this.cutoff();
    for (const hash of hashes) {
      const live = tx
        .select({ n: sql<number>`count(*)` })
        .from(turnContextParts)
        .innerJoin(turnContexts, eq(turnContexts.id, turnContextParts.turnContextId))
        .where(and(eq(turnContextParts.bodyHash, hash), gte(turnContexts.createdAt, cutoff)))
        .get();
      if ((live?.n ?? 0) > 0) continue;
      removed += tx.delete(turnContextBodies).where(eq(turnContextBodies.hash, hash)).run().changes;
    }
    return removed;
  }
}
