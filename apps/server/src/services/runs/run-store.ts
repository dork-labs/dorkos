/**
 * The run record's store: the only code that reads or writes `turn_runs`
 * (spec `turns-survive-restarts` §4, DOR-5159).
 *
 * One row per attempt of a turn. The store answers in the port's own types
 * (`@dorkos/shared/turn-port`), never in Drizzle rows (§4.2), and it checks
 * every status change against {@link canTransition}: an illegal pair throws
 * {@link IllegalRunTransitionError} and writes nothing. Every write is one
 * synchronous `better-sqlite3` transaction. Opened on its own it is
 * `immediate`; opened while another transaction is open on the same
 * connection (the queue store's `atomically`, a deferred transaction, or a
 * Drizzle `tx` it was handed) it is a savepoint inside that one, and the
 * outer transaction's mode stands. That nesting is how a queue row and its run
 * change together (§5, item 1).
 *
 * **A chat's id.** Every reader that looks runs up by a chat resolves the id
 * through {@link chatKeyOf}, the very function the queue's own readers use
 * (`queueKeyOf` in `session/resolution/session-key-registry.ts`), so a run is
 * never looked up under an id its queue rows are not kept under (§4.1).
 *
 * Who calls which method, and when, is {@link createRunFactsSink} (the
 * dispatcher's facts) and `run-stops.ts` (stop requests). This file only
 * keeps the record honest.
 *
 * @module services/runs/run-store
 */
import { ulid } from 'ulidx';
import {
  and,
  isNull,
  eq,
  inArray,
  isNotNull,
  lt,
  max,
  ne,
  turnRuns,
  LIVE_TURN_RUN_STATUSES,
  type Db,
  type TurnRunRow,
} from '@dorkos/db';
import {
  canTransition,
  TurnOriginSchema,
  type AttemptReason,
  type RunEnding,
  type RunStatus,
  type TurnOrigin,
  type WaitReason,
} from '@dorkos/shared/turn-port';
import type { InterruptReceipt } from '@dorkos/shared/schemas';
import { chatKeyOf } from '../session/turn-port/index.js';

/** How long a live run's lease lasts after each renewal (§4.1, §7.1). */
export const RUN_LEASE_MS = 60_000;

/** How often the owner renews the leases of its live runs (§4.1). */
export const RUN_LEASE_RENEW_MS = 20_000;

/** One stop asked of a run, written when it is asked (§4.4). */
export interface RunStopRequest {
  /** When it was asked, ISO 8601. */
  at: string;
  /** Who asked, as a `dork:` reference, when the asker is known. */
  by?: string;
  /** Which door asked: the Stop button or a pause. */
  via: 'stop' | 'pause';
  /** What its receipt said, once it came. */
  outcome?: InterruptReceipt['outcome'];
}

/**
 * What `ending_detail` holds (§4.1): never transcript text, only what DorkOS
 * observed about how the run ended or why it never started.
 */
export interface RunEndingDetail {
  /** Every stop asked of the run, in order. */
  stopRequests?: RunStopRequest[];
  /** The runtime's own words when it refused the turn (DOR-2994). */
  refusal?: string;
  /** The run ended before the runtime read its words, so nobody knows if it did. */
  delivery?: 'unknown';
  /** Why a run that never started was cancelled. */
  cancelledBecause?: string;
  /** A private message's attempt whose outcome nobody can know (§4.7). */
  outcomeUnknown?: true;
}

/** A run as the store answers it: the record's fields, in the port's types. */
export interface TurnRun {
  id: string;
  /** The chat, by the id its queue rows are kept under. */
  sessionId: string;
  chatSeq: number;
  chainId: string;
  agentId: string | null;
  /** What started it; `null` for a runtime's own turn or an unrecorded caller. */
  origin: TurnOrigin | null;
  openedBy: 'caller' | 'runtime' | 'recovery';
  status: RunStatus;
  waitReason: WaitReason | null;
  attempt: number;
  attemptReason: AttemptReason;
  queueMessageId: string | null;
  runtime: string | null;
  runtimeTurnRef: number | null;
  turnBindingId: string | null;
  ownerEpoch: string | null;
  leaseUntil: number | null;
  waitingOnPerson: boolean;
  ending: RunEnding | null;
  endingDetail: RunEndingDetail;
  createdAt: string;
  startedAt: string | null;
  deliveredAt: string | null;
  endedAt: string | null;
  /** When recovery decided what follows this run; empty until it has. */
  recoveryDecidedAt: string | null;
}

