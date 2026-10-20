/**
 * What an arriving agent's own settings may keep (spec `agent-permissions`,
 * review D1): only what is STRICTLY stricter than the defaults it would
 * otherwise follow. An entry equal to the default is dropped too, so the agent
 * inherits that setting and follows it when the default moves. Pure, so the
 * screen that writes the file back and the reader that stands in until it has
 * decide identically.
 *
 * @module services/core/permissions/arrival-narrowing
 */
import {
  PERMISSION_AREA_IDS,
  resolvePermission,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionChange,
  type PermissionConfigInput,
  type PermissionState,
} from '@dorkos/shared/permissions';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type { CapabilityTier } from '@dorkos/shared/capabilities';

/** What the narrowing needs to know about one action. */
export interface NarrowingAction {
  tier: CapabilityTier;
  area: PermissionAreaId | null;
  alwaysAsks?: true;
}

/** The defaults an arriving agent's settings are compared with. */
export interface NarrowingContext {
  config: PermissionConfigInput;
  /** Every action by id. */
  actions: ReadonlyMap<string, NarrowingAction>;
  /** The Files & commands stop everyone has, or `null` when none is set. */
  globalStop: PermissionStop | null;
  /**
   * Every per-runtime Files & commands stop that is set (DOR-3107). An agent's
   * own stop beats all of them, so an agent's file may only keep a stop no
   * looser than the strictest of these and the global one.
   */
  runtimeStops?: readonly PermissionStop[];
}

/** One dropped setting, before it is given a target. */
export type DroppedKey = Pick<PermissionChange, 'key' | 'before'>;

/** How strict a permission state is: a higher rank asks more, or refuses. */
export const STATE_RANK: Readonly<Record<PermissionState, number>> = {
  allowed: 0,
  ask: 1,
  blocked: 2,
};
/** How strict a Files & commands stop is: a higher rank asks more often. */
export const STOP_RANK: Readonly<Record<PermissionStop, number>> = { autonomy: 0, act: 1, ask: 2 };

/**
 * Narrow an arriving agent's settings to what is strictly stricter than the
 * defaults.
 *
 * @param stored - The settings its folder's file holds.
 * @param context - The defaults and the action catalog.
 * @returns What it keeps (`undefined` for nothing) and every key it dropped.
 *   An unknown action's entry is kept unless it is Allowed, since dropping a
 *   stricter one could only widen the agent.
 */
export function narrowArrivedPermissions(
  stored: AgentPermissions | undefined,
  context: NarrowingContext
): { kept: AgentPermissions | undefined; dropped: DroppedKey[]; droppedUnknown: boolean } {
  const kept: AgentPermissions = {};
  const dropped: DroppedKey[] = [];
  let droppedUnknown = false;
  if (!stored) return { kept: undefined, dropped, droppedUnknown };
  const { config } = context;

  for (const [area, state] of Object.entries(stored.areas ?? {})) {
    if (!(PERMISSION_AREA_IDS as readonly string[]).includes(area)) continue;
    const areaId = area as PermissionAreaId;
    const baseline = resolvePermission({ area: areaId, tier: 'act', config }).state;
    if (STATE_RANK[state] > STATE_RANK[baseline]) {
      kept.areas = { ...kept.areas, [areaId]: state };
    } else {
      dropped.push({ key: { kind: 'area', area: areaId }, before: state });
    }
  }

  for (const [id, state] of Object.entries(stored.actions ?? {})) {
    const info = context.actions.get(id);
    if (!info?.area) {
      if (state === 'allowed') droppedUnknown = true;
      else kept.actions = { ...kept.actions, [id]: state };
      continue;
    }
    const baseline = resolvePermission({
      area: info.area,
      actionId: id,
      tier: info.tier,
      config,
      ...(info.alwaysAsks ? { alwaysAsks: true } : {}),
    }).state;
    if (STATE_RANK[state] > STATE_RANK[baseline]) {
      kept.actions = { ...kept.actions, [id]: state };
    } else {
      dropped.push({ key: { kind: 'action', action: id, area: info.area }, before: state });
    }
  }

  if (stored.filesAndCommands) {
    // With no stop set for everyone the runtime decides, so only Ask first is
    // certainly stricter than whatever that is.
    const stricter = context.globalStop
      ? STOP_RANK[stored.filesAndCommands] > STOP_RANK[context.globalStop]
      : stored.filesAndCommands === 'ask';
    if (stricter) kept.filesAndCommands = stored.filesAndCommands;
    else dropped.push({ key: { kind: 'files' }, before: stored.filesAndCommands });
  }

  const empty = !kept.areas && !kept.actions && !kept.filesAndCommands;
  return { kept: empty ? undefined : kept, dropped, droppedUnknown };
}

