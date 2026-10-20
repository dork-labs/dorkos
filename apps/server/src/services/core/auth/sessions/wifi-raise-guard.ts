/**
 * From Wi-Fi, permissions may go down, never up (DOR-3037; plan
 * `2026-10-accounts-and-devices`).
 *
 * A turn started from Wi-Fi runs at the runtime's default at most
 * (`./wifi-turn-ceiling.ts`). A Wi-Fi sign-in that could raise a chat's mode, a
 * schedule's mode, an agent's permissions, the preset or a Files & commands
 * stop would undo that for every turn started anywhere else. So each of those
 * writes is allowed from Wi-Fi only when it tightens or keeps the level, and is
 * otherwise refused with {@link WIFI_RAISE_REFUSAL}. Pausing, Careful and Deny
 * always tighten, so they stay allowed.
 *
 * "Looser" is the product's own ordering, never a second one: modes by
 * `isNoLooserThan` on their declared levels, permission states and stops by
 * the ranks the arriving-agent screen uses (`STATE_RANK`, `STOP_RANK`). Where a
 * write's result cannot be told, it counts as a raise.
 *
 * @module services/core/auth/sessions/wifi-raise-guard
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  isNoLooserThan,
  levelOfMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import {
  presetTableFor,
  type AgentPermissionsResponse,
  type PermissionPreset,
  type PermissionState,
  type PermissionsResponse,
} from '@dorkos/shared/permissions';
import { STATE_RANK, STOP_RANK } from '../../permissions/arrival-narrowing.js';
import { NOT_FROM_WIFI } from './wifi-level.js';

/** What a Wi-Fi sign-in reads when a write would raise permissions. */
export const WIFI_RAISE_REFUSAL = 'Raising permissions works only at this computer.';

/** What a Wi-Fi sign-in reads when it tries to undo a permission change. */
export const WIFI_UNDO_REFUSAL = 'Undo permission changes at this computer.';

/** The refusal body for a raise from Wi-Fi. */
export function wifiRaiseRefusal(): { error: string; code: typeof NOT_FROM_WIFI } {
  return { error: WIFI_RAISE_REFUSAL, code: NOT_FROM_WIFI };
}

/**
 * Whether moving from one mode to another raises the level: the new mode asks
 * less often or reaches further, or is Auto where the old one was not. An id
 * the runtime does not declare counts as a raise.
 *
 * @param declared - The runtime's declared modes.
 * @param from - The mode now; `null` or absent reads as the runtime's default.
 * @param to - The mode asked for.
 */
export function modeRaises(
  declared: DeclaredModes,
  from: string | null | undefined,
  to: string
): boolean {
  const before = levelOfMode(declared, from ?? declared.default);
  const after = levelOfMode(declared, to);
  if (!before || !after) return true;
  if (!isNoLooserThan(before, after)) return true;
  return after.auto === true && before.auto !== true && before.asks !== 'never';
}

/**
 * Whether a permission state moves looser. An unknown result is a raise.
 *
 * @param before - The state now.
 * @param after - The state after the write, or `undefined` when it cannot be told.
 */
export function stateRaises(before: PermissionState, after: PermissionState | undefined): boolean {
  return after === undefined || STATE_RANK[after] < STATE_RANK[before];
}

/**
 * Whether a Files & commands stop moves looser. `null` before means the
 * runtime decides, read as the strictest; `null` after reads as the loosest,
 * so only a change to Ask first is certain from there.
 *
 * @param before - The stop now.
 * @param after - The stop after the write.
 */
export function stopRaises(before: PermissionStop | null, after: PermissionStop | null): boolean {
  return STOP_RANK[after ?? 'autonomy'] < STOP_RANK[before ?? 'ask'];
}

/** The part of a permission write the guard reads. `null` removes a change. */
export interface PermissionPatchInput {
  areas?: Record<string, PermissionState | null>;
  actions?: Record<string, PermissionState | null>;
  applyToAgents?: readonly string[];
  filesAndCommands?: PermissionStop | null;
}

type AreaView = Pick<PermissionsResponse['areas'][number], 'id' | 'resolved' | 'actions'>;

