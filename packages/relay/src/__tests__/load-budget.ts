/**
 * One wall-clock budget helper for the two relay suites that drive a real
 * filesystem watcher.
 *
 * Both of them wait for something the PLATFORM has to do — deliver a `add`,
 * `change` or `unlink` event — and both had fixed millisecond ceilings on that
 * wait. A fixed ceiling is a claim about how fast the machine is, and this repo
 * is routinely running several agents' suites at once: at a load average of
 * 40-166 the same delivery that takes a fraction of a second alone takes tens of
 * seconds, so the ceiling fired on a healthy watcher and ejected branches that
 * had touched no watcher code at all (DOR-2012).
 *
 * @module __tests__/load-budget
 */
import os from 'node:os';

/**
 * A budget widened by how busy the machine is.
 *
 * This can only ever make a test WAIT longer, never assert less: every caller
 * uses it as a ceiling on waiting for an event, so the wait still ends the
 * instant the event arrives, and an event that never arrives still reds — just
 * later. The clamp keeps a genuinely broken watcher from taking minutes to say
 * so; four times the base covers the worst run measured here (98s against a 30s
 * budget, 3.3x).
 *
 * The load average is sampled at the moment of the call, which for the constants
 * below is module load — the suite that follows runs under roughly that load.
 *
 * @param baseMs - The budget a quiet machine needs.
 * @returns `baseMs` multiplied by the per-core load average, clamped to 1x-4x.
 */
export function loadScaledMs(baseMs: number): number {
  const perCore = os.loadavg()[0] / Math.max(1, os.cpus().length);
  return Math.round(baseMs * Math.min(4, Math.max(1, perCore)));
}
