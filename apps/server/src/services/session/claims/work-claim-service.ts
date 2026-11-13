/**
 * Work claims (DOR-4019): one agent's chats saying "I have this", so two of its
 * sessions never take the same job. Sessions share memory files, not context;
 * without this a second chat of the same agent starts a ticket another one is
 * already building.
 *
 * What a claim is, and is not:
 * - Scoped to one agent. Its own chats see and take its claims; nothing here
 *   lets one agent read, take or release another's.
 * - Advisory. It refuses a second claim on a held key and `session_start` asks
 *   before starting a chat on one, but no permission, merge or person-facing
 *   decision reads it. A claim never blocks a person.
 * - Exclusive by the table's primary key: two chats racing for one key both
 *   insert, and exactly one row lands.
 * - Bounded in time. It ends on release, when the chat that holds it never
 *   started, or once that chat has not been seen working for
 *   {@link CLAIM_IDLE_LIMIT_MS}, so a dead chat cannot hold work forever.
 *
 * Every claim, refusal, release and lapse is an audit row.
 *
 * @module services/session/claims/work-claim-service
 */
import { and, eq, workClaims, type Db, type WorkClaimRow } from '@dorkos/db';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { recordAudit } from '../../audit/audit-trail.js';

/** How long a claim outlives its chat's last sign of work. */
export const CLAIM_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;

/** The longest key a claim takes, after it is normalised. */
export const CLAIM_KEY_MAX_LENGTH = 120;

/** The longest note a claim keeps. */
export const CLAIM_NOTE_MAX_LENGTH = 200;

/** A live claim, as the claim tools report it. */
export interface WorkClaim {
  /** The normalised key, e.g. `DOR-1234`. */
  key: string;
  /** The chat that holds it. */
  sessionId: string;
  /** What the holder said it is doing. Untrusted text. */
  note: string | null;
  /** When it was claimed (ISO 8601). */
  claimedAt: string;
  /** When the holder was last seen working (ISO 8601). */
  lastSeenAt: string;
}

/** What a claim attempt came to. */
export type WorkClaimResult =
  | { ok: true; claim: WorkClaim; renewed: boolean }
  | { ok: false; code: 'CLAIMED'; holder: WorkClaim };

/** What a release came to. */
export type WorkClaimReleaseResult =
  { ok: true } | { ok: false; code: 'NOT_CLAIMED' | 'NOT_YOURS'; holder?: WorkClaim };

/**
 * One way to write a key, so `dor-1234 ` and `DOR-1234` are the same claim.
 *
 * @param raw - The key as an agent wrote it.
 * @returns The key trimmed, with inner whitespace collapsed and upper-cased, or
 *   `null` when nothing is left or it is too long.
 */
export function normaliseClaimKey(raw: string): string | null {
  // Untrusted text the agent's other chats will read: no controls, invisibles or tags.
  const key = sanitizeIdentity(raw, CLAIM_KEY_MAX_LENGTH + 1)?.toUpperCase();
  return !key || key.length > CLAIM_KEY_MAX_LENGTH ? null : key;
}

