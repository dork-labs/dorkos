/**
 * The work graph's edge store (DOR-4968, W2; ADR 261124-131941): one
 * append-only record of what a chat started, claims, opened, works on or
 * produced, and of the ids a chat has had.
 *
 * What it holds, and what it never does:
 *
 * - **Append-only.** It inserts and reads; there is no update or delete, and
 *   the table's triggers refuse both. An exact repeat of an edge is the same
 *   fact and records nothing new.
 * - **Ids and refs only.** Both ends are entity references
 *   (`@dorkos/shared/entity-ref`), stored by `./work-link-ref`, and an edge
 *   carries no free text. A worktree is its folder name, never a path. A
 *   branch name is stored as given, so write sites must not pass private names.
 * - **One re-key per id.** A chat's id is re-keyed once (ADR-0267), so the
 *   first `rekeyed_from` edge out of an old id is the true one, and a second
 *   one to a different new id is refused.
 * - **Not the audit trail and not the lock.** The audit trail records actions;
 *   this records their results. `work_claims` stays the exclusivity lock.
 *
 * It lives in this computer's SQLite store for now. Its move to the space store
 * is DOR-5139 (ADR 261122-173853). The store is space data; turn code reaches
 * it only through hooks or events, so DOR-5139 is a store move, not a rewrite
 * (the `work-graph/stay-out` lint rule holds runtime and session code to it).
 *
 * @module services/work-graph/work-link-store
 */
import {
  and,
  asc,
  eq,
  inArray,
  WORK_LINK_RELATIONS,
  WORK_LINK_SOURCE_MAX_LENGTH,
  workLinks,
  type Db,
  type SQL,
  type WorkLinkRelation,
  type WorkLinkRow,
} from '@dorkos/db';
import { isDorkId } from '@dorkos/shared/dork-ref';
import type { EntityKind, EntityRef } from '@dorkos/shared/entity-ref';
import { monotonicFactory } from 'ulidx';
import { decodeWorkLinkRef, encodeWorkLinkRef } from './work-link-ref.js';

export { WORK_LINK_RELATIONS, type WorkLinkRelation } from '@dorkos/db';

/** How many `rekeyed_from` steps {@link WorkLinkStore.resolveRekey} follows at most. */
export const REKEY_MAX_DEPTH = 32;

/** Most refs one batched read asks SQLite for at once, well under its variable limit. */
const BATCH = 500;

/** What a `source` may be spelled with: a short lower-case word, `-` allowed. */
const SOURCE_PATTERN = new RegExp(`^[a-z][a-z0-9-]{0,${WORK_LINK_SOURCE_MAX_LENGTH - 1}}$`);

/**
 * The kinds each end must have, for the relations that fix them. Both
 * relations from the address design (ADR 261122-124821) join a chat to a chat,
 * and so does a start (DOR-5263); the rest are left open until their write
 * sites land.
 */
const RELATION_KINDS: Partial<
  Record<WorkLinkRelation, { from: readonly EntityKind[]; to: readonly EntityKind[] }>
> = {
  forked_from: { from: ['chat'], to: ['chat'] },
  started: { from: ['chat'], to: ['chat'] },
  rekeyed_from: { from: ['chat'], to: ['chat'] },
};

/** One edge to record. */
export interface WorkLinkInput {
  /** The subject: the chat (or thing) the fact is about. */
  from: EntityRef;
  /** What `from` did or is to `to`. */
  relation: WorkLinkRelation;
  /** The object. */
  to: EntityRef;
  /** What wrote it, as one short word (`server`, `open-pr`, `flow`, ...). */
  source: string;
  /** The chat whose action recorded it, when a chat's action did. */
  recordingChatId?: string | null;
}

/** One recorded edge. */
export interface WorkLink {
  /** The edge's ULID. */
  id: string;
  /** The subject (`kind` and `id` only). */
  from: EntityRef;
  /** The relation. */
  relation: WorkLinkRelation;
  /** The object (`kind` and `id` only). */
  to: EntityRef;
  /** When it was first recorded (ISO 8601). */
  recordedAt: string;
  /** The chat whose action recorded it, or `null`. */
  recordingChatId: string | null;
  /** What wrote it. */
  source: string;
}

/** Why an edge was not recorded. Stable codes, for tests and logs. */
export type WorkLinkRefusal =
  | 'bad-from'
  | 'bad-to'
  | 'bad-relation'
  | 'bad-kinds'
  | 'self-link'
  | 'bad-source'
  | 'bad-recording-chat'
  | 'already-rekeyed';

/** What {@link WorkLinkStore.record} came to. */
export type WorkLinkRecordResult =
  | {
      ok: true;
      /** The stored edge: the new one, or the earlier one an exact repeat matched. */
      link: WorkLink;
      /** `false` when the edge was already recorded and nothing new landed. */
      created: boolean;
    }
  | { ok: false; reason: WorkLinkRefusal };

/** What the store needs. */
export interface WorkLinkStoreDeps {
  /** The DorkOS database. */
  db: Db;
  /** The clock, in epoch milliseconds. Tests pin it. */
  now?: () => number;
}

