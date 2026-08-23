/**
 * The server-side hold for staged context that cannot reach a runtime's own
 * record right now (spec `persistent-session-runtime` §2.5, task 4.2).
 *
 * ## Why a hold exists at all
 *
 * `stage` means "attach this for the agent, without provoking a turn". A runtime
 * that can do that natively appends to its own transcript, and the text merges
 * into the next querying message. When it cannot, the text has nowhere to live
 * until a turn runs — so rather than refuse the person's staging, the server
 * HOLDS it here and folds it into the NEXT dispatched message as a
 * `staged_context` {@link AdditionalContextEntry} — the neutral bag, rendered
 * out of band, so the person's own `content` for that next turn stays pristine
 * (ADR-0273). The `queue_note` mechanism is the precedent: a small per-turn note
 * the person's action produced, carried in the bag rather than concatenated.
 *
 * **Two different absences route here, and the second is the common one.** The
 * runtime may have no such seam at all — codex and opencode declare
 * `supportsContextStaging: false` — or it may have one that this SESSION is not
 * holding open. Claude-code is the second case and it is the default: its native
 * stage appends to a process held between turns, and
 * `runtimes.claudeCode.persistentSession` ships OFF, so `canStageSession`
 * answers `false` and the words fold (`degradedBecause: 'not-stageable'`,
 * DOR-1307). This store is therefore not a minority path serving two adapters —
 * on a default install it is where every Add context goes.
 *
 * ## Why it is DURABLE (DOR-1324)
 *
 * A hold is not a queued message — it opens no turn and no window lists it — but
 * it carries the same promise, and the promise is written down where the person
 * can see it: {@link emitContextStaged} puts an "Added context for the next
 * reply" receipt on the DURABLE session stream the instant the words are held.
 * While the hold lived in process memory, a restart between the stage and the
 * dispatch it would ride kept the receipt and lost the words — a permanent
 * record of context the agent would never get, and precisely the silent
 * downgrade ADR `260816-143752` forbids. So the hold rides SQLite beside the
 * message queue, which is keyed the same way and rehydrates on boot for the same
 * reason (DOR-1132/DOR-1205 lineage).
 *
 * **The take is destructive, and that leaves ONE window this fix does not
 * close.** {@link StagedContextStore.take} reads and deletes in one transaction,
 * so a note can never ride a second turn. But the take fires in `trigger-turn`
 * while the context bag is being assembled — BEFORE `settleOpenTurnBefore` and
 * `sendMessage` — and the durable queue is not symmetric with it: a queued
 * message's row is deleted at `turn_start` (`onTurnStart`), one step later. So a
 * throw between the take and the turn actually starting re-parks the message
 * (`returnToQueue`) and retries it WITHOUT its staged words, under a receipt
 * that still stands. That is an in-process path, not the crash ADR-0264 covers,
 * and it predates this store — the in-memory take was destructive in exactly the
 * same place. It is named here rather than fixed here because closing it means
 * moving the take to `turn_start` or restoring the hold on `returnToQueue`,
 * which is turn-path surgery and belongs to its own change. The alternative
 * trade — a non-destructive take — is worse in the ordinary case: it repeats
 * somebody's words into a later turn they already watched the agent answer.
 *
 * The other surviving residual is the write-refusal fallback below: when SQLite
 * refuses the insert, the words are kept in this process's memory so they are
 * not dropped under a receipt that has gone out, which means that one hold is
 * only as durable as the process. It is logged at `error` when it happens, so it
 * is a reported downgrade rather than a silent one.
 *
 * Keyed through {@link queueKeyOf}, exactly as the message queue's rows are, and
 * NOT through `primaryOf`. The difference is the whole reason
 * `session-key-registry.ts` exists: in-memory dispatcher state stays filed under
 * the id a session was born with (`primaryOf`), while durable ROWS move onto the
 * canonical id, carried there by {@link StagedContextStore.rekeySession} on the
 * same beat the queue's are. Reading rows back through the filing id finds
 * nothing — which, under a receipt that has already gone out, is exactly the
 * DOR-1324 loss wearing a different hat.
 *
 * @module services/session/staged-context-store
 */
import { sessionStagedContext, eq, inArray, max, type Db } from '@dorkos/db';
import type { StagedContextData } from '@dorkos/shared/additional-context';
import type { SessionStagedContextRow } from '@dorkos/db';
import { queueKeyOf } from './session-key-registry.js';
import { logger } from '../../lib/logger.js';