function toClaim(row: WorkClaimRow): WorkClaim {
  return {
    key: row.claimKey,
    sessionId: row.sessionId,
    note: row.note,
    claimedAt: row.claimedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function cleanNote(note: string | undefined): string | null {
  return (note && sanitizeIdentity(note, CLAIM_NOTE_MAX_LENGTH)) ?? null;
}

/** What the service needs. */
export interface WorkClaimServiceDeps {
  /** The DorkOS database. */
  db: Db;
  /** The clock, in epoch milliseconds. Tests pin it. */
  now?: () => number;
}

/** Claims, checks and releases work for one agent's chats. */
export class WorkClaimService {
  private readonly db: Db;
  private readonly now: () => number;

  /**
   * Build the service over the database.
   *
   * @param deps - The database and, in tests, a clock.
   */
  constructor(deps: WorkClaimServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Claim a key for a chat. A chat that already holds it renews it.
   *
   * @param agentId - The agent whose chats share the claim, from the verified turn.
   * @param sessionId - The chat claiming, from the verified turn.
   * @param key - A normalised key ({@link normaliseClaimKey}).
   * @param note - What the chat is doing, shown to the agent's other chats.
   */
  claim(agentId: string, sessionId: string, key: string, note?: string): WorkClaimResult {
    const at = new Date(this.now()).toISOString();
    let lapsed = false;
    const result = this.db.transaction((tx) => {
      lapsed = this.lapseIfIdle(tx, agentId, key);
      const inserted = tx
        .insert(workClaims)
        .values({
          agentId,
          claimKey: key,
          sessionId,
          note: cleanNote(note),
          claimedAt: at,
          lastSeenAt: at,
        })
        .onConflictDoNothing()
        .run();
      const row = this.row(tx, agentId, key)!;
      if (inserted.changes > 0) return { ok: true as const, claim: toClaim(row), renewed: false };
      if (row.sessionId !== sessionId)
        return { ok: false as const, code: 'CLAIMED' as const, holder: toClaim(row) };
      tx.update(workClaims)
        .set({ lastSeenAt: at, ...(note === undefined ? {} : { note: cleanNote(note) }) })
        .where(and(eq(workClaims.agentId, agentId), eq(workClaims.claimKey, key)))
        .run();
      return { ok: true as const, claim: toClaim(this.row(tx, agentId, key)!), renewed: true };
    });
    // Audited after the transaction, so the audit write never runs inside it.
    if (lapsed) this.auditLapse(agentId, key);
    if (result.ok && !result.renewed) this.audit('work_claim.claimed', agentId, key, 'ok');
    // Never the holder's id: audit rows are widely readable, and the holder may
    // be a person's private chat with this agent.
    if (!result.ok)
      this.audit('work_claim.claimed', agentId, key, 'refused', 'another chat holds it');
    return result;
  }

  /**
   * The agent's live claims, lapsing any that went idle first.
   *
   * @param agentId - The agent whose claims to read.
   * @param keys - Only these normalised keys; absent means all of them.
   */
  check(agentId: string, keys?: readonly string[]): WorkClaim[] {
    const rows = this.db.select().from(workClaims).where(eq(workClaims.agentId, agentId)).all();
    const live: WorkClaim[] = [];
    for (const row of rows) {
      if (keys && !keys.includes(row.claimKey)) continue;
      if (this.isIdle(row)) {
        if (this.lapseIfIdle(this.db, agentId, row.claimKey))
          this.auditLapse(agentId, row.claimKey);
        continue;
      }
      live.push(toClaim(row));
    }
    return live.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt));
  }

  /**
   * Release a key the chat holds. Only the holder can.
   *
   * @param agentId - The agent, from the verified turn.
   * @param sessionId - The chat releasing, from the verified turn.
   * @param key - A normalised key.
   */
  release(agentId: string, sessionId: string, key: string): WorkClaimReleaseResult {
    const row = this.row(this.db, agentId, key);
    if (!row || this.isIdle(row)) {
      if (row && this.lapseIfIdle(this.db, agentId, key)) this.auditLapse(agentId, key);
      return { ok: false, code: 'NOT_CLAIMED' };
    }
    if (row.sessionId !== sessionId) return { ok: false, code: 'NOT_YOURS', holder: toClaim(row) };
    this.delete(agentId, key);
    this.audit('work_claim.released', agentId, key, 'ok');
    return { ok: true };
  }

  /**
   * Note that a chat is still working, keeping its claims from lapsing.
   *
   * @param sessionId - The chat seen working.
   */
  touch(sessionId: string): void {
    this.db
      .update(workClaims)
      .set({ lastSeenAt: new Date(this.now()).toISOString() })
      .where(eq(workClaims.sessionId, sessionId))
      .run();
  }

  /**
   * End every claim a chat holds, e.g. because it never started.
   *
   * @param sessionId - The chat.
   * @param reason - Why, for the audit row.
   */
  releaseSession(sessionId: string, reason: string): void {
    const rows = this.db.select().from(workClaims).where(eq(workClaims.sessionId, sessionId)).all();
    for (const row of rows) {
      this.delete(row.agentId, row.claimKey);
      this.audit('work_claim.released', row.agentId, row.claimKey, 'ok', reason);
    }
  }

  /**
   * Move a chat's claims to the id it settled on.
   *
   * @param from - The id the claims were taken under.
   * @param to - The chat's lasting id.
   */
  rekey(from: string, to: string): void {
    if (from === to) return;
    this.db.update(workClaims).set({ sessionId: to }).where(eq(workClaims.sessionId, from)).run();
  }

  /**
   * Hand one claim from the chat that holds it to another chat of the same
   * agent, e.g. to the lane it just started for that work.
   *
   * @param agentId - The agent, from the verified turn.
   * @param key - A normalised key.
   * @param from - The chat that must hold it now.
   * @param to - The chat that takes it.
   * @returns Whether `from` held it and it moved.
   */
  handOver(agentId: string, key: string, from: string, to: string): boolean {
    const at = new Date(this.now()).toISOString();
    const moved = this.db
      .update(workClaims)
      .set({ sessionId: to, lastSeenAt: at })
      .where(
        and(
          eq(workClaims.agentId, agentId),
          eq(workClaims.claimKey, key),
          eq(workClaims.sessionId, from)
        )
      )
      .run();
    if (moved.changes > 0) this.audit('work_claim.claimed', agentId, key, 'ok', 'handed over');
    return moved.changes > 0;
  }

  private isIdle(row: WorkClaimRow): boolean {
    return this.now() - Date.parse(row.lastSeenAt) > CLAIM_IDLE_LIMIT_MS;
  }

  private row(db: Pick<Db, 'select'>, agentId: string, key: string): WorkClaimRow | undefined {
    return db
      .select()
      .from(workClaims)
      .where(and(eq(workClaims.agentId, agentId), eq(workClaims.claimKey, key)))
      .get();
  }

  /** Delete the claim when its chat went idle. Returns whether it did; the caller audits. */
  private lapseIfIdle(db: Pick<Db, 'select' | 'delete'>, agentId: string, key: string): boolean {
    const row = this.row(db, agentId, key);
    if (!row || !this.isIdle(row)) return false;
    db.delete(workClaims)
      .where(and(eq(workClaims.agentId, agentId), eq(workClaims.claimKey, key)))
      .run();
    return true;
  }

  private auditLapse(agentId: string, key: string): void {
    this.audit('work_claim.expired', agentId, key, 'ok', 'its chat went idle');
  }

  private delete(agentId: string, key: string): void {
    this.db
      .delete(workClaims)
      .where(and(eq(workClaims.agentId, agentId), eq(workClaims.claimKey, key)))
      .run();
  }

  private audit(
    action: string,
    agentId: string,
    key: string,
    outcome: 'ok' | 'refused',
    reason?: string
  ): void {
    const verb = action.split('.')[1];
    recordAudit({
      action,
      operation: action === 'work_claim.claimed' ? 'create' : 'remove',
      target: { type: 'work_claim', id: key, containerId: agentId },
      outcome,
      ...(reason ? { reason } : {}),
      summary: outcome === 'refused' ? `Claim on ${key} refused` : `Work claim ${verb}: ${key}`,
    });
  }
}