/** Thrown for a status change the transition table does not hold. */
export class IllegalRunTransitionError extends Error {
  /**
   * Name the run and the pair refused.
   *
   * @param runId - The run.
   * @param from - Its status, or `null` for a run being created.
   * @param to - The status asked for.
   */
  constructor(
    readonly runId: string,
    readonly from: RunStatus | null,
    readonly to: RunStatus
  ) {
    super(`Run ${runId} may not move from ${from ?? '(none)'} to ${to}`);
    this.name = 'IllegalRunTransitionError';
  }
}

/** What {@link RunStore.create} needs. */
export interface NewRun {
  /** The id, when the computer side minted it (a runtime's own turn); else minted here. */
  id?: string;
  chatKey: string;
  /** `queued` (transition 1) or `running` (transition 2, a runtime's own turn). */
  status: 'queued' | 'running';
  openedBy: TurnRun['openedBy'];
  origin: TurnOrigin | null;
  queueMessageId?: string;
  agentId?: string;
  runtime?: string;
  runtimeTurnRef?: number;
}

/** The columns a status change may also set. */
export type RunPatch = Partial<
  Pick<
    TurnRunRow,
    | 'waitReason'
    | 'runtime'
    | 'runtimeTurnRef'
    | 'turnBindingId'
    | 'ownerEpoch'
    | 'leaseUntil'
    | 'waitingOnPerson'
    | 'ending'
    | 'startedAt'
    | 'deliveredAt'
    | 'endedAt'
    | 'settledAt'
    | 'agentId'
  >
> & { endingDetail?: RunEndingDetail };

/**
 * Whether an error is SQLite refusing a unique index, through any wrapper
 * Drizzle adds around it.
 *
 * @param error - What was thrown.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(e.message)) {
      return true;
    }
  }
  return false;
}

/** Read a stored origin, degrading an unreadable one to "not recorded". */
function parseOrigin(json: string | null): TurnOrigin | null {
  if (json === null) return null;
  try {
    const parsed = TurnOriginSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Read a stored `ending_detail`, degrading an unreadable one to empty. */
function parseDetail(json: string | null): RunEndingDetail {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? (parsed as RunEndingDetail) : {};
  } catch {
    return {};
  }
}

/** A stored row as the store answers it. */
function toRun(row: TurnRunRow): TurnRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    chatSeq: row.chatSeq,
    chainId: row.chainId,
    agentId: row.agentId,
    origin: parseOrigin(row.originJson),
    openedBy: row.openedBy,
    status: row.status,
    waitReason: row.waitReason,
    attempt: row.attempt,
    attemptReason: row.attemptReason,
    queueMessageId: row.queueMessageId,
    runtime: row.runtime,
    runtimeTurnRef: row.runtimeTurnRef,
    turnBindingId: row.turnBindingId,
    ownerEpoch: row.ownerEpoch,
    leaseUntil: row.leaseUntil,
    waitingOnPerson: row.waitingOnPerson,
    ending: row.ending,
    endingDetail: parseDetail(row.endingDetail),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    deliveredAt: row.deliveredAt,
    endedAt: row.endedAt,
    recoveryDecidedAt: row.recoveryDecidedAt,
  };
}

/** The column values a {@link RunPatch} writes. */
function patchColumns(patch: RunPatch): Partial<TurnRunRow> {
  const { endingDetail, ...rest } = patch;
  return {
    ...rest,
    ...(endingDetail !== undefined
      ? { endingDetail: Object.keys(endingDetail).length > 0 ? JSON.stringify(endingDetail) : null }
      : {}),
  };
}