/** Every area and action key a patch names that would end up looser. */
function patchRaises(
  patch: PermissionPatchInput,
  areas: readonly AreaView[],
  afterRemoved: (areaId: string) => PermissionState | undefined
): boolean {
  // Bringing agents along clears their own settings, which can be stricter.
  if ((patch.applyToAgents?.length ?? 0) > 0) return true;
  for (const [id, next] of Object.entries(patch.areas ?? {})) {
    const area = areas.find((entry) => entry.id === id);
    if (!area) return true;
    if (stateRaises(area.resolved.state, next ?? afterRemoved(id))) return true;
  }
  const actions = areas.flatMap((area) => area.actions);
  for (const [id, next] of Object.entries(patch.actions ?? {})) {
    const action = actions.find((entry) => entry.id === id);
    // Removing an action's own setting falls back to a level read elsewhere.
    if (!action || next === null) return true;
    if (stateRaises(action.resolved.state, next)) return true;
  }
  return false;
}

/**
 * Whether a change to everyone's defaults would raise anything.
 *
 * @param patch - The write.
 * @param overview - The defaults as they stand.
 */
export function defaultsPatchRaises(
  patch: PermissionPatchInput,
  overview: Pick<PermissionsResponse, 'areas' | 'preset'>
): boolean {
  const table = presetTableFor(overview.preset);
  return patchRaises(
    patch,
    overview.areas,
    (id) => (table.areas as Record<string, PermissionState>)[id]
  );
}

/**
 * Whether a change to one agent's own settings would raise anything.
 *
 * @param patch - The write.
 * @param agent - The agent's settings as they stand.
 */
export function agentPatchRaises(
  patch: PermissionPatchInput,
  agent: Pick<AgentPermissionsResponse, 'areas' | 'filesAndCommands'>
): boolean {
  if (patch.filesAndCommands !== undefined) {
    const files = agent.filesAndCommands;
    const after = patch.filesAndCommands ?? files.inherited.stop;
    if (stopRaises(files.stop, after)) return true;
  }
  return patchRaises(
    patch,
    agent.areas,
    (id) => agent.areas.find((area) => area.id === id)?.inherited.state
  );
}

/**
 * Whether choosing a preset could raise anything. Only Careful, with no agents
 * brought along, is certain not to: moving into it keeps every Blocked and
 * never loosens (DOR-2739).
 *
 * @param preset - The preset asked for.
 * @param applyToAgents - The agents brought along, if any.
 */
export function presetRaises(
  preset: PermissionPreset,
  applyToAgents: readonly string[] | undefined
): boolean {
  return preset !== 'careful' || (applyToAgents?.length ?? 0) > 0;
}

/** The runtime keys that hold their own Files & commands stop in the config. */
const RUNTIME_STOP_KEYS = ['claudeCode', 'codex', 'opencode', 'doe'] as const;

/** A runtimes section, as stored or as patched: only the stops are read. */
type RuntimesStops = {
  defaultTrustStop?: PermissionStop | null;
} & Partial<
  Record<(typeof RUNTIME_STOP_KEYS)[number], { defaultTrustStop?: PermissionStop | null }>
>;

/**
 * Whether a settings patch would loosen a Files & commands stop: everyone's,
 * or one runtime's own (which falls back to everyone's when unset).
 *
 * @param patch - The settings patch, as sent.
 * @param stored - The `runtimes` section as it stands.
 */
export function trustStopPatchRaises(patch: unknown, stored: RuntimesStops | undefined): boolean {
  const runtimes = (patch as { runtimes?: unknown } | null)?.runtimes;
  if (typeof runtimes !== 'object' || runtimes === null) return false;
  const next = runtimes as RuntimesStops;
  const globalBefore = stored?.defaultTrustStop ?? 'autonomy';
  const globalAfter =
    'defaultTrustStop' in next ? (next.defaultTrustStop ?? 'autonomy') : globalBefore;
  if (stopRaises(globalBefore, globalAfter)) return true;
  return RUNTIME_STOP_KEYS.some((key) => {
    const before = stored?.[key]?.defaultTrustStop ?? globalBefore;
    const own = next[key];
    const after =
      own && 'defaultTrustStop' in own
        ? (own.defaultTrustStop ?? globalAfter)
        : (stored?.[key]?.defaultTrustStop ?? globalAfter);
    return stopRaises(before, after);
  });
}