/** A held note as the fold appends it to a dispatch's neutral context bag. */
export type StagedContextEntry = {
  kind: 'staged_context';
  scope: 'per-turn';
  data: StagedContextData;
};

/**
 * How many session ids one `DELETE ... IN (...)` may carry — the same ceiling
 * {@link MessageQueueStore} chunks at, and for the same reason: every id spends
 * one of SQLite's compiled-in bound variables, and a list past the ceiling would
 * lose the whole delete rather than part of it.
 */
const DELETE_CHUNK_SIZE = 500;

/**
 * The process-wide store, injected once from each composition root after
 * `createDb()`.
 */
let sharedStore: StagedContextStore | undefined;

/**
 * Notes held with no database behind them.
 *
 * Unreachable in every shipped host — `apps/server/src/index.ts` and
 * `harness-boot.ts` both inject a store before anything can stage — and kept for
 * the one case that is left: an embedder that wires no database at all. Such a
 * host has no durable anything, so folding in memory is the best available
 * answer and is exactly the guarantee this module made before DOR-1324. Losing
 * the words instead is not an option: the receipt has already gone out.
 */
const heldInMemory = new Map<string, StagedContextEntry[]>();

/**
 * Inject the durable staged-context hold. Passing `undefined` clears it, which
 * both composition roots never do and test isolation always does.
 *
 * @param store - The shared store, or `undefined` to fall back to memory
 */
export function setStagedContextStore(store: StagedContextStore | undefined): void {
  sharedStore = store;
}

/** The injected durable hold, or `undefined` when no database is wired. */
export function getStagedContextStore(): StagedContextStore | undefined {
  return sharedStore;
}

/** Present a stored row as the entry a dispatch carries. */
function toEntry(row: SessionStagedContextRow): StagedContextEntry {
  return { kind: 'staged_context', scope: 'per-turn', data: { text: row.content } };
}

/**
 * Durable per-session hold for staged notes. Synchronous (`better-sqlite3`) like
 * {@link MessageQueueStore} beside it, so it composes into the dispatcher's
 * mutex and the turn path without an await on the hot path.
 */
export class StagedContextStore {
  constructor(private readonly db: Db) {}

  /**
   * Hold a note for a session's next dispatch, behind anything already held.
   *
   * Position and insert go in one transaction so two concurrent holds cannot
   * read the same tail and collide on it.
   *
   * @param sessionId - The row key, already resolved through {@link queueKeyOf}
   * @param text - The person's staged text, pristine
   * @param messageId - The server-minted correlation id for the staged message
   */
  hold(sessionId: string, text: string, messageId: string): void {
    this.db.transaction((tx) => {
      const tail =
        tx
          .select({ value: max(sessionStagedContext.position) })
          .from(sessionStagedContext)
          .where(eq(sessionStagedContext.sessionId, sessionId))
          .get()?.value ?? 0;
      tx.insert(sessionStagedContext)
        .values({ id: messageId, sessionId, position: tail + 1, content: text })
        .run();
    });
  }