/** The stricter of two states. */
function stricterState(a: PermissionState, b: PermissionState): PermissionState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

/**
 * Key by key, the STRICTER of an agent's own settings file and what a person
 * last set for it (DOR-3107). A key either side leaves out stands at its
 * default. The file can tighten the agent, never loosen it past the person's
 * value: an agent that writes Full autonomy into its own file still runs at
 * whatever a person chose.
 *
 * A result equal to the default is left out unless one side set it outright,
 * so the agent keeps following a default it never overrode.
 *
 * @param file - The settings the agent's folder holds.
 * @param floor - What a person last set, or `undefined` for the defaults.
 * @param context - The defaults and the action catalog.
 * @returns The settings every reader acts on, or `undefined` for none.
 */
export function stricterPermissions(
  file: AgentPermissions | undefined,
  floor: AgentPermissions | undefined,
  context: NarrowingContext
): AgentPermissions | undefined {
  const out: AgentPermissions = {};
  const { config } = context;

  const areas = new Set([...Object.keys(file?.areas ?? {}), ...Object.keys(floor?.areas ?? {})]);
  for (const area of areas) {
    if (!(PERMISSION_AREA_IDS as readonly string[]).includes(area)) continue;
    const areaId = area as PermissionAreaId;
    const base = resolvePermission({ area: areaId, tier: 'act', config }).state;
    const a = file?.areas?.[areaId];
    const b = floor?.areas?.[areaId];
    const result = stricterState(a ?? base, b ?? base);
    if (result === a || result === b) out.areas = { ...out.areas, [areaId]: result };
  }

  const actions = new Set([
    ...Object.keys(file?.actions ?? {}),
    ...Object.keys(floor?.actions ?? {}),
  ]);
  for (const id of actions) {
    const a = file?.actions?.[id];
    const b = floor?.actions?.[id];
    const info = context.actions.get(id);
    let result: PermissionState | undefined;
    if (info?.area) {
      const base = resolvePermission({
        area: info.area,
        actionId: id,
        tier: info.tier,
        config,
        ...(info.alwaysAsks ? { alwaysAsks: true } : {}),
      }).state;
      result = stricterState(a ?? base, b ?? base);
    } else if (a && b) {
      result = stricterState(a, b);
    } else {
      // An action the catalog does not know has no default to compare with:
      // keep a one-sided entry only when it cannot widen the agent.
      const only = (a ?? b)!;
      result = only === 'allowed' ? undefined : only;
    }
    if (result && (result === a || result === b)) {
      out.actions = { ...out.actions, [id]: result };
    }
  }

  const a = file?.filesAndCommands;
  const b = floor?.filesAndCommands;
  let files: PermissionStop | undefined;
  if (a && b) files = STOP_RANK[a] >= STOP_RANK[b] ? a : b;
  // What a person set always stands: an agent deleting it never loosens it.
  else if (b) files = b;
  // The agent's own value, with no person's beside it, beats every server
  // stop, so it stands only when it is no looser than the strictest of them.
  // With none set at all the runtime decides, and only Ask first is surely no
  // looser than whatever that is.
  else if (a) {
    const stops = [
      ...(context.globalStop ? [context.globalStop] : []),
      ...(context.runtimeStops ?? []),
    ];
    const strictest = stops.reduce<PermissionStop | null>(
      (acc, stop) => (acc === null || STOP_RANK[stop] > STOP_RANK[acc] ? stop : acc),
      null
    );
    files = strictest
      ? STOP_RANK[a] >= STOP_RANK[strictest]
        ? a
        : undefined
      : a === 'ask'
        ? a
        : undefined;
  }
  if (files) out.filesAndCommands = files;

  const empty = !out.areas && !out.actions && !out.filesAndCommands;
  return empty ? undefined : out;
}
