/**
 * The outbox's store: the only code that reads or writes `turn_effects` (spec
 * `turns-survive-restarts` §6.1, DOR-5160).
 *
 * Every state change here is one conditional update, and every one a worker
 * makes is **fenced** by its lease: it writes only while the effect is still
 * `leased` to the boot epoch that asks. So a worker whose lease ran out, and
 * whose effect another boot took back, can never finish or retry it, and a
 * handler whose own write rides in the same transaction as its finish (§6.4)
 * rolls back with it.
 *
 * @module services/runs/effects/effect-store
 */
import { monotonicFactory } from 'ulidx';
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  sql,
  turnEffects,
  TERMINAL_TURN_EFFECT_STATES,
  type Db,
  type TurnEffectRow,
} from '@dorkos/db';

/** A kind of follow-up work (§6.2). */
export type EffectKind = TurnEffectRow['kind'];

/** How safe an effect is to run twice (§6.2). */
export type EffectDelivery = TurnEffectRow['delivery'];

/** An effect's state (§6.1). */
export type EffectState = TurnEffectRow['state'];

/** The states an effect never leaves. */
export type TerminalEffectState = (typeof TERMINAL_TURN_EFFECT_STATES)[number];

/** States that still owe work: what keeps a run from settling. */
const OPEN_STATES: EffectState[] = ['pending', 'leased'];

/** An effect as the store answers it. */
export interface TurnEffect {
  id: string;
  kind: EffectKind;
  key: string;
  runId: string | null;
  sessionId: string | null;
  /** The parsed `payload_json`; each kind's handler reads its own shape. */
  payload: unknown;
  delivery: EffectDelivery;
  state: EffectState;
  availableAt: number;
  notAfter: number | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  attempts: number;
  /** The parsed `outcome`, when the effect has one. */
  outcome: unknown;
  createdAt: string;
  settledAt: string | null;
}

/** What {@link EffectStore.insert} needs. */
export interface NewEffect {
  kind: EffectKind;
  /** The idempotency key: a second insert of the same key is ignored. */
  key: string;
  runId?: string;
  sessionId?: string;
  /** References and fixed DorkOS copy only (§6.1). */
  payload: unknown;
  delivery: EffectDelivery;
  /** Epoch ms; not before. Defaults to now. */
  availableAt?: number;
  /** Epoch ms; required on every kind but `start_turn` (§6.1). */
  notAfter: number | null;
}

