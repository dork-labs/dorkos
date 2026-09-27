/**
 * How much power a session carried over to ANOTHER runtime starts with (spec
 * `claude-account-fleet` D9 "Endpoints", step 4c): never more than the source.
 *
 * A mode id is not portable (`acceptEdits` on Claude Code stops before a
 * command; on Codex it runs commands unprompted), so the answer travels as a
 * trust stop, never as an id:
 *
 * 1. the source mode is read as its stop through the SOURCE runtime's profile
 *    (a mode the profile does not declare reads as `ask`);
 * 2. the stop is capped at `act`: autonomy and bypass are never carried across
 *    runtimes, because the consent behind them was given for one runtime;
 * 3. the target mode is the one the TARGET runtime's profile puts at that stop,
 *    else the target's most restrictive trust mode.
 *
 * Pure: both profiles are inputs.
 *
 * @module services/session/fleet/carry-over-power
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  resolveStopMode,
  resolveTrustStops,
  type DeclaredPermissionModes,
} from '@dorkos/shared/permission-semantics';

/** The highest stop a cross-runtime carry-over may start at. */
export const CROSS_RUNTIME_STOP_CAP: PermissionStop = 'act';

/**
 * The trust stop a source mode stands at, capped for a cross-runtime move.
 *
 * @param sourceMode - The source session's stored mode, or undefined for none.
 * @param source - The source runtime's declared modes.
 */
export function carriedStop(
  sourceMode: string | undefined,
  source: DeclaredPermissionModes | undefined
): PermissionStop {
  const id = sourceMode ?? source?.default;
  const stop = source?.values.find((d) => d.id === id)?.stop ?? 'ask';
  return stop === 'autonomy' ? CROSS_RUNTIME_STOP_CAP : stop;
}

/**
 * The mode a session carried over to another runtime starts at.
 *
 * @param sourceMode - The source session's stored mode, or undefined for none.
 * @param source - The source runtime's declared modes.
 * @param target - The target runtime's declared modes.
 * @returns The target mode id, or `undefined` when the target declares no
 *   trust mode at all (the caller then writes none).
 */
export function crossRuntimePermissionMode(
  sourceMode: string | undefined,
  source: DeclaredPermissionModes | undefined,
  target: DeclaredPermissionModes | undefined
): string | undefined {
  if (!target) return undefined;
  const stop = carriedStop(sourceMode, source);
  return resolveStopMode(stop, target.values) ?? resolveTrustStops(target.values)[0]?.mode.id;
}
