/**
 * How a turn's permission ceiling holds on a WARM Claude Code process (spec
 * `trusted-by-default-flip` §4; `official-community-space` D10).
 *
 * `turn-permission.ts` decides the mode one turn runs at, and the launch moves a
 * warm process to it through its fingerprint. A warm process outlives the turn,
 * so three things a per-turn decision cannot see are decided here:
 *
 * 1. **A ceiling the process did not take is not run on** ({@link ceilingMissed}).
 *    A live setter that went unanswered leaves the process on its old, looser
 *    mode; the dispatcher replaces the process instead of running the turn on it.
 * 2. **Background work keeps the ceiling of the turn that started it**
 *    ({@link carryCeiling}). A helper, Monitor or shell a stranger's turn started
 *    keeps asking the tool gate after that turn ended, so the gate
 *    (`gatePermissionMode`) keeps answering it at that ceiling while it may run.
 * 3. **Moving back up live while that work runs would raise it too**
 *    ({@link decideCeilingedReuse}). That move becomes a restart, through the
 *    same hold-or-restart door every other restart takes, so a caller that can
 *    wait holds for the work rather than ending it.
 *
 * @module services/runtimes/claude-code/warm-ceiling
 */
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { logger } from '../../../lib/logger.js';
import { CLAUDE_CODE_CAPABILITIES } from './runtime-constants.js';
import type { LaunchFingerprint } from './sessions/launch-fingerprint.js';
import type { LiveChangeOptions } from './sessions/launch-live-settings.js';
import { decideProcessReuse, type ProcessReuse } from './sessions/pump-launch.js';
import { bothCeilings } from './turn-permission.js';

/** The two ceilings a live session carries. */
interface CeilingedSession {
  /** This turn's ceiling, assigned on every send. */
  turnPermissionCeiling?: TurnPermissionCeiling;
  /** The ceiling background work from an earlier turn still runs under. */
  backgroundPermissionCeiling?: TurnPermissionCeiling;
}

/** Whether a warm process holds background work right now. */
interface QuietnessSource {
  quietness(): { quiet: boolean };
}

/**
 * {@link decideProcessReuse}, except that a live move to a mode looser than the
 * ceiling still-running background work carries is a restart instead.
 *
 * @param session - The live session's two ceilings.
 * @param pump - The warm process, asked whether it holds background work.
 * @param live - What the running process was launched with, or `undefined`.
 * @param wanted - What this dispatch would launch with today.
 * @param options - Passed through to {@link decideProcessReuse}.
 */
export function decideCeilingedReuse(
  session: CeilingedSession,
  pump: QuietnessSource,
  live: LaunchFingerprint | undefined,
  wanted: LaunchFingerprint,
  options?: LiveChangeOptions
): ProcessReuse {
  // A ceilinged turn never trusts the recorded mode: a person's live change
  // (`updateSession`) moves the process without moving its fingerprint, so the
  // mode is set again, and checked by `ceilingMissed`, on every such turn.
  const compared =
    live !== undefined && session.turnPermissionCeiling !== undefined
      ? { ...live, live: { ...live.live, permissionMode: undefined } }
      : live;
  const reuse = decideProcessReuse(compared, wanted, options);
  const carried = session.backgroundPermissionCeiling;
  const wantedMode = wanted.live.permissionMode;
  if (reuse.action !== 'adjust' || carried === undefined || live === undefined) return reuse;
  if (wantedMode === undefined || live.live.permissionMode === wantedMode) return reuse;
  if (pump.quietness().quiet) return reuse;
  // Moving down, or to a mode the carried ceiling still admits, raises nothing.
  const admitted = clampModeToCeiling(
    CLAUDE_CODE_CAPABILITIES.permissionModes,
    wantedMode,
    carried
  );
  if (admitted === wantedMode) return reuse;
  return {
    action: 'replace',
    reason: 'leaving a ceilinged turn while its background work runs',
    changed: ['permissionMode'],
  };
}

/**
 * Whether a ceilinged turn is about to run on a process that did not take its
 * mode. Logs the miss; the caller replaces the process.
 *
 * @param sessionId - The session, for the log line.
 * @param session - The live session's ceilings.
 * @param held - What the process holds after the live move.
 * @param wanted - What this turn asked for.
 */
export function ceilingMissed(
  sessionId: string,
  session: CeilingedSession,
  held: LaunchFingerprint,
  wanted: LaunchFingerprint
): boolean {
  if (session.turnPermissionCeiling === undefined) return false;
  if (held.live.permissionMode === wanted.live.permissionMode) return false;
  logger.warn('[warm-ceiling] a turn ceiling did not reach the warm process; replacing it', {
    session: sessionId,
    holds: held.live.permissionMode,
    wanted: wanted.live.permissionMode,
  });
  return true;
}

/**
 * The ceiling background work carries once this dispatch is decided: this
 * turn's own, together with whatever earlier ceilinged work may still be
 * running. A quiet process (a fresh one included) carries only this turn's.
 *
 * Set after the hold-or-restart decision, never before, so a turn that holds
 * for the work, or waits to restart, never clears it early.
 *
 * @param session - The live session's ceilings.
 * @param pump - The process this turn runs on.
 */
export function carryCeiling(
  session: CeilingedSession,
  pump: QuietnessSource
): TurnPermissionCeiling | undefined {
  const earlier = pump.quietness().quiet ? undefined : session.backgroundPermissionCeiling;
  return bothCeilings(session.turnPermissionCeiling, earlier);
}
