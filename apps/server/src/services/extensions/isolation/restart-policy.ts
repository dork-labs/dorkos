/**
 * When to restart an isolated extension that stopped on its own (DOR-2686,
 * spec §9).
 *
 * An exit DorkOS did not ask for restarts the extension after 1 s, then 5 s,
 * then 30 s for every later restart (the delay climbs with each restart since
 * the last reset, so a slow crash loop backs off too). The third unexpected
 * exit inside 10 minutes leaves it stopped
 * (`server_crashed`, or `server_out_of_memory` / `server_unresponsive` when
 * that is what happened). A reload, enable, approve or dev-link reload resets
 * the count; those triggers are wired where the lifecycle starts isolated
 * extensions.
 *
 * Pure: it holds timestamps, never timers, so the host decides when to act.
 *
 * @module services/extensions/isolation/restart-policy
 */

/** What to do after an unexpected exit. */
export type RestartDecision = { restartIn: number } | { giveUp: true };

/** How the policy is tuned. */
export interface RestartPolicyOptions {
  /** Delays before each successive restart, in milliseconds. */
  delays?: readonly number[];
  /** Unexpected exits inside the window that end the attempts. */
  budget?: number;
  /** The window, in milliseconds. */
  windowMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** The delays the spec sets: 1 s, 5 s, 30 s. */
export const RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const;

/** Unexpected exits within the window that end the attempts. */
export const RESTART_BUDGET = 3;

/** The window those exits are counted in: 10 minutes. */
export const RESTART_WINDOW_MS = 10 * 60_000;

/**
 * Backoff and crash budget for one isolated extension.
 */
export class RestartPolicy {
  private exits: number[] = [];
  private restarts = 0;
  private readonly delays: readonly number[];
  private readonly budget: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  /**
   * Make a policy with no exits recorded.
   *
   * @param options - Delays, budget, window and clock; the spec's by default.
   */
  constructor(options: RestartPolicyOptions = {}) {
    this.delays = options.delays ?? RESTART_DELAYS_MS;
    this.budget = options.budget ?? RESTART_BUDGET;
    this.windowMs = options.windowMs ?? RESTART_WINDOW_MS;
    this.now = options.now ?? Date.now;
    if (this.delays.length === 0) throw new Error('RestartPolicy needs at least one delay.');
  }

  /**
   * Record an exit DorkOS did not ask for, and decide what happens next.
   *
   * @returns How long to wait before restarting, or that it should stay stopped.
   */
  onUnexpectedExit(): RestartDecision {
    const t = this.now();
    this.exits = this.exits.filter((at) => t - at < this.windowMs);
    this.exits.push(t);
    if (this.exits.length >= this.budget) return { giveUp: true };
    const delay = this.delays[Math.min(this.restarts, this.delays.length - 1)]!;
    this.restarts++;
    return { restartIn: delay };
  }

  /** Forget every recorded exit (reload, enable, approve, dev-link reload). */
  reset(): void {
    this.exits = [];
    this.restarts = 0;
  }
}
