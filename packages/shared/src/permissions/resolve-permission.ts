/**
 * The one resolution rule of the permission model: given an action, its area
 * and tier, the install's defaults and (optionally) the calling agent's own
 * overrides, what state applies and why (spec `agent-permissions` D4).
 *
 * Pure and I/O-free on purpose: the server gate, the tool-list builders and the
 * client's permissions pages all call the same function, so the switch a person
 * reads can never disagree with what the gate enforces.
 *
 * @module shared/permissions/resolve-permission
 */
import type { CapabilityTier } from '../capabilities.js';
import type { PermissionStop } from '../agent-runtime.js';
import { isFloorArea } from './permission-areas.js';
import { presetTableFor } from './permission-presets.js';
import {
  PERMISSION_STATES,
  type AgentPermissions,
  type PermissionAreaId,
  type PermissionOverrides,
  type PermissionPreset,
  type PermissionSource,
  type PermissionState,
} from './permission-schemas.js';

/** The answer the resolver gives: a state, and where it came from. */
export interface ResolvedPermission {
  /** The area the action belongs to. */
  area: PermissionAreaId;
  /** The state that applies. */
  state: PermissionState;
  /** The layer that decided (after the post-rules). */
  source: PermissionSource;
  /** The coarse answer every "why?" line starts from. */
  layer: 'agent' | 'default' | 'floor';
  /** True when the destructive rule turned an area-level Allowed into Ask. */
  destructiveAsk?: true;
}

/** The install-wide half of the model: the preset and the changes on top of it. */
export interface PermissionConfigInput {
  /** The chosen preset, or `null` for not chosen yet (Unchanged). */
  preset: PermissionPreset | null;
  /** The changes a person made on top of the preset. */
  defaults: PermissionOverrides;
}

/** Input to {@link resolvePermission}. */
export interface ResolvePermissionInput {
  /** The action's declared area. */
  area: PermissionAreaId;
  /** The capability id or hand-registered tool name. */
  actionId: string;
  /** The action's declared tier. */
  tier: CapabilityTier;
  /** The install's permission config. */
  config: PermissionConfigInput;
  /** The calling agent's overrides; absent for an unidentified caller. */
  agent?: AgentPermissions;
  /** A revoked or expired identity: always Blocked. */
  inactive?: boolean;
}

const AGENT_SOURCES: ReadonlySet<PermissionSource> = new Set(['agent-action', 'agent-area']);
const AREA_LEVEL_SOURCES: ReadonlySet<PermissionSource> = new Set([
  'agent-area',
  'default-area',
  'preset',
  'unchanged',
]);

/** True when `value` is one of the three states (guards a hand-edited file). */
function isState(value: unknown): value is PermissionState {
  return typeof value === 'string' && (PERMISSION_STATES as readonly string[]).includes(value);
}

/** Own-property read, so an id like `__proto__` never reaches the prototype. */
function own(
  record: Readonly<Record<string, PermissionState>> | undefined,
  key: string
): PermissionState | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  return isState(value) ? value : undefined;
}

/** The layer-6 answer: the preset table, or Unchanged while none is chosen. */
function fromPreset(input: ResolvePermissionInput): {
  state: PermissionState;
  source: PermissionSource;
  actionLevel: boolean;
} {
  const table = presetTableFor(input.config.preset);
  const source: PermissionSource = input.config.preset === null ? 'unchanged' : 'preset';
  const actionState = own(table.actions, input.actionId);
  if (actionState) return { state: actionState, source, actionLevel: true };
  return { state: table.areas[input.area], source, actionLevel: false };
}

/**
 * Resolve the permission state for one action.
 *
 * Precedence, first match wins: inactive identity, the agent's action entry,
 * the agent's area entry, the default action entry, the default area entry,
 * then the preset (or Unchanged). Then two post-rules: an area-level Allowed on
 * a destructive action becomes Ask, and Allowed in a floor area becomes Ask.
 *
 * @param input - The action, its area and tier, the config and the agent.
 */
export function resolvePermission(input: ResolvePermissionInput): ResolvedPermission {
  const { area, actionId, agent, config } = input;
  if (input.inactive) {
    return { area, state: 'blocked', source: 'inactive', layer: 'agent' };
  }

  let state: PermissionState;
  let source: PermissionSource;
  let actionLevel: boolean;

  const agentAction = own(agent?.actions, actionId);
  const agentArea = own(agent?.areas, area);
  const defaultAction = own(config.defaults.actions, actionId);
  const defaultArea = own(config.defaults.areas, area);
  if (agentAction) {
    [state, source, actionLevel] = [agentAction, 'agent-action', true];
  } else if (agentArea) {
    [state, source, actionLevel] = [agentArea, 'agent-area', false];
  } else if (defaultAction) {
    [state, source, actionLevel] = [defaultAction, 'default-action', true];
  } else if (defaultArea) {
    [state, source, actionLevel] = [defaultArea, 'default-area', false];
  } else {
    ({ state, source, actionLevel } = fromPreset(input));
  }

  let destructiveAsk: true | undefined;
  if (
    input.tier === 'destructive' &&
    state === 'allowed' &&
    !actionLevel &&
    AREA_LEVEL_SOURCES.has(source)
  ) {
    state = 'ask';
    destructiveAsk = true;
  }

  if (state === 'allowed' && isFloorArea(area)) {
    return { area, state: 'ask', source: 'floor', layer: 'floor' };
  }

  const layer = AGENT_SOURCES.has(source) ? 'agent' : 'default';
  return destructiveAsk
    ? { area, state, source, layer, destructiveAsk }
    : { area, state, source, layer };
}

/** Where a Files & commands stop came from. */
export type FilesAndCommandsSource = 'agent' | 'runtime' | 'default' | 'runtime-own';

/**
 * Resolve the Files & commands trust stop for one agent: the agent's own stop,
 * then the per-runtime default, then the global default, then the runtime's
 * own behaviour (`stop: null`).
 *
 * @param input - The agent's stop and the two stored defaults.
 */
export function resolveFilesAndCommands(input: {
  agent?: { filesAndCommands?: PermissionStop };
  perRuntime?: PermissionStop | null;
  global?: PermissionStop | null;
}): { stop: PermissionStop | null; source: FilesAndCommandsSource } {
  if (input.agent?.filesAndCommands) return { stop: input.agent.filesAndCommands, source: 'agent' };
  if (input.perRuntime) return { stop: input.perRuntime, source: 'runtime' };
  if (input.global) return { stop: input.global, source: 'default' };
  return { stop: null, source: 'runtime-own' };
}
