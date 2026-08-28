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
 * ceiling: the publish pipeline is constructed in tests, in the Obsidian
 * in-process transport, and by any future host, and every one of them dispatches
 * real turns. So the default is the shipped config default rather than
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

/**
 * A rolling count of agent turns started over the bus, per agent subject and in
 * total.
 *
 * Insertion-ordered `Map`, so the least recently touched subject is always the
 * first key — which is what makes eviction one `keys().next()`.
 */
export class RelayTurnCeiling {
  private readonly limits: TurnCeilingLimits;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly perAgent = new Map<string, number[]>();
  private globalRuns: number[] = [];

  /**
   * Build a counter over an empty window.
   *
   * @param opts.limits - The two live ceilings; defaults to the shipped ones.
   * @param opts.now - Clock, injectable so a test can move a window without sleeping.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { limits?: TurnCeilingLimits; now?: () => number; windowMs?: number } = {}) {
    this.limits = opts.limits ?? defaultTurnCeilingLimits();
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /**
   * Claim one agent turn for a subject.
   *
   * Reserves on success, so two dispatches racing in the same tick cannot both
   * spend the last unit. The global ceiling is checked FIRST: when the install
   * is out of budget the answer is the same for every agent, and naming the
   * agent as the reason would send someone to the wrong setting.
   *
   * **A ceiling that is off is not asked and not charged.** With BOTH off
   * nothing is reserved, so an hour spent unlimited cannot leave an agent out of
   * budget the moment somebody turns the ceilings back on. With only ONE off the
   * dispatch is still charged, because the other is genuinely counting it.
   *
   * @param subject - The `relay.agent.*` subject about to be dispatched.
   */
  tryReserve(subject: string): TurnCeilingDecision {
    const globalCap = this.limits.global();
    const agentCap = this.limits.perAgent();
    if (globalCap === null && agentCap === null) return { allowed: true, counted: false };

    const at = this.now();
    const floor = at - this.windowMs;
    this.globalRuns = this.globalRuns.filter((t) => t > floor);
    const agent = (this.perAgent.get(subject) ?? []).filter((t) => t > floor);

    if (globalCap !== null && this.globalRuns.length >= globalCap) {
      this.store(subject, agent);
      return { allowed: false, scope: 'global', counted: false };
    }
    if (agentCap !== null && agent.length >= agentCap) {
      this.store(subject, agent);
      return { allowed: false, scope: 'agent', counted: false };
    }

    agent.push(at);
    this.globalRuns.push(at);
    this.store(subject, agent);
    return { allowed: true, counted: true };
  }

  /**
   * Give back a reservation whose turn never ran.
   *
   * A dispatch is reserved BEFORE it is handed to the adapter, because the
   * reservation is what stops a burst from all spending the last unit at once.
   * But a handed-over dispatch can still not happen: the runtime refuses for
   * want of a slot, the adapter throws, the registry loses the adapter
   * mid-flight. Every one of those dead-letters, and without a refund the
   * allowance drains anyway — an agent whose slots are full could burn a
   * thousand turns an hour having run none. That is the same shape of bug as
   * charging for an adapter-less subject, and it is worse, because it happens to
   * an install that is merely busy.
   *
   * Pops the newest timestamp from both windows rather than matching the
   * reservation's own instant. This is a counter, not a ledger: which of two
   * timestamps in the same window is removed changes nothing anybody can
   * observe, and asking every caller to carry a token would put the honesty of
   * the refund in the hands of code paths that fire from a `catch`.
   *
   * Safe to call for a dispatch that was never counted — with the ceilings off
   * the windows are empty and this does nothing.
   *
   * @param subject - The subject whose reservation is being given back.
   */
  release(subject: string): void {
    const window = this.perAgent.get(subject);
    if (window?.length) {
      window.pop();
      this.store(subject, window);
    }
    this.globalRuns.pop();
  }

  /**
   * How many turns are still available for a subject, without claiming one.
   *
   * A pure read: it prunes its view of both windows to the current window but
   * writes nothing back and reserves nothing, so calling it can never make a
   * turn unaffordable.
   *
   * **`null` means nothing is counting, never "none left".**
   *
   * @param subject - The agent subject being asked about.
   */
  remaining(subject: string): { agent: number | null; global: number | null } {
    const floor = this.now() - this.windowMs;
    const globalCap = this.limits.global();
    const agentCap = this.limits.perAgent();
    const global = this.globalRuns.filter((t) => t > floor).length;
    const agent = (this.perAgent.get(subject) ?? []).filter((t) => t > floor).length;
    return {
      agent: agentCap === null ? null : Math.max(0, agentCap - agent),
      global: globalCap === null ? null : Math.max(0, globalCap - global),
    };
  }

  /** Write a subject's pruned window back, re-inserting it as most recently used. */
  private store(subject: string, window: number[]): void {
    this.perAgent.delete(subject);
    this.perAgent.set(subject, window);
    if (this.perAgent.size > TRACKED_SUBJECTS) {
      const oldest = this.perAgent.keys().next().value;
      if (oldest !== undefined) this.perAgent.delete(oldest);
    }
  }
}
