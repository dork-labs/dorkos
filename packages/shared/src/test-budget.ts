/**
 * Wall-clock budgets for tests that wait on something the PLATFORM has to do.
 *
 * A test that drives a real filesystem watcher, a real subprocess or a real
 * socket has to put a ceiling on waiting, and a FIXED ceiling is a claim about
 * how fast the machine is. This repo is routinely running several agents' suites
 * at once: at a load average of 40-166 the same delivery that takes a fraction
 * of a second alone takes tens of seconds, so a fixed ceiling fires on healthy
 * code and ejects branches that touched nothing near it (DOR-2012).
 *
 * This module lives in `@dorkos/shared` because it is the one package every
 * other one already depends on. `@dorkos/test-utils` would have been the obvious
 * home and cannot be: it dev-depends on `@dorkos/relay`, which is one of the
 * packages that needs this, and that is a cycle.
 *
 * Nothing here ships behaviour — importing it from production code would be a
 * mistake, and nothing does.
 *
 * @module test-budget
 */
import os from 'node:os';

/**
 * The most a budget is ever stretched, however busy the machine is.
 *
 * Four covers the worst run measured on this hardware — 98 seconds against a
 * 30-second budget, 3.3x — and the clamp is what keeps a genuinely broken
 * watcher from taking minutes to say so.
 */
export const LOAD_SCALE_MAX = 4;

/**
 * How much slower this machine is than an idle one, as a multiplier.
 *
 * `loadavg()[0]` is a one-minute exponential average, so it LAGS: a sweep that
 * has only just started reads close to 1. That is why this is read at the moment
 * a budget is taken rather than once at module load — a budget frozen at import
 * time is a reading from before the suite that needed it began (DOR-2012 review).
 *
 * @param maxFactor - The clamp, defaulting to {@link LOAD_SCALE_MAX}.
 * @returns A multiplier between 1 and `maxFactor`.
 */
function loadFactor(maxFactor: number): number {
  const perCore = os.loadavg()[0] / Math.max(1, os.cpus().length);
  return Math.min(maxFactor, Math.max(1, perCore));
}

/**
 * A budget widened by how busy the machine is RIGHT NOW.
 *
 * This can only ever make a test wait longer, never assert less. Every caller
 * uses the result as a ceiling on waiting for something to happen, so the wait
 * still ends the instant it happens, and something that never happens still
 * reds — just later.
 *
 * @param baseMs - The budget an idle machine needs.
 * @param maxFactor - The clamp, defaulting to {@link LOAD_SCALE_MAX}.
 * @returns `baseMs` scaled by the current per-core load average.
 */
export function loadScaledMs(baseMs: number, maxFactor: number = LOAD_SCALE_MAX): number {
  return Math.round(baseMs * loadFactor(maxFactor));
}

/**
 * The largest value {@link loadScaledMs} could ever return for `baseMs`.
 *
 * For deriving a test's OWN timeout, which a runner fixes when the test is
 * defined and cannot resample later: size it from the worst case the waits
 * inside it can grow to, not from whatever the load happened to be at import.
 *
 * @param baseMs - The budget an idle machine needs.
 * @param maxFactor - The clamp, defaulting to {@link LOAD_SCALE_MAX}.
 * @returns `baseMs * maxFactor`.
 */
export function loadCeilingMs(baseMs: number, maxFactor: number = LOAD_SCALE_MAX): number {
  return baseMs * maxFactor;
}
