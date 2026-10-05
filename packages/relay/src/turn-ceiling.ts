/**
 * The ceiling on how many agent turns the message bus may start, counted
 * without asking who is calling.
 *
 * ## Why this is not the budget envelope
 *
 * Every envelope already carries a {@link RelayBudget} — hops, TTL, a call
 * budget — and `budget-enforcer.ts` spends it at the publish gate. That bounds
 * ONE chain of messages, and it does it by reading a number the chain carries
 * with it. Which is exactly the property a loop does not have: a publish that
 * omits a budget gets a FRESH one (`createDefaultBudget`), so two agents told
 * to keep each other posted mint a new full allowance on every hop and the
 * envelope budget never runs out. A webhook that republishes an inbound request
 * did the same thing with the hop counter. The chain bound is real; it is just
 * not a bound on the wallet, because a caller can always start a new chain.
 *
 * ## Why it lives at the adapter dispatch
 *
 * Five surfaces can make an agent answer over this bus — the rooms tool, an
 * agent's own `relay_send`, an A2A peer, a webhook posting back, the scheduler
 * dispatching a task — and they do not share a route, a principal, or a rate
 * limiter. They share exactly one thing: the publish pipeline's adapter
 * dispatch, the step where an envelope is handed to the runtime and a real, paid
 * turn begins. A ceiling anywhere earlier has to be re-implemented per surface
 * and silently misses the sixth one somebody adds next year. So it is here, at
 * the one choke point, and it counts the dispatch rather than the caller.
 *
 * **Which dispatches those are is the adapter's answer, not a prefix list.** The
 * first cut of this matched `relay.agent.*` and missed `relay.system.tasks.*`,
 * which the same adapter answers for and turns into a `sendMessage` — a hole any
 * caller could publish into. `RelayAdapter.startsAgentTurns` is where that fact
 * lives now, beside the routing that decides it.
 *
 * **Counting the caller is what does not work**, and the reason is the same one
 * `rooms/limits/turn-budget.ts` states at length: in the shipped posture
 * (`auth.enabled` false) DorkOS cannot tell a program on this machine from the
 * person at the keyboard, so any bound that reads identity can be sidestepped
 * by asserting a different one. This one reads nothing but the target subject
 * and the clock.
 *
 * ## Two ceilings, for the reason rooms has two
 *
 * | Cap        | Bounds                                           |
 * | ---------- | ------------------------------------------------ |
 * | per target | what any ONE agent (or scheduled task) can cost   |
 * | global     | what the whole install can cost                   |
 *
 * The per-agent cap alone is not a spend bound — agents are free to create, so a
 * caller that can create them multiplies its allowance — and the global cap
 * alone lets one runaway pair eat everything every other agent needed. Both, or
 * neither is worth much.
 *
 * ## What it deliberately is not
 *
 * **Not durable.** The rooms ceiling writes its window to `room_turn_spend` so
 * an hour means an hour across a restart (DOR-1205). This one holds its windows
 * in memory only: relay has no spend table of its own, and the one table it
 * could borrow — `relayIndex` — is a DERIVED index that `rebuild()` recreates
 * from Maildir, so a counter kept there would be silently erased by a routine
 * repair. The residual is honest and worth stating: a process restart hands the
 * bus a fresh hour. That does not weaken the case this exists for — two
 * misconfigured agents looping inside one long-lived process, which is the
 * common case and costs real money for no work — and a caller deliberately
 * restarting the server to clear a counter already has a shell on this machine,
 * which is DOR-505's problem, not this module's.
 *
 * **Not a spend log.** Timestamps outside the window are dropped as new ones
 * land. This is a counter; the trace store is where history lives.
 *
 * @module relay/turn-ceiling
 */
import { RELAY_TURN_CEILING_DEFAULTS } from '@dorkos/shared/config-schema';

/** One hour, the window both limits are denominated in. */
const WINDOW_MS = 60 * 60_000;

/**
 * How many agent subjects to keep windows for before dropping the least
 * recently touched. An agent's window is at most its cap in timestamps, so this
 * bounds the whole structure.
 *
 * Eviction can only ever be generous — an evicted agent reads as unspent —
 * which is why the global window is NOT keyed by subject and is never evicted.
 * That is the one that has to be exact.
 */