/** Options for {@link RunStore}. */
export interface RunStoreOptions {
  /** This process's boot epoch (§6.1): the owner of every run it starts. */
  epoch: string;
  /** The clock, epoch ms. Injected by tests. */
  now?: () => number;
  /**
   * Whether this process still holds the in-memory owner of one of its live
   * runs: a launch under way, an open turn, a runtime's own turn. A live run
   * this boot owns with no such owner is retired like a dead boot's (a write
   * that failed left it live); absent, every run this boot owns counts as held.
   */
  ownerHolds?: (runId: string) => boolean;
}

/** The run record over the machine store's `turn_runs` table. */
export class RunStore {
  private readonly now: () => number;
  /**
   * Rowless `queued` runs whose words this process holds in memory (a
   * refusing caller's trigger, waiting in the dispatcher's pending set). See
   * {@link retireDeadRuns}.
   */
  private readonly heldWords = new Set<string>();
  /** The runs each open store transaction dropped from `heldWords`, innermost last. */
  private readonly dropFrames: string[][] = [];

  /**
   * Open the store over the machine store.
   *
   * @param db - The machine store.
   * @param opts - The boot epoch and, in tests, the clock.
   */
  constructor(
    private readonly db: Db,
    private readonly opts: RunStoreOptions
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Whether this process still holds the owner of one of its own live runs. */
  private holds(runId: string): boolean {
    return this.opts.ownerHolds?.(runId) ?? true;
  }

  /**
   * Note that this process holds a rowless `queued` run's words in memory: the
   * dispatcher put it back in line itself (transition 8). Created runs are
   * noted by {@link create}; any move out of `queued` forgets the run.
   *
   * @param runId - The run.
   */
  holdWords(runId: string): void {
    this.heldWords.add(runId);
  }

  /** This process's boot epoch. */
  get epoch(): string {
    return this.opts.epoch;
  }

  /**
   * Run `fn` as one immediate transaction, or inside the one already open.
   *
   * @param fn - The reads and writes.
   */
  transaction<T>(fn: () => T): T {
    // Runs this frame dropped from `heldWords` go back if it rolls back, so a
    // run whose move out of `queued` never committed is still held. A frame
    // that commits hands them to the frame around it, if any, which may still
    // roll back. Known edge: a store frame that commits inside a caller's own
    // transaction (the queue's `atomically`) that then rolls back keeps the
    // drop; no such caller moves a rowless run out of `queued` today.
    this.dropFrames.push([]);
    try {
      const result = this.db.transaction(() => fn(), { behavior: 'immediate' });
      const dropped = this.dropFrames.pop()!;
      this.dropFrames.at(-1)?.push(...dropped);
      return result;
    } catch (error) {
      for (const id of this.dropFrames.pop()!) this.heldWords.add(id);
      throw error;
    }
  }

  /**
   * One run by id.
   *
   * @param runId - The run.
   */
  get(runId: string): TurnRun | undefined {
    const row = this.db.select().from(turnRuns).where(eq(turnRuns.id, runId)).get();
    return row ? toRun(row) : undefined;
  }

  /**
   * A chat's runs, oldest first.
   *
   * @param chatKey - The chat.
   */
  listForChat(chatKey: string): TurnRun[] {
    return this.rawListForChat(chatKeyOf(chatKey));
  }

  /** A chat's runs under exactly this id, oldest first. */
  private rawListForChat(chatKey: string): TurnRun[] {
    return this.db
      .select()
      .from(turnRuns)
      .where(eq(turnRuns.sessionId, chatKey))
      .orderBy(turnRuns.chatSeq)
      .all()
      .map(toRun);
  }

  /**
   * The chat's live run (`starting`, `started` or `running`), if it has one.
   *
   * Every read of a chat's live run comes through here, and each one retires
   * first whatever a gone boot left live in that chat ({@link retireDeadRuns}),
   * so no reader can ever be held behind a turn nobody runs.
   *
   * @param chatId - The chat, by any id it has had.
   */
  liveRunOf(chatId: string): TurnRun | undefined {
    const chatKey = chatKeyOf(chatId);
    return this.transaction(() => {
      this.retireDeadRuns(chatKey);
      const row = this.db
        .select()
        .from(turnRuns)
        .where(
          and(
            eq(turnRuns.sessionId, chatKey),
            inArray(turnRuns.status, [...LIVE_TURN_RUN_STATUSES])
          )
        )
        .get();
      return row ? toRun(row) : undefined;
    });
  }

  /**
   * Retire what nobody is running any more, in one chat (or every chat). The
   * one place this rule lives; {@link liveRunOf} runs it before every read of
   * a chat's live run, so no reader is ever held behind a turn nobody runs.
   *
   * A live run whose owner is gone: another boot owned it and its lease ran
   * out (§7.1), or this boot owns it and no longer holds its in-memory owner
   * (`RunStoreOptions.ownerHolds`; a write that failed left it live). An
   * owner that is gone is an observation, so only what was observed is
   * written:
   *
   * - `starting`: its launch never reached `turn_start` in a live process, so
   *   the runtime never saw its words. Back to `queued` (transition 8).
   * - `started`: ended (11) with the ending a `turn_end` recorded, else
   *   `process_died`, and `delivery: unknown`. Its `in_turn` queue row is
   *   left as it is: only a settle deletes one, so recovery (T15) can still
   *   hand the words back as a draft.
   * - `running`: ended (12) the same way.
   *
   * A `queued` run with no queue row and no source whose words this process
   * does not hold: an earlier boot made it, its words were in that process's
   * memory, and they are gone. Cancelled (5) as `start_lost`, or it would
   * read as waiting forever. From T5 a run with a pending or leased
   * `start_turn` effect is never cancelled by this rule: its words are at
   * their source, not in memory. A known edge: with the instance lock
   * skipped, two servers sharing one data folder would cancel each other's
   * waiting rowless runs, as each holds only its own.
   *
   * What follows a dead run is recovery's to decide at boot (T15), so
   * `recovery_decided_at` stays empty.
   *
   * @param chatKey - Only this chat's runs (as its queue rows are kept), when given.
   */
  retireDeadRuns(chatKey?: string): void {
    this.transaction(() => {
      for (const run of this.deadLiveRuns(chatKey)) {
        if (run.status === 'starting') {
          this.move(run, 'queued', { ownerEpoch: null, leaseUntil: null });
        } else {
          this.endTurn(run, 'process_died');
        }
      }
      for (const run of this.lostRowlessRuns(chatKey)) {
        this.move(run, 'cancelled', {
          waitReason: null,
          endedAt: this.stamp(),
          endingDetail: { ...run.endingDetail, cancelledBecause: 'start_lost' },
        });
      }
    });
  }

  /** Rowless `queued` runs whose words this process does not hold. */
  private lostRowlessRuns(chatKey?: string): TurnRun[] {
    return this.db
      .select()
      .from(turnRuns)
      .where(
        and(
          eq(turnRuns.status, 'queued'),
          isNull(turnRuns.queueMessageId),
          isNull(turnRuns.sourceRef),
          ...(chatKey !== undefined ? [eq(turnRuns.sessionId, chatKey)] : [])
        )
      )
      .all()
      .map(toRun)
      .filter((run) => !this.heldWords.has(run.id));
  }

  /**
   * End a `started` or `running` run (transitions 11, 12) with the ending it
   * already recorded at `turn_end`, else `fallback`. A run ended from
   * `started` records `delivery: unknown`.
   *
   * @param run - The run, `started` or `running`.
   * @param fallback - The ending when none was recorded.
   * @param detail - What to add to `ending_detail`.
   */
  endTurn(
    run: TurnRun,
    fallback: NonNullable<TurnRun['ending']>,
    detail: RunEndingDetail = {}
  ): void {
    this.move(run, 'ended', {
      ending: run.ending ?? fallback,
      leaseUntil: null,
      endedAt: this.stamp(),
      endingDetail: {
        ...run.endingDetail,
        ...detail,
        ...(run.status === 'started' ? { delivery: 'unknown' } : {}),
      },
    });
  }

  /**
   * The newest run that waits on a queue row, whatever its status.
   *
   * @param queueMessageId - The row.
   */
  findByQueueMessage(queueMessageId: string): TurnRun | undefined {
    const rows = this.db
      .select()
      .from(turnRuns)
      .where(eq(turnRuns.queueMessageId, queueMessageId))
      .orderBy(turnRuns.chatSeq)
      .all();
    const row = rows.at(-1);
    return row ? toRun(row) : undefined;
  }

  /**
   * Create a run: `queued` (transition 1) or a runtime's own `running` turn
   * (transition 2). Its `chat_seq` is allocated in the same transaction.
   *
   * @param input - The run.
   * @returns The run as stored.
   */
  create(input: NewRun): TurnRun {
    if (!canTransition(null, input.status)) {
      throw new IllegalRunTransitionError(input.id ?? '(new)', null, input.status);
    }
    return this.transaction(() => {
      const id = input.id ?? ulid();
      const chatKey = chatKeyOf(input.chatKey);
      const seq =
        (this.db
          .select({ value: max(turnRuns.chatSeq) })
          .from(turnRuns)
          .where(eq(turnRuns.sessionId, chatKey))
          .get()?.value ?? 0) + 1;
      const at = new Date(this.now()).toISOString();
      const live = input.status === 'running';
      this.db
        .insert(turnRuns)
        .values({
          id,
          sessionId: chatKey,
          chatSeq: seq,
          chainId: id,
          agentId: input.agentId ?? null,
          originJson: input.origin ? JSON.stringify(input.origin) : null,
          openedBy: input.openedBy,
          status: input.status,
          queueMessageId: input.queueMessageId ?? null,
          runtime: input.runtime ?? null,
          runtimeTurnRef: input.runtimeTurnRef ?? null,
          ...(live ? this.lease() : {}),
          createdAt: at,
          ...(live ? { startedAt: at, deliveredAt: at } : {}),
        })
        .run();
      if (input.status === 'queued' && input.queueMessageId === undefined) this.heldWords.add(id);
      return this.get(id)!;
    });
  }

  /**
   * Move a run to a new status, checked against the transition table, with
   * the columns that change beside it. Writes only if the run is still in the
   * status it was read in, so two writers can never both move it.
   *
   * @param run - The run, as just read.
   * @param to - The status to move it to.
   * @param patch - Columns to set in the same write.
   * @returns The run as stored after the move.
   * @throws {IllegalRunTransitionError} When the pair is not one of the fifteen.
   */
  move(run: TurnRun, to: RunStatus, patch: RunPatch = {}): TurnRun {
    if (!canTransition(run.status, to)) throw new IllegalRunTransitionError(run.id, run.status, to);
    const changed = this.db
      .update(turnRuns)
      .set({ status: to, ...patchColumns(patch) })
      .where(and(eq(turnRuns.id, run.id), eq(turnRuns.status, run.status)))
      .run().changes;
    if (changed === 0) throw new IllegalRunTransitionError(run.id, run.status, to);
    if (to !== 'queued' && this.heldWords.delete(run.id)) this.dropFrames.at(-1)?.push(run.id);
    return this.get(run.id)!;
  }

  /**
   * Set columns without moving the status: an ending observed at `turn_end`, a
   * stop request, a person's ask opening.
   *
   * @param runId - The run.
   * @param patch - The columns.
   */
  annotate(runId: string, patch: RunPatch): void {
    this.db.update(turnRuns).set(patchColumns(patch)).where(eq(turnRuns.id, runId)).run();
  }

  /** The owner columns a run gets when it goes live: this boot, leased from now. */
  lease(): { ownerEpoch: string; leaseUntil: number } {
    return { ownerEpoch: this.opts.epoch, leaseUntil: this.now() + RUN_LEASE_MS };
  }

  /** Now, as the ISO 8601 text the record's times use. */
  stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Renew the lease of every live run this boot owns and still holds the
   * in-memory owner of (§4.1). A run whose owner is gone is left to lapse.
   *
   * @returns How many leases were renewed.
   */
  renewLeases(): number {
    const held = this.ownLiveRuns().filter((run) => this.holds(run.id));
    if (held.length === 0) return 0;
    return this.db
      .update(turnRuns)
      .set({ leaseUntil: this.now() + RUN_LEASE_MS })
      .where(
        and(
          inArray(
            turnRuns.id,
            held.map((run) => run.id)
          ),
          inArray(turnRuns.status, [...LIVE_TURN_RUN_STATUSES])
        )
      )
      .run().changes;
  }

  /** This boot's live runs, of one chat or all. */
  private ownLiveRuns(chatKey?: string): TurnRun[] {
    return this.db
      .select()
      .from(turnRuns)
      .where(
        and(
          inArray(turnRuns.status, [...LIVE_TURN_RUN_STATUSES]),
          eq(turnRuns.ownerEpoch, this.opts.epoch),
          ...(chatKey !== undefined ? [eq(turnRuns.sessionId, chatKey)] : [])
        )
      )
      .all()
      .map(toRun);
  }

  /**
   * Every live run whose owner is gone: another boot owned it and its lease
   * ran out (§7.1), or this boot owns it and no longer holds its in-memory
   * owner. A run this boot still holds is never dead, however late its lease,
   * which is what keeps a laptop's sleep from killing its own turns.
   *
   * @param chatKey - Only this chat's, when given.
   */
  deadLiveRuns(chatKey?: string): TurnRun[] {
    const foreign = this.db
      .select()
      .from(turnRuns)
      .where(
        and(
          inArray(turnRuns.status, [...LIVE_TURN_RUN_STATUSES]),
          ne(turnRuns.ownerEpoch, this.opts.epoch),
          lt(turnRuns.leaseUntil, this.now()),
          ...(chatKey !== undefined ? [eq(turnRuns.sessionId, chatKey)] : [])
        )
      )
      .all()
      .map(toRun);
    return [...foreign, ...this.ownLiveRuns(chatKey).filter((run) => !this.holds(run.id))];
  }

  /**
   * This boot's runs that are `started` or `running`: what a graceful
   * shutdown ends.
   */
  ownTurnsRunning(): TurnRun[] {
    return this.db
      .select()
      .from(turnRuns)
      .where(
        and(
          eq(turnRuns.ownerEpoch, this.opts.epoch),
          inArray(turnRuns.status, ['started', 'running']),
          isNotNull(turnRuns.ownerEpoch)
        )
      )
      .all()
      .map(toRun);
  }

  /**
   * Move one waiting run to another chat, after that chat's runs, when its
   * queue row moved there.
   *
   * @param run - The run, `queued`.
   * @param toChatKey - The chat its row now waits on, as its queue rows are kept.
   */
  moveToChat(run: TurnRun, toChatKey: string): void {
    if (run.sessionId === toChatKey) return;
    this.transaction(() => {
      const tail =
        this.db
          .select({ value: max(turnRuns.chatSeq) })
          .from(turnRuns)
          .where(eq(turnRuns.sessionId, toChatKey))
          .get()?.value ?? 0;
      this.db
        .update(turnRuns)
        .set({ sessionId: toChatKey, chatSeq: tail + 1 })
        .where(and(eq(turnRuns.id, run.id), eq(turnRuns.status, 'queued')))
        .run();
    });
  }

  /**
   * Move a chat's runs to a new id, after any runs already there, so
   * `chat_seq` stays unique and in order. Exact ids, never resolved: it runs
   * in the transaction that moves the chat's queue rows, before the new id is
   * linked.
   *
   * Throws when both ids hold a live run (the one-live-run index refuses the
   * move): nothing moves, the runs stay under the old id, and the queue
   * store's caller logs both ids and still moves its rows. Known edge: the
   * runs then stay under the old id until something moves them by hand.
   *
   * @param fromChatKey - The id they are kept under.
   * @param toChatKey - The id they move to.
   * @throws When both chats hold a live run.
   */
  rekeyChat(fromChatKey: string, toChatKey: string): void {
    if (fromChatKey === toChatKey) return;
    this.transaction(() => {
      const moving = this.rawListForChat(fromChatKey);
      if (moving.length === 0) return;
      const tail =
        this.db
          .select({ value: max(turnRuns.chatSeq) })
          .from(turnRuns)
          .where(eq(turnRuns.sessionId, toChatKey))
          .get()?.value ?? 0;
      moving.forEach((run, index) => {
        this.db
          .update(turnRuns)
          .set({ sessionId: toChatKey, chatSeq: tail + index + 1 })
          .where(eq(turnRuns.id, run.id))
          .run();
      });
    });
  }
}
