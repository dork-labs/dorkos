/**
 * The settable-live half of the relaunch pin list: what a warm process can be
 * moved to without being replaced, and the one call a dispatch makes to find
 * out (spec `persistent-session-runtime` §4.5, task 3.5).
 *
 * Four of the thirteen pins are settable on a live query — `model`,
 * `permissionMode`, `mcpServers` and `plugins` — and this is where they are
 * set. The other nine replace the process; {@link prepareDispatch} says which
 * of the two a dispatch is looking at, and task 3.10 wires the teardown and
 * relaunch behind it.
 *
 * ## The account is checked here too, on purpose
 *
 * {@link compareLaunchFingerprints} already refuses to answer `reuse` across
 * accounts, so this second check is redundant on every path that goes through
 * it. It stays because it is the last thing standing between a hand-built plan
 * — a future refactor, a caller that assembles the decision itself — and a
 * dispatch running on another client's subscription. Redundant checks are cheap;
 * this one is two string compares.
 *
 * @module services/runtimes/claude-code/sessions/launch-live-settings
 */
import { logger } from '../../../../lib/logger.js';
import {
  AccountPinViolationError,
  accountsMatch,
  compareLaunchFingerprints,
  type DispatchDecision,
  type LaunchFingerprint,
  type ReuseDecision,
} from './launch-fingerprint.js';
import type { PumpControlQuery } from './session-pump-contract.js';

/**
 * May the next dispatch ride the live process, and what has to change first?
 *
 * The whole of task 3.5's answer in one call: capture a fingerprint for the
 * launch this dispatch WOULD do, hand it here with the live process's own, and
 * either apply the returned live changes ({@link applyLiveChanges}) or reap and
 * relaunch before the turn opens.
 *
 * @param live - What the running process was launched with
 * @param wanted - What this dispatch would launch with today
 * @returns `reuse` with the live changes to apply, or `relaunch` with the pins
 *   that moved and a log-safe reason
 */
export function prepareDispatch(
  live: LaunchFingerprint,
  wanted: LaunchFingerprint
): DispatchDecision {
  return compareLaunchFingerprints(live, wanted);
}

/**
 * Move a warm process onto the dispatch's live-settable values.
 *
 * Every setter is awaited: a control request that was fired and not waited for
 * can still be in flight when the turn opens, and a turn that starts on the old
 * model is exactly the staleness this list exists to prevent. The four run
 * concurrently because they are independent of each other.
 *
 * @param query - The live process's control channel (`SessionPump.controlQuery`)
 * @param decision - A reuse decision from {@link prepareDispatch}
 * @throws AccountPinViolationError When the decision spans two Claude accounts.
 *   Nothing is set: the process is left exactly as it was.
 */
export async function applyLiveChanges(
  query: PumpControlQuery,
  decision: ReuseDecision
): Promise<void> {
  if (!accountsMatch(decision.from.account, decision.to.account)) {
    throw new AccountPinViolationError(decision.from.account, decision.to.account);
  }
  if (decision.liveChanges.length === 0) return;
  await Promise.all(
    decision.liveChanges.map(async (change) => {
      switch (change.pin) {
        case 'model':
          await query.setModel(change.model);
          return;
        case 'permissionMode':
          await query.setPermissionMode(change.mode);
          return;
        case 'mcpServers':
          await query.setMcpServers(change.servers);
          return;
        case 'plugins':
          // `reloadPlugins` re-reads the plugin set from disk rather than taking
          // a list, which is why the marketplace's install pipeline already
          // drives it this way (`claude-code-runtime.ts`).
          await query.reloadPlugins();
          return;
      }
    })
  );
  logger.debug('[launch-fingerprint] moved a warm process onto new settings', {
    changed: decision.liveChanges.map((change) => change.pin),
  });
}