/** Read stored JSON, degrading an unreadable value to `null`. */
function parseJson(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** A stored row as the store answers it. */
function toEffect(row: TurnEffectRow): TurnEffect {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    runId: row.runId,
    sessionId: row.sessionId,
    payload: parseJson(row.payloadJson),
    delivery: row.delivery,
    state: row.state,
    availableAt: row.availableAt,
    notAfter: row.notAfter,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    attempts: row.attempts,
    outcome: parseJson(row.outcome),
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}

/** A lease, as the worker that holds it names it. */
export interface EffectLease {
  /** The effect. */
  id: string;
  /** The boot epoch holding it. */
  owner: string;
}

/** Options for {@link EffectStore}. */
export interface EffectStoreOptions {
  /** The clock, epoch ms. Injected by tests. */
  now?: () => number;
}

/** The outbox over the machine store's `turn_effects` table. */
export class EffectStore {
  private readonly now: () => number;
  private readonly nextId = monotonicFactory();
  private readonly workListeners = new Set<() => void>();

  /**
   * Open the store over the machine store.
   *
   * @param db - The machine store.
   * @param opts - In tests, the clock.
   */
  constructor(
    private readonly db: Db,
    opts: EffectStoreOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Run `fn` as one immediate transaction, or inside the one already open.
   *
   * @param fn - The reads and writes.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(() => fn(), { behavior: 'immediate' });
  }

  /**
   * Hear that there may be work: every insert, and every {@link announceWork}.
   * The worker's in-process wake (§6.1). Called inside the writer's
   * transaction when there is one, so a listener must only schedule work,
   * never do it.
   *
   * @param listener - What to call.
   * @returns A function that stops listening.
   */
  onWork(listener: () => void): () => void {
    this.workListeners.add(listener);
    return () => this.workListeners.delete(listener);
  }

  /** Say there may be work without an insert: a run that ended owing nothing still settles. */
  announceWork(): void {
    for (const listener of this.workListeners) listener();
  }

  /**
   * Save an effect, unless one with its key is already saved (§6.4).
   *
   * @param effect - The effect.
   * @returns Whether this call saved it.
   */
  insert(effect: NewEffect): boolean {
    const now = this.now();
    const inserted =
      this.db
        .insert(turnEffects)
        .values({
          id: this.nextId(now),
          kind: effect.kind,
          key: effect.key,
          runId: effect.runId ?? null,
          sessionId: effect.sessionId ?? null,
          payloadJson: JSON.stringify(effect.payload ?? null),
          delivery: effect.delivery,
          state: 'pending',
          availableAt: effect.availableAt ?? now,
          notAfter: effect.notAfter,
          createdAt: new Date(now).toISOString(),
        })
        .onConflictDoNothing({ target: turnEffects.key })
        .run().changes > 0;
    if (inserted) this.announceWork();
    return inserted;
  }

  /**
   * One effect by id.
   *
   * @param id - The effect.
   */
  get(id: string): TurnEffect | undefined {
    const row = this.db.select().from(turnEffects).where(eq(turnEffects.id, id)).get();
    return row ? toEffect(row) : undefined;
  }

  /**
   * A run's effects, in the order they were written.
   *
   * @param runId - The run.
   */
  listForRun(runId: string): TurnEffect[] {
    return this.db
      .select()
      .from(turnEffects)
      .where(eq(turnEffects.runId, runId))
      .orderBy(turnEffects.id)
      .all()
      .map(toEffect);
  }

  /**
   * How many of a run's effects still owe work (`pending` or `leased`).
   *
   * @param runId - The run.
   */
  openCountForRun(runId: string): number {
    return (
      this.db
        .select({ value: count() })
        .from(turnEffects)
        .where(and(eq(turnEffects.runId, runId), inArray(turnEffects.state, OPEN_STATES)))
        .get()?.value ?? 0
    );
  }

  /**
   * When the worker next has something to do, epoch ms: the soonest a pending
   * effect falls due or passes its `not_after`, or another boot's lease runs
   * out. `undefined` when nothing is open.
   *
   * @param owner - This boot's epoch; its own leases end with their handlers.
   */
  nextWorkAt(owner: string): number | undefined {
    const row = this.db
      .select({
        due: sql<number | null>`min(CASE WHEN ${turnEffects.state} = 'pending'
          THEN min(${turnEffects.availableAt}, coalesce(${turnEffects.notAfter}, ${turnEffects.availableAt}))
          WHEN ${turnEffects.leaseOwner} <> ${owner} THEN ${turnEffects.leaseUntil} END)`,
      })
      .from(turnEffects)
      .where(inArray(turnEffects.state, OPEN_STATES))
      .get();
    return row?.due ?? undefined;
  }

  /**
   * Take the next due effect: `pending`, due by `available_at`, within its
   * `not_after`, and with no earlier effect of its run still open, so a run's
   * follow-ups run in the order they were written (§5, item 5). A chat's
   * `start_turn` effects that order behind it (`session_id` set: runs whose
   * words stay at their source) are handed over in the order they were
   * written too, so those runs start in `chat_seq` order among themselves; a
   * run whose words wait in the composer orders behind nothing here, so a
   * row never waits on them, nor they on a row. One
   * conditional update in an immediate transaction, so of two workers asking
   * at once only one gets it.
   *
   * @param owner - The asking worker's boot epoch.
   * @param leaseMs - How long the lease lasts before it must be renewed.
   * @returns The effect, now `leased` to `owner`, or `undefined` when none is due.
   */
  leaseNext(owner: string, leaseMs: number): TurnEffect | undefined {
    return this.transaction(() => {
      const now = this.now();
      const due = this.db
        .select()
        .from(turnEffects)
        .where(
          and(
            eq(turnEffects.state, 'pending'),
            lte(turnEffects.availableAt, now),
            sql`(${turnEffects.notAfter} IS NULL OR ${turnEffects.notAfter} >= ${now})`,
            sql`(${turnEffects.runId} IS NULL OR NOT EXISTS (
              SELECT 1 FROM "turn_effects" AS "earlier"
              WHERE "earlier"."run_id" = ${turnEffects.runId}
                AND "earlier"."id" < ${turnEffects.id}
                AND "earlier"."state" IN ('pending', 'leased')))`,
            sql`(${turnEffects.kind} <> 'start_turn' OR ${turnEffects.sessionId} IS NULL OR NOT EXISTS (
              SELECT 1 FROM "turn_effects" AS "ahead"
              WHERE "ahead"."kind" = 'start_turn' AND "ahead"."session_id" = ${turnEffects.sessionId}
                AND "ahead"."id" < ${turnEffects.id} AND "ahead"."state" IN ('pending', 'leased')))`
          )
        )
        .orderBy(turnEffects.id)
        .limit(1)
        .get();
      if (!due) return undefined;
      const taken = this.db
        .update(turnEffects)
        .set({
          state: 'leased',
          leaseOwner: owner,
          leaseUntil: now + leaseMs,
          attempts: due.attempts + 1,
        })
        .where(and(eq(turnEffects.id, due.id), eq(turnEffects.state, 'pending')))
        .run().changes;
      return taken > 0 ? this.get(due.id) : undefined;
    });
  }

  /**
   * Push a held lease's end out (§6.1: every 20 seconds while the handler works).
   *
   * @param lease - The lease.
   * @param leaseMs - How long from now.
   * @returns Whether the lease was still held.
   */
  renew(lease: EffectLease, leaseMs: number): boolean {
    return (
      this.db
        .update(turnEffects)
        .set({ leaseUntil: this.now() + leaseMs })
        .where(this.held(lease))
        .run().changes > 0
    );
  }

  /**
   * End a held effect in a terminal state.
   *
   * @param lease - The lease.
   * @param state - `done`, `dropped`, `unknown` or `expired`.
   * @param outcome - What to keep about how it ended.
   * @returns Whether the lease was still held, so the write happened.
   */
  finish(lease: EffectLease, state: TerminalEffectState, outcome?: unknown): boolean {
    return (
      this.db
        .update(turnEffects)
        .set({
          state,
          leaseUntil: null,
          outcome: outcome === undefined ? null : JSON.stringify(outcome),
          settledAt: new Date(this.now()).toISOString(),
        })
        .where(this.held(lease))
        .run().changes > 0
    );
  }

  /**
   * Hand a held effect back to `pending`, due at `availableAt` (a retry's
   * backoff, or a handler's own `wait`).
   *
   * @param lease - The lease.
   * @param availableAt - Epoch ms; not before.
   * @param outcome - What the attempt answered.
   * @returns Whether the lease was still held.
   */
  release(lease: EffectLease, availableAt: number, outcome?: unknown): boolean {
    return (
      this.db
        .update(turnEffects)
        .set({
          state: 'pending',
          availableAt,
          leaseUntil: null,
          outcome: outcome === undefined ? null : JSON.stringify(outcome),
        })
        .where(this.held(lease))
        .run().changes > 0
    );
  }

  /**
   * Take back every lease another boot held and let run out (§6.2, rule 1;
   * §7.3, step 3): a `repeatable` effect goes back to `pending`, due now, and
   * a `once` effect is `unknown`, never run again. A lease this boot holds is
   * never taken back here, however late: its handler is still running in this
   * process, and a laptop's sleep is not a death.
   *
   * @param owner - This boot's epoch.
   * @returns The effects it ended as `unknown`, so their runs can settle.
   */
  reclaimLapsed(owner: string): TurnEffect[] {
    return this.transaction(() => {
      const now = this.now();
      const lapsed = this.db
        .select()
        .from(turnEffects)
        .where(
          and(
            eq(turnEffects.state, 'leased'),
            ne(turnEffects.leaseOwner, owner),
            isNotNull(turnEffects.leaseUntil),
            lt(turnEffects.leaseUntil, now)
          )
        )
        .all();
      const ended: TurnEffect[] = [];
      for (const row of lapsed) {
        const once = row.delivery === 'once';
        this.db
          .update(turnEffects)
          .set(
            once
              ? {
                  state: 'unknown',
                  leaseUntil: null,
                  outcome: JSON.stringify({ reason: 'lease_lapsed' }),
                  settledAt: new Date(now).toISOString(),
                }
              : { state: 'pending', availableAt: now, leaseUntil: null }
          )
          .where(and(eq(turnEffects.id, row.id), eq(turnEffects.state, 'leased')))
          .run();
        if (once) ended.push(this.get(row.id)!);
      }
      return ended;
    });
  }

  /**
   * Settle every `pending` effect past its `not_after` as `expired`, with a
   * reason naming its kind and deadline (§6.1, "Expiry"). A leased effect is
   * left to its holder; once its lease lapses, {@link reclaimLapsed} hands it
   * back and the next call here expires it.
   *
   * @param onExpired - Called for each, inside the same transaction: a
   *   `start_turn` past its deadline cancels its run there (§6.2).
   * @returns The effects it expired.
   */
  expireDue(onExpired?: (effect: TurnEffect) => void): TurnEffect[] {
    return this.transaction(() => {
      const now = this.now();
      const due = this.db
        .select()
        .from(turnEffects)
        .where(
          and(
            eq(turnEffects.state, 'pending'),
            isNotNull(turnEffects.notAfter),
            lt(turnEffects.notAfter, now)
          )
        )
        .all();
      for (const row of due) {
        this.db
          .update(turnEffects)
          .set({
            state: 'expired',
            outcome: JSON.stringify({
              reason: 'not_after',
              kind: row.kind,
              notAfter: new Date(row.notAfter!).toISOString(),
            }),
            settledAt: new Date(now).toISOString(),
          })
          .where(and(eq(turnEffects.id, row.id), eq(turnEffects.state, 'pending')))
          .run();
        onExpired?.(this.get(row.id)!);
      }
      return due.map((row) => this.get(row.id)!);
    });
  }

  /**
   * A run's `start_turn` that still owes its hand-over, if it has one.
   *
   * @param runId - The run.
   */
  openStartOf(runId: string): TurnEffect | undefined {
    const row = this.db
      .select()
      .from(turnEffects)
      .where(and(this.startsOf(runId), inArray(turnEffects.state, OPEN_STATES)))
      .get();
    return row ? toEffect(row) : undefined;
  }

  /**
   * End a run's open `start_turn`, whoever holds it: the run started, joined
   * another turn or was cancelled (transitions 5, 6, 7 and 9 settle it, §6.2).
   * Not fenced by a lease, because the run's own move decides it; a handler
   * still holding the lease finds it gone and writes nothing more.
   *
   * @param runId - The run.
   * @param state - `done`, or `expired` for a run cancelled past its deadline.
   * @param outcome - What to keep about how it ended.
   */
  endStartOf(runId: string, state: 'done' | 'expired', outcome?: unknown): void {
    this.db
      .update(turnEffects)
      .set({
        state,
        leaseUntil: null,
        outcome: outcome === undefined ? null : JSON.stringify(outcome),
        settledAt: new Date(this.now()).toISOString(),
      })
      .where(and(this.startsOf(runId), inArray(turnEffects.state, OPEN_STATES)))
      .run();
  }

  /**
   * Hand a run's open `start_turn` back to `pending`, due at `availableAt`:
   * the run went back in line with its words at the space side (transition
   * 8), so it is handed over again for a new launch (§6.2).
   *
   * @param runId - The run.
   * @param availableAt - Epoch ms; not before.
   */
  reopenStartOf(runId: string, availableAt: number): void {
    const changed = this.db
      .update(turnEffects)
      .set({ state: 'pending', availableAt, leaseUntil: null })
      .where(and(this.startsOf(runId), inArray(turnEffects.state, OPEN_STATES)))
      .run().changes;
    if (changed > 0) this.announceWork();
  }

  /**
   * Make every `start_turn` that waits for room due now: a run let go of its
   * chat or its launch slot, or a pause was lifted (§3.5). Only a real wait
   * (`chat_busy`, `machine_full`, `paused`, named in its outcome) is woken; an
   * effect backing off after a throw keeps its backoff.
   */
  wakeAllStarts(): void {
    const now = this.now();
    const changed = this.db
      .update(turnEffects)
      .set({ availableAt: now })
      .where(
        and(
          eq(turnEffects.kind, 'start_turn'),
          eq(turnEffects.state, 'pending'),
          gt(turnEffects.availableAt, now),
          sql`json_extract(${turnEffects.outcome}, '$.waiting') IS NOT NULL`
        )
      )
      .run().changes;
    if (changed > 0) this.announceWork();
  }

  /**
   * Every effect this boot holds right now.
   *
   * @param owner - This boot's epoch.
   */
  heldBy(owner: string): TurnEffect[] {
    return this.db
      .select()
      .from(turnEffects)
      .where(and(eq(turnEffects.state, 'leased'), eq(turnEffects.leaseOwner, owner)))
      .all()
      .map(toEffect);
  }

  /**
   * The effects this boot holds past their deadline: a `start_turn` whose
   * handler answered `await` and whose run is still waiting for `started`.
   *
   * @param owner - This boot's epoch.
   */
  heldPastDeadline(owner: string): TurnEffect[] {
    return this.db
      .select()
      .from(turnEffects)
      .where(
        and(
          eq(turnEffects.state, 'leased'),
          eq(turnEffects.leaseOwner, owner),
          isNotNull(turnEffects.notAfter),
          lt(turnEffects.notAfter, this.now())
        )
      )
      .all()
      .map(toEffect);
  }

  /**
   * Renew every lease this boot holds: what keeps an awaited `start_turn`
   * leased while its run waits for `started` (the owner's heartbeat, §6.1).
   *
   * @param owner - This boot's epoch.
   * @param leaseMs - How long from now.
   */
  renewOwned(owner: string, leaseMs: number): number {
    return this.db
      .update(turnEffects)
      .set({ leaseUntil: this.now() + leaseMs })
      .where(and(eq(turnEffects.state, 'leased'), eq(turnEffects.leaseOwner, owner)))
      .run().changes;
  }

  /**
   * A chat's open `start_turn` effects for runs without a queue row, oldest
   * first: the order those runs wait in (§4.6, `queuePosition`).
   *
   * @param sessionId - The chat, as its queue rows are kept.
   */
  openStartRunsOf(sessionId: string): string[] {
    return this.db
      .select({ runId: turnEffects.runId })
      .from(turnEffects)
      .where(
        and(
          eq(turnEffects.kind, 'start_turn'),
          eq(turnEffects.sessionId, sessionId),
          inArray(turnEffects.state, OPEN_STATES)
        )
      )
      .orderBy(turnEffects.id)
      .all()
      .flatMap((row) => (row.runId === null ? [] : [row.runId]));
  }

  /**
   * Replace an effect's payload, inside the caller's transaction: a wake that
   * lets go of its words once its run ends keeps only what names its event (§6.2).
   *
   * @param id - The effect.
   * @param payload - What it keeps.
   */
  replacePayload(id: string, payload: unknown): void {
    const payloadJson = JSON.stringify(payload);
    this.db.update(turnEffects).set({ payloadJson }).where(eq(turnEffects.id, id)).run();
  }

  /**
   * One effect by its idempotency key (§6.4).
   *
   * @param key - The key.
   */
  byKey(key: string): TurnEffect | undefined {
    const row = this.db.select().from(turnEffects).where(eq(turnEffects.key, key)).get();
    return row ? toEffect(row) : undefined;
  }

  /**
   * Whether a chat has an effect of this kind still to carry out: what the
   * launch gate reads for a continuation recovery decided but has not made
   * yet (§7.5).
   *
   * @param kind - The kind.
   * @param sessionId - The chat, as its queue rows are kept.
   */
  hasOpen(kind: EffectKind, sessionId: string): boolean {
    return (
      this.db
        .select({ id: turnEffects.id })
        .from(turnEffects)
        .where(
          and(
            eq(turnEffects.kind, kind),
            eq(turnEffects.sessionId, sessionId),
            inArray(turnEffects.state, OPEN_STATES)
          )
        )
        .get() !== undefined
    );
  }

  /** A run's `start_turn` effects. */
  private startsOf(runId: string) {
    return and(eq(turnEffects.kind, 'start_turn'), eq(turnEffects.runId, runId));
  }

  /** The condition every fenced write carries: still leased, to this owner. */
  private held(lease: EffectLease) {
    return and(
      eq(turnEffects.id, lease.id),
      eq(turnEffects.state, 'leased'),
      eq(turnEffects.leaseOwner, lease.owner)
    );
  }
}
