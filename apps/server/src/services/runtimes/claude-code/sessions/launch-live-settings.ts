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
  awaitControlAck,
  LIVE_SETTING_ACK_TIMEOUT_MS,
  PLUGIN_RELOAD_ACK_TIMEOUT_MS,
  type ControlAck,
} from './bounded-control.js';
import {
  AccountPinViolationError,
  accountsMatch,
  compareLaunchFingerprints,
  type DispatchDecision,
  type LaunchFingerprint,
  type LivePin,
  type LiveSettings,
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

/** One live pin the CLI did not move onto, and which kind of no it was. */
export interface UnappliedPin {
  /** The pin that stayed where it was. */
  readonly pin: LivePin;
  /** `refused` — the CLI said no. `unacked` — nothing came back inside the bound. */
  readonly ack: Exclude<ControlAck, 'acked'>;
}

/** What {@link applyLiveChanges} managed to do to a warm process. */
export interface LiveChangeOutcome {
  /** The pins the process is now confirmed to hold. */
  readonly applied: readonly LivePin[];
  /** The pins it does not, and why. Empty on the happy path. */
  readonly unapplied: readonly UnappliedPin[];
  /**
   * What the process actually holds now: the wanted fingerprint for every pin
   * that landed, and the OLD value for every pin that did not. The caller stores
   * this as the live process's fingerprint, so a setter that went unanswered
   * leaves the pin visibly stale and the next dispatch tries it again (or
   * relaunches) instead of riding a process it wrongly believes it moved.
   */
  readonly fingerprint: LaunchFingerprint;
}

/** A `LiveSettings` under construction. */
type MutableLiveSettings = { -readonly [K in keyof LiveSettings]: LiveSettings[K] };

/**
 * Put one pin back to the value the live process still holds.
 *
 * Generic in the key so the copy typechecks: `settings[pin] = from[pin]` is only
 * sound when both sides are read at the SAME key, which a `LivePin` union
 * variable cannot express.
 */
function keepOldValue<K extends LivePin>(
  settings: MutableLiveSettings,
  pin: K,
  from: LiveSettings
): void {
  settings[pin] = from[pin];
}

/** The fingerprint the process holds once `unapplied` pins are put back. */
function fingerprintAfter(
  decision: ReuseDecision,
  unapplied: readonly UnappliedPin[]
): LaunchFingerprint {
  if (unapplied.length === 0) return decision.to;
  const live: MutableLiveSettings = { ...decision.to.live };
  for (const { pin } of unapplied) keepOldValue(live, pin, decision.from.live);
  return { ...decision.to, live };
}

/**
 * Move a warm process onto the dispatch's live-settable values.
 *
 * Every setter is awaited: a control request that was fired and not waited for
 * can still be in flight when the turn opens, and a turn that starts on the old
 * model is exactly the staleness this list exists to prevent. The four run
 * concurrently because they are independent of each other.
 *
 * **Awaited, but not for ever (DOR-1301).** Each setter is a control request,
 * and a control request written to a stdin DorkOS has already ended is dropped
 * in silence by the SDK against a promise nothing will settle. Unbounded, one
 * such setter wedged the whole `Promise.all` and with it the dispatch — the
 * person's message never started, and no error ever said why. So each setter now
 * runs against its own clock, and this function's contract is
 * apply-what-answered rather than all-or-nothing: the pins that landed are
 * reported as applied, the pins that did not are reported as stale, and the turn
 * opens either way. Nothing here decides that a stale pin is acceptable; it
 * decides that the caller finds out, which the hang made impossible.
 *
 * @param query - The live process's control channel (`SessionPump.controlQuery`)
 * @param decision - A reuse decision from {@link prepareDispatch}
 * @returns Which pins moved, which did not, and the fingerprint the process now holds
 * @throws AccountPinViolationError When the decision spans two Claude accounts.
 *   Nothing is set: the process is left exactly as it was.
 */
export async function applyLiveChanges(
  query: PumpControlQuery,
  decision: ReuseDecision
): Promise<LiveChangeOutcome> {
  if (!accountsMatch(decision.from.account, decision.to.account)) {
    throw new AccountPinViolationError(decision.from.account, decision.to.account);
  }
  if (decision.liveChanges.length === 0) {
    return { applied: [], unapplied: [], fingerprint: decision.to };
  }
  const results = await Promise.all(
    decision.liveChanges.map(async (change): Promise<{ pin: LivePin; ack: ControlAck }> => {
      switch (change.pin) {
        case 'model':
          return {
            pin: change.pin,
            ack: await awaitControlAck(
              () => query.setModel(change.model),
              LIVE_SETTING_ACK_TIMEOUT_MS
            ),
          };
        case 'permissionMode':
          return {
            pin: change.pin,
            ack: await awaitControlAck(
              () => query.setPermissionMode(change.mode),
              LIVE_SETTING_ACK_TIMEOUT_MS
            ),
          };
        case 'mcpServers':
          return {
            pin: change.pin,
            ack: await awaitControlAck(
              () => query.setMcpServers(change.servers),
              PLUGIN_RELOAD_ACK_TIMEOUT_MS
            ),
          };
        case 'plugins':
          // `reloadPlugins` re-reads the plugin set from disk rather than taking
          // a list, which is why the marketplace's install pipeline already
          // drives it this way (`claude-code-runtime.ts`).
          return {
            pin: change.pin,
            ack: await awaitControlAck(() => query.reloadPlugins(), PLUGIN_RELOAD_ACK_TIMEOUT_MS),
          };
      }
    })
  );
  const applied = results.filter((r) => r.ack === 'acked').map((r) => r.pin);
  const unapplied = results
    .filter((r): r is { pin: LivePin; ack: Exclude<ControlAck, 'acked'> } => r.ack !== 'acked')
    .map(({ pin, ack }) => ({ pin, ack }));
  if (unapplied.length > 0) {
    logger.warn('[launch-fingerprint] a warm process did not take every new setting', {
      applied,
      unapplied,
    });
  } else {
    logger.debug('[launch-fingerprint] moved a warm process onto new settings', {
      changed: applied,
    });
  }
  return { applied, unapplied, fingerprint: fingerprintAfter(decision, unapplied) };
}
