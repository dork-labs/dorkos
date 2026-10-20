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
import type { SessionSettings } from '@dorkos/shared/schemas';
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

/** The settings a moved session copies: preference and power, never anything else. */
export type CarriedSettings = Pick<SessionSettings, 'model' | 'effort' | 'permissionMode'>;

/**
 * The settings row a carried-over session starts with (spec D9 step 4c): on the
 * same runtime, the source's model (unless one was chosen), effort and mode, so
 * it has no more power than the session it continues; on ANOTHER runtime, only
 * a chosen model, and the source's stop capped at `act` in the target's
 * vocabulary ({@link crossRuntimePermissionMode}). The one computation every
 * move writes, so no mover has its own idea of power.
 *
 * @param source - The source session's stored settings.
 * @param opts.model - A model chosen for the new session.
 * @param opts.crossRuntime - Both runtimes' declared modes, for a move across runtimes.
 */
export function carriedSettings(
  source: CarriedSettings,
  opts: {
    model?: string;
    crossRuntime?: {
      source: DeclaredPermissionModes | undefined;
      target: DeclaredPermissionModes | undefined;
    };
  }
): CarriedSettings {
  if (opts.crossRuntime) {
    const permissionMode = crossRuntimePermissionMode(
      source.permissionMode,
      opts.crossRuntime.source,
      opts.crossRuntime.target
    );
    return {
      ...(opts.model ? { model: opts.model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
  const model = opts.model ?? source.model;
  return {
    ...(model ? { model } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
    ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
  };
}

/**
 * The settings row a room seat moved to a fresh session starts with: the old
 * seat's, through {@link carriedSettings}. A stored mode always wins: it is the
 * level a person set, or the one the seat was seeded with. When the old seat
 * stored none, the mode is PINNED to the one it actually ran at, `ranAt` (what
 * the room's unattended resolver gives its agent: the agent's own Files &
 * commands stop, else the operator's level), and only when that is unknown to
 * the runtime's own default. Left unset, the room's first-turn seed would decide
 * the new seat's power instead.
 *
 * @param source - The old seat's stored settings, or `null` for no row.
 * @param declared - The runtime's declared modes.
 * @param ranAt - The mode the old seat ran at with no stored mode, or
 *   `undefined` when nothing is configured.
 */
export function reseatSettings(
  source: CarriedSettings | null,
  declared: DeclaredPermissionModes | undefined,
  ranAt?: string
): CarriedSettings {
  const carried = carriedSettings(source ?? {}, {});
  const permissionMode = carried.permissionMode ?? ranAt ?? declared?.default;
  return { ...carried, ...(permissionMode ? { permissionMode } : {}) };
}
