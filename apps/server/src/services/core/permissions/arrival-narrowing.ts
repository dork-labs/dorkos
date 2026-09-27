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
}

/** One dropped setting, before it is given a target. */
export type DroppedKey = Pick<PermissionChange, 'key' | 'before'>;

const STATE_RANK: Record<PermissionState, number> = { allowed: 0, ask: 1, blocked: 2 };
const STOP_RANK: Record<PermissionStop, number> = { autonomy: 0, act: 1, ask: 2 };

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
