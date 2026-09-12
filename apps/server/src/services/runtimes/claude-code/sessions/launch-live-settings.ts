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
  requestWithinBound,
  LIVE_SETTING_ACK_TIMEOUT_MS,
  PLUGIN_RELOAD_ACK_TIMEOUT_MS,
  type ControlAck,
} from './bounded-control.js';
import {
  logCacheImpactMeasurement,
  readCacheImpact,
  type PluginReloadCacheImpact,
} from '../messaging/plugin-reload-policy.js';
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

/** Why a live pin stayed where it was. */
export type UnappliedReason =
  /** The CLI said no. */
  | 'refused'
  /** Nothing came back inside the bound. */
  | 'unacked'
  /**
   * The CLI declined to apply a plugin reload because the conversation's prompt
   * cache depends on the tool list, and this dispatch chose to wait rather than
   * rebuild it (spec `plugin-reload-cache-cost`).
   *
   * Unlike the other two, this one is a DorkOS decision rather than a failure.
   * Leaving the pin stale is what makes the next dispatch ask again, and the
   * first ask the runtime answers `held: false` applies the reload for free.
   * That alone would never end on a session that dispatches all afternoon, so
   * the hold is also REPORTED
   * ({@link LiveChangeOptions.onPluginReloadHeld}) and joins the same ceiling
   * every other hold is under (`messaging/plugin-reload-policy.ts`).
   */
  | 'held';

/** One live pin the CLI did not move onto, and which kind of no it was. */
export interface UnappliedPin {
  /** The pin that stayed where it was. */
  readonly pin: LivePin;
  /** Which kind of no it was. */
  readonly ack: UnappliedReason;
}