const TRACKED_SUBJECTS = 256;

/** Which ceiling refused a dispatch. */
export type TurnCeilingScope = 'agent' | 'global';

/**
 * Outcome of asking to start one agent turn.
 *
 * Carries no headroom number, for the reason {@link RelayTurnCeiling.remaining}
 * exists separately: headroom is zero at exactly the moment a refusal would
 * report it. What a reader of the refusal needs is WHICH ceiling said no, since
 * the two send a person to different settings.
 */
export interface TurnCeilingDecision {
  allowed: boolean;
  /** Set only when `allowed` is false: which ceiling refused. */
  scope?: TurnCeilingScope;
  /**
   * Whether this dispatch was actually charged to a window.
   *
   * False when nothing was counting it — both ceilings unlimited — in which
   * case `allowed` is true and no window moved.
   */
  counted: boolean;
}

/**
 * The two live ceilings, read per call so a change in Settings takes effect at
 * once rather than at the next restart.
 *
 * **`null` is unlimited, and it is a distinct state rather than a big number**
 * — the same decision the rooms ceiling made. Nothing is reserved against a
 * ceiling that is off, nothing is recorded for it, and
 * {@link RelayTurnCeiling.remaining} reports `null` so a reader is told "no
 * limit" instead of a number nobody is counting down.
 */
export interface TurnCeilingLimits {
  /**
   * Turns any one agent subject may be sent per window, or `null` when that
   * ceiling is off.
   */
  perAgent: () => number | null;
  /**
   * Turns the whole install may start per window across every agent, or `null`
   * when that ceiling is off.
   */
  global: () => number | null;
}

/**
 * The limits used when a host wires none.
 *
 * A ceiling that only exists when somebody remembers to configure it is not a
 * ceiling: the publish pipeline is constructed in tests and by every host
 * that dispatches real turns. So the default is the shipped config default rather than
 * "unlimited" — forgetting to wire this narrows nothing.
 *
 * @returns The shipped limits, read from the one place they are declared.
 */
export function defaultTurnCeilingLimits(): TurnCeilingLimits {
  return {
    perAgent: () => RELAY_TURN_CEILING_DEFAULTS.maxAgentTurnsPerAgentPerHour,
    global: () => RELAY_TURN_CEILING_DEFAULTS.maxAgentTurnsTotalPerHour,
  };
}

interface TurnReservation {
  readonly at: number;
  readonly owned: boolean;
}
interface CounterState {
  limits: TurnCeilingLimits;
  now: () => number;
  windowMs: number;
  perAgent: Map<string, TurnReservation[]>;
  globalRuns: TurnReservation[];
}
interface DispatchTurnDecision extends TurnCeilingDecision {
  /** Exact, once-only refund for this counted dispatch; absent for an uncounted one. */
  refund?: () => void;
}
const states = new WeakMap<RelayTurnCeiling, CounterState>();

/**
 * Internal publisher accounting; never exported from the public package barrel.
 * @param ceiling - The actual counter instance shared by the publisher.
 * @internal
 */
export function dispatchTurnAccounting(ceiling: RelayTurnCeiling): {
  reserve(subject: string): DispatchTurnDecision;
} {
  const state = states.get(ceiling);
  if (!state) throw new Error('Unknown Relay turn ceiling instance.');
  return {
    reserve(subject) {
      const { decision, reservation } = reserve(state, subject, true);
      if (!reservation) return decision;
      let refunded = false;
      return {
        ...decision,
        refund() {
          if (refunded) return;
          refunded = true;
          const window = state.perAgent.get(subject);
          // Pruned, evicted or expired entries must not refresh subject recency:
          // changing LRU order could erase another subject's newer debt.
          if (window?.includes(reservation) && reservation.at > state.now() - state.windowMs)
            store(
              state,
              subject,
              window.filter((entry) => entry !== reservation)
            );
          state.globalRuns = state.globalRuns.filter((entry) => entry !== reservation);
        },
      };
    },
  };
}

