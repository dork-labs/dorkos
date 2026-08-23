/**
 * How a pump's process is booted, and how the next dispatch decides whether it
 * may ride the one already running (spec `persistent-session-runtime` §4.5,
 * task 3.10).
 *
 * This is the launcher side of the pump seam. `SessionPump` is handed a live
 * query and never sees an `Options` object, so everything a launch is PINNED to
 * is resolved here — by the same `resolveLaunch` the resume-per-message path
 * uses, which is what makes the fingerprint comparison meaningful rather than a
 * comparison of one code path against itself.
 *
 * ## The plan is per DISPATCH, the launch is per PROCESS
 *
 * Every dispatch resolves a full plan: what it WOULD launch with today. Most of
 * them then ride a process that already exists, and the plan is spent only on
 * {@link decideProcessReuse}. The launch reads the plan of whichever dispatch
 * happened to find no process — which is why the launcher takes a getter rather
 * than a plan: the pump decides when to boot, inside `pump.dispatch`, and the
 * caller has already parked the current plan by then.
 *
 * ## `resuming` is deliberately not read
 *
 * {@link PumpLaunchInput.resuming} tells a launcher that this boot is a crash
 * recovery. It is not consulted, and that is the correct answer rather than an
 * omission: `resolveLaunch` sets `resume` from `session.hasStarted`, which is
 * already true for any session that has produced a turn — so a recovery
 * launch resumes for exactly the same reason, and by exactly the same code, as
 * every other launch of a started conversation. Branching on `resuming` would
 * add a second way to spell one decision.
 *
 * @module services/runtimes/claude-code/sessions/pump-launch
 */
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import type { AgentSession } from '../agent-types.js';
import { fireLaunchProbes } from '../messaging/launch-probes.js';
import type { MessageSenderOpts } from '../messaging/message-sender-shared.js';
import type { DispatchDecision, LaunchFingerprint } from './launch-fingerprint.js';
import { applyLiveChanges, prepareDispatch } from './launch-live-settings.js';
import type { PumpControlQuery, PumpLauncher, PumpQuery } from './session-pump-contract.js';

/** What one dispatch resolved: the turn's message, and the launch behind it. */
export interface PumpLaunchPlan {
  /** The working directory this turn runs in — the gate's value and the launch's. */
  effectiveCwd: string;
  /** The message as it reaches the model, context bag prepended (ADR-0273). */
  enrichedContent: string;
  /** The mesh agent this directory hosts, for `last_seen` stamping. */
  meshAgentId: string | undefined;
  /** Events the turn must yield before any SDK output. */
  statusEvents: StreamEvent[];
  /** Exactly the options a launch for this dispatch would use. */
  sdkOptions: Options;
  /** What such a launch would be pinned to. */
  fingerprint: LaunchFingerprint;
}

/**
 * Build the launcher for one session's pump.
 *
 * The returned function boots the process around the pump's held prompt and
 * hands the live query back to the caller, which is what every control path
 * that already exists — Stop, a live model change, a permission-mode switch —
 * eventually reaches. It does NOT publish that query on the session itself; see
 * the note in the body for why a process is not a turn.
 *
 * @param session - The session whose process this launches
 * @param opts - The runtime's ports, for the per-process capability probes
 * @param currentPlan - Reads the plan of the dispatch that triggered the boot
 * @param onLaunched - Told what the new process is and what it is pinned to, so
 *   the next dispatch has something to compare against and the turn has
 *   something to arm `session.activeQuery` with
 */
export function createPumpLauncher(
  session: AgentSession,
  opts: MessageSenderOpts,
  currentPlan: () => PumpLaunchPlan,
  onLaunched: (live: Query, fingerprint: LaunchFingerprint) => void
): PumpLauncher {
  return ({ sessionId, prompt }): PumpQuery => {
    const plan = currentPlan();
    const live = query({ prompt, options: plan.sdkOptions });
    // Deliberately NOT `session.activeQuery = live` here. That field means "a
    // turn is in flight" to every consumer in this runtime — `interruptQuery`
    // escalates to `close()` when `interrupt()` rejects, which on a warm idle
    // process destroys a healthy subprocess and marks the session crashed. A
    // process is not a turn, so the field is armed and disarmed by the pump's
    // own `running` edge instead (`persistent-dispatch.ts`).
    //
    // What this subprocess supports, asked once per PROCESS — the same probes
    // the resume path fires, for the same reason. Skipping them here would
    // leave a warm session's model cache, MCP snapshot, command palette and
    // subagent list empty for as long as it stayed warm.
    fireLaunchProbes(live, opts);
    onLaunched(live, plan.fingerprint);
    logger.debug('[pump-launch] booted a persistent process', {
      sessionId,
      cwd: plan.effectiveCwd,
      resume: session.hasStarted ? session.sdkSessionId : 'N/A',
    });
    return live;
  };
}

/** What a dispatch must do to the live process before its turn can open. */
export type ProcessReuse =
  /** Nothing: the process was launched with these values. */
  | { action: 'ride' }
  /**
   * Move the live process onto new values first — awaited, never fired blind.
   *
   * `apply` ANSWERS with the fingerprint to store for the process, because only
   * the call knows it: a setter that is refused or goes unanswered inside its
   * bound leaves its pin where it was (DOR-1301), and storing what the dispatch
   * wanted would leave DorkOS believing a stale process is current.
   */
  | { action: 'adjust'; apply: (query: PumpControlQuery) => Promise<LaunchFingerprint> }
  /** Replace the process: a pin the SDK cannot set live has moved. */
  | { action: 'replace'; reason: string };

/**
 * May this dispatch ride the process already running, and what has to change
 * first?
 *
 * A first launch is deliberately unmodeled by {@link prepareDispatch} — there is
 * no live fingerprint to compare against — so that case is answered here, before
 * the comparison, rather than by handing the comparator a fabricated baseline.
 *
 * @param live - What the running process was launched with, or `undefined` when
 *   this session holds no process yet
 * @param wanted - What this dispatch would launch with today
 */
export function decideProcessReuse(
  live: LaunchFingerprint | undefined,
  wanted: LaunchFingerprint
): ProcessReuse {
  // Nothing is running, so nothing can be stale. The launch that follows IS the
  // pinning event, and its fingerprint becomes the baseline.
  if (live === undefined) return { action: 'ride' };
  const decision: DispatchDecision = prepareDispatch(live, wanted);
  if (decision.action === 'relaunch') return { action: 'replace', reason: decision.reason };
  if (decision.liveChanges.length === 0) return { action: 'ride' };
  return {
    action: 'adjust',
    apply: async (control) => (await applyLiveChanges(control, decision)).fingerprint,
  };
}