  /**
   * Take (and delete) a session's held notes, in the order they were staged.
   *
   * Read and delete are ONE transaction: a note folds into exactly one dispatch,
   * and a second reader arriving mid-take must find either all of them or none
   * rather than a half-emptied hold.
   *
   * @param sessionId - The row key, already resolved through {@link queueKeyOf}
   */
  take(sessionId: string): StagedContextEntry[] {
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(sessionStagedContext)
        .where(eq(sessionStagedContext.sessionId, sessionId))
        .orderBy(sessionStagedContext.position)
        .all();
      if (rows.length === 0) return [];
      tx.delete(sessionStagedContext).where(eq(sessionStagedContext.sessionId, sessionId)).run();
      return rows.map(toEntry);
    });
  }

  /**
   * Carry a session's held notes onto a new id, alongside the rebind that moves
   * its `session_metadata` row and its queue.
   *
   * A brand-new session is written under the request UUID and gains its
   * canonical SDK id mid-first-turn; rows left at the old key are invisible to
   * every dispatch that follows, so the words the receipt promised would never
   * arrive. A destination that already holds notes keeps them, with the moved
   * ones appended behind. Idempotent — matching ids and an empty source are both
   * no-ops.
   *
   * @param fromId - The id the rows are stored under today
   * @param toId - The canonical id the session is now known by
   */
  rekeySession(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction((tx) => {
      const moving = tx
        .select()
        .from(sessionStagedContext)
        .where(eq(sessionStagedContext.sessionId, fromId))
        .orderBy(sessionStagedContext.position)
        .all();
      if (moving.length === 0) return;
      const destinationTail =
        tx
          .select({ value: max(sessionStagedContext.position) })
          .from(sessionStagedContext)
          .where(eq(sessionStagedContext.sessionId, toId))
          .get()?.value ?? 0;
      moving.forEach((row, index) => {
        tx.update(sessionStagedContext)
          .set({ sessionId: toId, position: destinationTail + index + 1 })
          .where(eq(sessionStagedContext.id, row.id))
          .run();
      });
    });
  }

  /**
   * Delete every held note belonging to any of the named sessions, and report
   * how many rows went — the storage half of session teardown, so an abandoned
   * session cannot hold words for the life of the install.
   *
   * @param sessionIds - The sessions to clear out; an empty list does nothing
   */
  deleteForSessions(sessionIds: string[]): number {
    let removed = 0;
    for (let i = 0; i < sessionIds.length; i += DELETE_CHUNK_SIZE) {
      const chunk = sessionIds.slice(i, i + DELETE_CHUNK_SIZE);
      removed += this.db
        .delete(sessionStagedContext)
        .where(inArray(sessionStagedContext.sessionId, chunk))
        .run().changes;
    }
    return removed;
  }
}

/**
 * Hold a staged note for a session's next dispatch. Appends, so two notes staged
 * before one dispatch both ride it, in the order they were staged.
 *
 * A hold that cannot be written is reported, never swallowed: the caller has
 * already promised the person their words landed, so the failure has to reach
 * the log rather than disappear behind the receipt.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 * @param text - The person's staged text, pristine
 * @param messageId - The server-minted correlation id for the staged message
 */
export function holdStagedContext(sessionId: string, text: string, messageId: string): void {
  const key = queueKeyOf(sessionId);
  if (sharedStore !== undefined) {
    try {
      sharedStore.hold(key, text, messageId);
      return;
    } catch (err) {
      // The database refused the write. Hold in memory anyway — the receipt has
      // already gone out, so dropping the words here is the one outcome that
      // must not happen — and say so, loudly, because this hold is now only as
      // durable as the process.
      logger.error('[StagedContextStore] could not hold staged context durably', {
        sessionId: key,
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const list = heldInMemory.get(key) ?? [];
  list.push({ kind: 'staged_context', scope: 'per-turn', data: { text } });
  heldInMemory.set(key, list);
}

/**
 * Take (and clear) a session's held staged notes as `staged_context` entries, in
 * the order they were staged. Empty when nothing is held — the ordinary case, so
 * the fold at every dispatch pays only one indexed read.
 *
 * Taking rather than peeking, because a note folds into exactly ONE dispatch:
 * leaving it held would re-attach it to every later turn as well.
 *
 * @param sessionId - Either id a caller might hold
 * @returns The staged entries to append to the next dispatch's context bag
 */
export function takeStagedContext(sessionId: string): StagedContextEntry[] {
  const key = queueKeyOf(sessionId);
  let durable: StagedContextEntry[] = [];
  if (sharedStore !== undefined) {
    try {
      durable = sharedStore.take(key);
    } catch (err) {
      // A read that fails costs this dispatch its staged notes, never the turn:
      // the person's own words for this turn are in `content` either way.
      logger.error('[StagedContextStore] could not read staged context', {
        sessionId: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Both holds are drained on every take. In production the memory half is
  // always empty — it fills only for a host with no database, or after a write
  // the database refused — so its notes go BEHIND the durable ones rather than
  // being interleaved on a shared order that does not exist.
  const inMemory = heldInMemory.get(key);
  if (inMemory === undefined) return durable;
  heldInMemory.delete(key);
  return [...durable, ...inMemory];
}

/**
 * Drop every note held in memory.
 *
 * @internal Exported for testing only — the in-memory fallback outlives one test
 *   file. Durable holds are dropped by disposing the store's database.
 */
export function resetStagedContextStore(): void {
  heldInMemory.clear();
}