function lastLegacyIndex(entries: TurnReservation[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (!entries[index]!.owned) return index;
  }
  return -1;
}

function store(state: CounterState, subject: string, window: TurnReservation[]): void {
  state.perAgent.delete(subject);
  state.perAgent.set(subject, window);
  if (state.perAgent.size > TRACKED_SUBJECTS) {
    const oldest = state.perAgent.keys().next().value;
    if (oldest !== undefined) state.perAgent.delete(oldest);
  }
}

function reserve(
  state: CounterState,
  subject: string,
  owned: boolean
): { decision: TurnCeilingDecision; reservation?: TurnReservation } {
  const globalCap = state.limits.global();
  const agentCap = state.limits.perAgent();
  if (globalCap === null && agentCap === null)
    return { decision: { allowed: true, counted: false } };
  const at = state.now();
  const floor = at - state.windowMs;
  state.globalRuns = state.globalRuns.filter((entry) => entry.at > floor);
  const agent = (state.perAgent.get(subject) ?? []).filter((entry) => entry.at > floor);
  if (globalCap !== null && state.globalRuns.length >= globalCap) {
    store(state, subject, agent);
    return { decision: { allowed: false, scope: 'global', counted: false } };
  }
  if (agentCap !== null && agent.length >= agentCap) {
    store(state, subject, agent);
    return { decision: { allowed: false, scope: 'agent', counted: false } };
  }
  const reservation: TurnReservation = { at, owned };
  agent.push(reservation);
  state.globalRuns.push(reservation);
  store(state, subject, agent);
  return { decision: { allowed: true, counted: true }, reservation };
}

/** A rolling count of ordinary public reservations and publisher-owned dispatches. */
export class RelayTurnCeiling {
  /**
   * Build a counter over an empty window.
   * @param opts.limits - The two live ceilings; defaults to the shipped ones.
   * @param opts.now - Injectable clock for the rolling window.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { limits?: TurnCeilingLimits; now?: () => number; windowMs?: number } = {}) {
    states.set(this, {
      limits: opts.limits ?? defaultTurnCeilingLimits(),
      now: opts.now ?? (() => Date.now()),
      windowMs: opts.windowMs ?? WINDOW_MS,
      perAgent: new Map(),
      globalRuns: [],
    });
  }

  /**
   * Claim a public legacy reservation, synchronously spending the last unit.
   * The global ceiling is checked first. Both unlimited ceilings charge nothing;
   * with only one unlimited, the other still counts the reservation.
   * @param subject - The subject about to be dispatched.
   */
  tryReserve(subject: string): TurnCeilingDecision {
    return reserve(states.get(this)!, subject, false).decision;
  }

  /**
   * Refund a public legacy reservation using its existing subject-based semantics.
   * Pops the newest legacy entry independently from the subject and global windows,
   * preserving the existing public API. Publisher-owned entries are isolated.
   * @param subject - The subject whose legacy reservation is being given back.
   */
  release(subject: string): void {
    const state = states.get(this)!;
    const window = state.perAgent.get(subject);
    if (window) {
      const index = lastLegacyIndex(window);
      if (index !== -1) {
        window.splice(index, 1);
        store(state, subject, window);
      }
    }
    const globalIndex = lastLegacyIndex(state.globalRuns);
    if (globalIndex !== -1) state.globalRuns.splice(globalIndex, 1);
  }

  /**
   * Read current headroom without reserving or mutating either rolling window.
   * Null means that ceiling is unlimited, never that no allowance remains.
   * @param subject - The subject being asked about.
   */
  remaining(subject: string): { agent: number | null; global: number | null } {
    const state = states.get(this)!;
    const floor = state.now() - state.windowMs;
    const globalCap = state.limits.global();
    const agentCap = state.limits.perAgent();
    const global = state.globalRuns.filter((entry) => entry.at > floor).length;
    const agent = (state.perAgent.get(subject) ?? []).filter((entry) => entry.at > floor).length;
    return {
      agent: agentCap === null ? null : Math.max(0, agentCap - agent),
      global: globalCap === null ? null : Math.max(0, globalCap - global),
    };
  }
}