function isRelation(value: string): value is WorkLinkRelation {
  return (WORK_LINK_RELATIONS as readonly string[]).includes(value);
}

function toLink(row: WorkLinkRow): WorkLink | null {
  const from = decodeWorkLinkRef(row.fromRef);
  const to = decodeWorkLinkRef(row.toRef);
  if (from === null || to === null || !isRelation(row.relation)) return null;
  return {
    id: row.id,
    from,
    relation: row.relation,
    to,
    recordedAt: row.recordedAt,
    recordingChatId: row.recordingChatId,
    source: row.source,
  };
}

function toLinks(rows: WorkLinkRow[]): WorkLink[] {
  return rows.map(toLink).filter((link): link is WorkLink => link !== null);
}

/** Records and reads the work graph's edges. */
export class WorkLinkStore {
  private readonly db: Db;
  private readonly now: () => number;
  /** Monotonic, so edges recorded in one millisecond still list in the order they landed. */
  private readonly newId = monotonicFactory();

  /**
   * Build the store over the database.
   *
   * @param deps - The database and, in tests, a clock.
   */
  constructor(deps: WorkLinkStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Record one edge. Both ends are checked against their kinds' grammars and
   * stored in their canonical spelling. An exact repeat (same `from`,
   * `relation` and `to`) records nothing and hands back the earlier edge, so a
   * write site may call this as often as its action repeats. A `rekeyed_from`
   * edge out of an old id that already has one, to a different new id, is
   * refused as `already-rekeyed`: the first re-key is the true one.
   *
   * @param input - The edge.
   * @returns The stored edge, or why it was refused. Throws only when the
   *   database itself fails.
   */
  record(input: WorkLinkInput): WorkLinkRecordResult {
    const fromRef = encodeWorkLinkRef(input.from);
    if (fromRef === null) return { ok: false, reason: 'bad-from' };
    const toRef = encodeWorkLinkRef(input.to);
    if (toRef === null) return { ok: false, reason: 'bad-to' };
    if (!isRelation(input.relation)) return { ok: false, reason: 'bad-relation' };
    const kinds = RELATION_KINDS[input.relation];
    if (kinds && !(kinds.from.includes(input.from.kind) && kinds.to.includes(input.to.kind)))
      return { ok: false, reason: 'bad-kinds' };
    if (fromRef === toRef) return { ok: false, reason: 'self-link' };
    if (!SOURCE_PATTERN.test(input.source)) return { ok: false, reason: 'bad-source' };
    const recordingChatId = input.recordingChatId ?? null;
    if (recordingChatId !== null && !isDorkId(recordingChatId))
      return { ok: false, reason: 'bad-recording-chat' };
    if (input.relation === 'rekeyed_from') {
      const first = this.firstRekeyFrom(toRef);
      if (first !== undefined && first !== fromRef) return { ok: false, reason: 'already-rekeyed' };
    }

    const inserted = this.db
      .insert(workLinks)
      .values({
        id: this.newId(this.now()),
        fromRef,
        toRef,
        relation: input.relation,
        recordedAt: new Date(this.now()).toISOString(),
        recordingChatId,
        source: input.source,
      })
      .onConflictDoNothing({ target: [workLinks.fromRef, workLinks.relation, workLinks.toRef] })
      .returning()
      .all();
    const row =
      inserted[0] ??
      this.db
        .select()
        .from(workLinks)
        .where(
          and(
            eq(workLinks.fromRef, fromRef),
            eq(workLinks.relation, input.relation),
            eq(workLinks.toRef, toRef)
          )
        )
        .get();
    const link = row ? toLink(row) : null;
    // The row was just written or matched from this call's own checked values.
    if (link === null) throw new Error('A recorded work link could not be read back');
    return { ok: true, link, created: inserted.length > 0 };
  }

  /**
   * Every edge whose subject is `ref`, oldest first.
   *
   * @param ref - The subject.
   * @param relation - Only edges of this relation, when given.
   * @returns The edges; none for a reference that is not valid.
   */
  from(ref: EntityRef, relation?: WorkLinkRelation): WorkLink[] {
    const stored = encodeWorkLinkRef(ref);
    if (stored === null) return [];
    const match = eq(workLinks.fromRef, stored);
    return this.list(relation === undefined ? match : and(match, eq(workLinks.relation, relation)));
  }

  /**
   * Every edge whose object is `ref`, oldest first.
   *
   * @param ref - The object.
   * @param relation - Only edges of this relation, when given.
   * @returns The edges; none for a reference that is not valid.
   */
  to(ref: EntityRef, relation?: WorkLinkRelation): WorkLink[] {
    const stored = encodeWorkLinkRef(ref);
    if (stored === null) return [];
    const match = eq(workLinks.toRef, stored);
    return this.list(relation === undefined ? match : and(match, eq(workLinks.relation, relation)));
  }

  /**
   * Every edge whose subject is one of `refs`, oldest first: {@link from} for
   * many subjects in one read per {@link BATCH} refs.
   *
   * @param refs - The subjects; invalid ones are skipped.
   * @param relation - Only edges of this relation.
   */
  fromMany(refs: readonly EntityRef[], relation: WorkLinkRelation): WorkLink[] {
    return this.listMany(refs, relation, 'from');
  }

  /**
   * Every edge whose object is one of `refs`, oldest first: {@link to} for
   * many objects in one read per {@link BATCH} refs.
   *
   * @param refs - The objects; invalid ones are skipped.
   * @param relation - Only edges of this relation.
   */
  toMany(refs: readonly EntityRef[], relation: WorkLinkRelation): WorkLink[] {
    return this.listMany(refs, relation, 'to');
  }

  /**
   * {@link resolveRekey} for many chats, one read per step for all of them.
   *
   * @param chatIds - Chat ids, current or retired.
   * @returns Each id's current id; an id never re-keyed maps to itself.
   */
  resolveRekeys(chatIds: readonly string[]): Map<string, string> {
    const resolved = new Map(chatIds.map((id) => [id, id]));
    const seen = new Map(chatIds.map((id) => [id, new Set([id])]));
    let open = chatIds.filter((id) => isDorkId(id));
    for (let step = 0; step < REKEY_MAX_DEPTH && open.length > 0; step += 1) {
      const currents = [...new Set(open.map((id) => resolved.get(id)!))];
      // The oldest edge out of each id is its true re-key (see {@link record}).
      const next = new Map<string, string>();
      for (const link of this.toMany(
        currents.map((id) => ({ kind: 'chat' as const, id })),
        'rekeyed_from'
      )) {
        if (link.from.kind === 'chat' && link.to.kind === 'chat' && !next.has(link.to.id))
          next.set(link.to.id, link.from.id);
      }
      open = open.filter((id) => {
        const to = next.get(resolved.get(id)!);
        if (to === undefined || seen.get(id)!.has(to)) return false;
        seen.get(id)!.add(to);
        resolved.set(id, to);
        return true;
      });
    }
    return resolved;
  }

  /**
   * The id a chat is known by now, following `rekeyed_from` edges from an
   * older id to the newest one (ADR-0267: a new chat's first id gives way to
   * its runtime's). The edges outlive a restart, so an old id can be resolved
   * after one, which the in-memory redirect cannot do. Its reader is
   * `followChatRekey`, through the resolver `installWorkLinkStore` registers,
   * so a `/r/` link (DOR-5046) holding an old id still opens the chat.
   *
   * Bounded and cycle-safe: it follows at most {@link REKEY_MAX_DEPTH} steps
   * and stops at the last id before any id would repeat. Each step takes the
   * oldest edge out of an id: {@link record} refuses a second one, and a row
   * written before it did is not the chat's true re-key.
   *
   * @param chatId - A chat id, current or retired.
   * @returns The current id; `chatId` itself when it was never re-keyed or is
   *   not a chat id.
   */
  resolveRekey(chatId: string): string {
    if (!isDorkId(chatId)) return chatId;
    const seen = new Set([chatId]);
    let current = chatId;
    for (let step = 0; step < REKEY_MAX_DEPTH; step += 1) {
      const toRef = encodeWorkLinkRef({ kind: 'chat', id: current });
      if (toRef === null) return current;
      const fromRef = this.firstRekeyFrom(toRef);
      const next = fromRef === undefined ? null : decodeWorkLinkRef(fromRef);
      if (next === null || next.kind !== 'chat' || seen.has(next.id)) return current;
      seen.add(next.id);
      current = next.id;
    }
    return current;
  }

  /** The new id's stored reference on the oldest `rekeyed_from` edge out of `toRef`. */
  private firstRekeyFrom(toRef: string): string | undefined {
    return this.db
      .select({ fromRef: workLinks.fromRef })
      .from(workLinks)
      .where(and(eq(workLinks.toRef, toRef), eq(workLinks.relation, 'rekeyed_from')))
      .orderBy(asc(workLinks.recordedAt), asc(workLinks.id))
      .get()?.fromRef;
  }

  private listMany(
    refs: readonly EntityRef[],
    relation: WorkLinkRelation,
    end: 'from' | 'to'
  ): WorkLink[] {
    const stored = [
      ...new Set(refs.map(encodeWorkLinkRef).filter((ref): ref is string => ref !== null)),
    ];
    const column = end === 'from' ? workLinks.fromRef : workLinks.toRef;
    const found: WorkLink[] = [];
    for (let i = 0; i < stored.length; i += BATCH) {
      found.push(
        ...this.list(
          and(inArray(column, stored.slice(i, i + BATCH)), eq(workLinks.relation, relation))
        )
      );
    }
    // Batches each come oldest first; merge them on the same order.
    return found.sort((a, b) =>
      a.recordedAt === b.recordedAt ? (a.id < b.id ? -1 : 1) : a.recordedAt < b.recordedAt ? -1 : 1
    );
  }

  private list(where: SQL | undefined): WorkLink[] {
    return toLinks(
      this.db
        .select()
        .from(workLinks)
        .where(where)
        .orderBy(asc(workLinks.recordedAt), asc(workLinks.id))
        .all()
    );
  }
}