/** Extra decisions a dispatch can hand {@link applyLiveChanges}. */
export interface LiveChangeOptions {
  /**
   * Ask the CLI what a plugin reload would disturb, and wait rather than pay
   * when it says the cache depends on the tool list.
   *
   * The caller decides this, because only it knows how big the conversation is
   * — `pluginReloadIsWorthHolding` reads that number. Left off, the reload is
   * applied unconditionally, which is what every path did before the check
   * existed.
   */
  readonly holdPluginReloadWhenCacheWarm?: boolean;
  /** The session this dispatch belongs to, so the measurement log names it. */
  readonly sessionId?: string;
  /** How big the conversation is, for the same log — the number the threshold read. */
  readonly contextTokens?: number;
  /**
   * Told when a plugin reload was held, so somebody can put a ceiling on the
   * waiting.
   *
   * This path's own recovery is only "the next dispatch asks again", which
   * never ends on a session that dispatches all afternoon — and the `plugins`
   * pin moves without an install behind it (a scope change, an agent change, an
   * uninstall), so there is not always a fan-out hold already running to bound
   * it. Reporting the hold is how it joins one.
   */
  readonly onPluginReloadHeld?: (impact: PluginReloadCacheImpact) => void;
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

/** How one pin's setter came out: an ack, or a reason it stayed put. */
type PinOutcome = ControlAck | UnappliedReason;

/**
 * Move the `plugins` pin, asking what it would cost first when the caller said
 * to.
 *
 * The plain path is unchanged: one bounded `reloadPlugins()`, applied whatever
 * the conversation costs. The asking path needs the ANSWER and not just an ack,
 * so it goes through {@link requestWithinBound} rather than
 * {@link awaitControlAck}, and reports a hold as its own kind of no.
 *
 * The check is logged whichever way it goes, because measuring how often a
 * reload is free is how the threshold behind it stops being a guess.
 *
 * @param query - The live process's control channel
 * @param options - Whether this dispatch may wait rather than pay
 * @returns `acked` when the process took the new plugin set, `held` when it
 *   chose to wait, or the failure that stopped it
 */
async function reloadPluginsPin(
  query: PumpControlQuery,
  options: LiveChangeOptions | undefined
): Promise<PinOutcome> {
  if (!options?.holdPluginReloadWhenCacheWarm) {
    return awaitControlAck(() => query.reloadPlugins(), PLUGIN_RELOAD_ACK_TIMEOUT_MS);
  }
  try {
    const result = await requestWithinBound(
      () => query.reloadPlugins({ holdOnCacheImpact: true }),
      PLUGIN_RELOAD_ACK_TIMEOUT_MS,
      'reloadPlugins'
    );
    const held = result.held === true;
    const impact = held ? readCacheImpact(result.cache_impact) : undefined;
    logCacheImpactMeasurement({
      sessionId: options.sessionId ?? 'unknown-session',
      held,
      contextTokens: options.contextTokens,
      impact,
    });
    if (held && impact) options.onPluginReloadHeld?.(impact);
    return held ? 'held' : 'acked';
  } catch {
    // An ask nobody answered is reported as unacked, NOT retried with a plain
    // reload. A second bounded call here would stack a second 8 s budget onto a
    // path a person is already waiting on with their message unsent — sixteen
    // seconds of a send that looks like it did nothing. It costs nothing to
    // decline: an unapplied pin is left stale, which is exactly what brings the
    // next dispatch back to try again, and the CLI that did not answer this
    // round trip would not have answered the next one either.
    return 'unacked';
  }
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
 * These bounds are a USER-FACING budget, not a background one: this call sits
 * between pressing send and the turn opening. The four run concurrently, so the
 * worst case is the largest bound and not their sum — today 8 s
 * (`PLUGIN_RELOAD_ACK_TIMEOUT_MS`), which is how long a message can appear to do
 * nothing before it starts. Anyone raising that number is spending it here, and
 * that is also why the plugin pin's cost check does not retry: one round trip
 * per pin per dispatch, whatever it answers ({@link reloadPluginsPin}).
 *
 * @param query - The live process's control channel (`SessionPump.controlQuery`)
 * @param decision - A reuse decision from {@link prepareDispatch}
 * @param options - Whether a plugin reload may wait for a cheaper moment
 * @returns Which pins moved, which did not, and the fingerprint the process now holds
 * @throws AccountPinViolationError When the decision spans two Claude accounts.
 *   Nothing is set: the process is left exactly as it was.
 */
export async function applyLiveChanges(
  query: PumpControlQuery,
  decision: ReuseDecision,
  options?: LiveChangeOptions
): Promise<LiveChangeOutcome> {
  if (!accountsMatch(decision.from.account, decision.to.account)) {
    throw new AccountPinViolationError(decision.from.account, decision.to.account);
  }
  if (decision.liveChanges.length === 0) {
    return { applied: [], unapplied: [], fingerprint: decision.to };
  }
  const results = await Promise.all(
    decision.liveChanges.map(async (change): Promise<{ pin: LivePin; ack: PinOutcome }> => {
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
          return { pin: change.pin, ack: await reloadPluginsPin(query, options) };
      }
    })
  );
  const applied = results.filter((r) => r.ack === 'acked').map((r) => r.pin);
  const unapplied = results
    .filter((r): r is { pin: LivePin; ack: UnappliedReason } => r.ack !== 'acked')
    .map(({ pin, ack }) => ({ pin, ack }));
  // A hold is a DECISION, not a failure — DorkOS asked the CLI to wait — so an
  // outcome whose only unapplied pin was held says so at debug. Warning about
  // it would train a reader to ignore the line that means a setter really did
  // go missing.
  const failures = unapplied.filter((u) => u.ack !== 'held');
  if (failures.length > 0) {
    logger.warn('[launch-fingerprint] a warm process did not take every new setting', {
      applied,
      unapplied,
    });
  } else if (unapplied.length > 0) {
    logger.debug('[launch-fingerprint] a warm process is waiting to take its new plugins', {
      applied,
    });
  } else {
    logger.debug('[launch-fingerprint] moved a warm process onto new settings', {
      changed: applied,
    });
  }
  return { applied, unapplied, fingerprint: fingerprintAfter(decision, unapplied) };
}
