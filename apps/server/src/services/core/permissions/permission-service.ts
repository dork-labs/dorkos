/**
 * The one owner of every permission write (spec `agent-permissions` D10).
 *
 * Every write here validates the ids it names, refuses Allowed on a floor area,
 * writes config through `ConfigManager` and manifests through `MeshCore.update`
 * (file-first write-through, ADR-0043), and records exactly ONE
 * `permission.changed` event. Nothing else writes a permission: the generic
 * config writers refuse `permissions.*`, the mesh PATCH refuses the field, and
 * the agent self-edit path refuses it.
 *
 * Who may call it is decided at the route, by the same bars the approval decide
 * route uses; this service trusts the writer it is handed and records it.
 *
 * @module services/core/permissions/permission-service
 */
import {
  PERMISSION_AREAS,
  PERMISSION_AREA_IDS,
  PERMISSION_STATES,
  isFloorArea,
  resolvePermission,
  type AgentPermissions,
  type AgentPermissionsResponse,
  type PermissionActionEntrySchema,
  type PermissionAreaId,
  type PermissionChange,
  type PermissionConfigInput,
  type PermissionException,
  type PermissionOverrides,
  type PermissionPreset,
  type PermissionState,
  type PermissionSurface,
  type PermissionsResponse,
  type ResolvedPermission,
} from '@dorkos/shared/permissions';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { z } from 'zod';

import {
  recordPermissionChange,
  type PermissionChangeRecord,
  type PermissionWriter,
} from './permission-history.js';
import type { ActivityService } from '../../activity/activity-service.js';

/** A permission write the service refused, with the HTTP status that fits it. */
export class PermissionError extends Error {
  /** Marks this class across module instances. */
  override readonly name = 'PermissionError';

  /**
   * Construct the refusal.
   *
   * @param code - Machine-readable refusal code.
   * @param message - One plain sentence a person can act on.
   * @param status - The HTTP status the route answers with.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400
  ) {
    super(message);
  }
}

/** One action as the permission pages list it. */
export interface PermissionActionInfo {
  /** Capability id or hand-registered tool name. */
  id: string;
  /** The title a person reads. */
  title: string;
  /** The action's tier. */
  tier: CapabilityTier;
  /** Its area, or `null` for an action with no switch. */
  area: PermissionAreaId | null;
  /** The MCP tool name the action is listed under, when it has one. */
  toolName?: string;
}

/** One registered agent, as the service needs it. */
export interface PermissionAgentRef {
  /** The agent's id. */
  id: string;
  /** Its short name. */
  name: string;
  /** Its display name, when it has one. */
  displayName?: string;
  /** Its project directory, where its manifest lives. */
  projectPath: string;
}

/** Everything the service reads and writes through. */
export interface PermissionServiceDeps {
  /** The install's `permissions` config section, read and written whole. */
  config: {
    get: () => PermissionConfigInput & { upgradeSweptVersion: string | null };
    set: (next: PermissionConfigInput & { upgradeSweptVersion: string | null }) => void;
    /** The global Files & commands stop, recorded in a preset snapshot. */
    trustStop: () => string | null;
  };
  /** The registered agents and the manifest write-through. */
  agents: {
    list: () => PermissionAgentRef[];
    /** Read an agent's stored overrides fresh off its manifest file. */
    readPermissions: (projectPath: string) => Promise<AgentPermissions | undefined>;
    /** Write an agent's overrides through the manifest (absent = inherit all). */
    writePermissions: (agentId: string, next: AgentPermissions | undefined) => Promise<void>;
  };
  /** Every action an agent can reach, with its area. Read per call. */
  actions: () => PermissionActionInfo[];
  /** The Activity writer, absent in a process with none. */
  activity?: Pick<ActivityService, 'emit'>;
}

/** A per-key request: a state to set, or `null` to remove the change. */
export type PermissionPatch = {
  areas?: Record<string, PermissionState | null>;
  actions?: Record<string, PermissionState | null>;
};

/** An area-level resolution: the action id no action entry ever names. */
const AREA_PROBE_ACTION = '';

/** True for a real state value. */
function isState(value: unknown): value is PermissionState {
  return typeof value === 'string' && (PERMISSION_STATES as readonly string[]).includes(value);
}

/** The agent's name as a person reads it. */
function agentName(agent: PermissionAgentRef): string {
  return agent.displayName || agent.name;
}

/** Drop empty maps so an agent with no overrides writes no `permissions` at all. */
function compact(permissions: AgentPermissions): AgentPermissions | undefined {
  const areas = permissions.areas && Object.keys(permissions.areas).length > 0;
  const actions = permissions.actions && Object.keys(permissions.actions).length > 0;
  const next: AgentPermissions = {
    ...(areas ? { areas: permissions.areas } : {}),
    ...(actions ? { actions: permissions.actions } : {}),
    ...(permissions.filesAndCommands ? { filesAndCommands: permissions.filesAndCommands } : {}),
  };
  return Object.keys(next).length === 0 ? undefined : next;
}

/** An own-key read that never reaches the prototype. */
function ownState(
  record: Record<string, unknown> | undefined,
  key: string
): PermissionState | null {
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return isState(value) ? value : null;
}

/**
 * The permission write owner and reader. One instance per server.
 */
export class PermissionService {
  constructor(private readonly deps: PermissionServiceDeps) {}

  /** Actions keyed by id, for validation and titles. */
  private actionIndex(): Map<string, PermissionActionInfo> {
    return new Map(this.deps.actions().map((a) => [a.id, a]));
  }

  /**
   * Validate a per-key request against the known ids and the floor.
   *
   * @throws {PermissionError} `UNKNOWN_AREA`, `UNKNOWN_ACTION`, `ACTION_HAS_NO_AREA`,
   *   `INVALID_STATE` or `FLOOR_NEVER_ALLOWED`.
   */
  private validate(patch: PermissionPatch, actions: Map<string, PermissionActionInfo>): void {
    for (const [area, state] of Object.entries(patch.areas ?? {})) {
      if (!(PERMISSION_AREA_IDS as readonly string[]).includes(area)) {
        throw new PermissionError('UNKNOWN_AREA', `There is no permission area called "${area}".`);
      }
      if (state !== null && !isState(state)) {
        throw new PermissionError('INVALID_STATE', `"${String(state)}" is not a permission state.`);
      }
      if (state === 'allowed' && isFloorArea(area)) {
        throw new PermissionError(
          'FLOOR_NEVER_ALLOWED',
          'Safety limits, Permissions, and Reach & secrets are never Allowed. Choose Ask or Blocked.'
        );
      }
    }
    for (const [id, state] of Object.entries(patch.actions ?? {})) {
      const action = actions.get(id);
      if (!action) {
        throw new PermissionError('UNKNOWN_ACTION', `There is no action called "${id}".`);
      }
      if (action.area === null) {
        throw new PermissionError(
          'ACTION_HAS_NO_AREA',
          `"${action.title}" is always allowed on its own, so it has no permission to set.`
        );
      }
      if (state !== null && !isState(state)) {
        throw new PermissionError('INVALID_STATE', `"${String(state)}" is not a permission state.`);
      }
      if (state === 'allowed' && isFloorArea(action.area)) {
        throw new PermissionError(
          'FLOOR_NEVER_ALLOWED',
          `"${action.title}" is in an area that is never Allowed. Choose Ask or Blocked.`
        );
      }
    }
  }

  /** The agents named by id, refusing an unknown one. */
  private agentsById(ids: readonly string[]): PermissionAgentRef[] {
    const all = new Map(this.deps.agents.list().map((a) => [a.id, a]));
    return ids.map((id) => {
      const agent = all.get(id);
      if (!agent) throw new PermissionError('UNKNOWN_AGENT', `No agent with id "${id}".`, 404);
      return agent;
    });
  }

  /** The target of a change to one agent. */
  private agentTarget(agent: PermissionAgentRef): PermissionChange['target'] {
    return {
      kind: 'agent',
      agentId: agent.id,
      agentPath: agent.projectPath,
      agentName: agentName(agent),
    };
  }

  /**
   * Apply a per-key patch onto stored overrides, collecting the changes.
   *
   * @returns The next overrides and the changes that actually moved.
   */
  private applyPatch(
    current: { areas?: Record<string, PermissionState>; actions?: Record<string, PermissionState> },
    patch: PermissionPatch,
    target: PermissionChange['target'],
    actions: Map<string, PermissionActionInfo>
  ): { next: PermissionOverrides; changes: PermissionChange[] } {
    const areas = { ...(current.areas ?? {}) };
    const actionMap = { ...(current.actions ?? {}) };
    const changes: PermissionChange[] = [];
    for (const [area, state] of Object.entries(patch.areas ?? {})) {
      const before = ownState(areas, area);
      if (before === state) continue;
      if (state === null) delete areas[area];
      else areas[area] = state;
      changes.push({
        target,
        key: { kind: 'area', area: area as PermissionAreaId },
        before,
        after: state,
      });
    }
    for (const [id, state] of Object.entries(patch.actions ?? {})) {
      const before = ownState(actionMap, id);
      if (before === state) continue;
      if (state === null) delete actionMap[id];
      else actionMap[id] = state;
      changes.push({
        target,
        key: { kind: 'action', action: id, area: actions.get(id)!.area as PermissionAreaId },
        before,
        after: state,
      });
    }
    return { next: { areas, actions: actionMap }, changes };
  }

  /**
   * Remove the named keys from each selected agent's overrides, so they follow
   * the new default. Returns the per-agent changes and a writer for them.
   */
  private async clearAgentKeys(
    agents: PermissionAgentRef[],
    keys: { areas: string[]; actions: string[] } | 'all',
    actions: Map<string, PermissionActionInfo>
  ): Promise<{ changes: PermissionChange[]; write: () => Promise<void> }> {
    const changes: PermissionChange[] = [];
    const writes: Array<() => Promise<void>> = [];
    for (const agent of agents) {
      const stored = (await this.deps.agents.readPermissions(agent.projectPath)) ?? {};
      const areaKeys = keys === 'all' ? Object.keys(stored.areas ?? {}) : keys.areas;
      const actionKeys = keys === 'all' ? Object.keys(stored.actions ?? {}) : keys.actions;
      const patch: PermissionPatch = {
        areas: Object.fromEntries(areaKeys.map((k) => [k, null])),
        actions: Object.fromEntries(actionKeys.map((k) => [k, null])),
      };
      // Unknown keys a newer build wrote are cleared too, but never validated
      // against this build's action list.
      const target = this.agentTarget(agent);
      const areas = { ...(stored.areas ?? {}) };
      const actionMap = { ...(stored.actions ?? {}) };
      let moved = false;
      for (const k of Object.keys(patch.areas ?? {})) {
        const before = ownState(areas, k);
        if (before === null) continue;
        delete areas[k];
        moved = true;
        if ((PERMISSION_AREA_IDS as readonly string[]).includes(k)) {
          changes.push({
            target,
            key: { kind: 'area', area: k as PermissionAreaId },
            before,
            after: null,
          });
        }
      }
      for (const k of Object.keys(patch.actions ?? {})) {
        const before = ownState(actionMap, k);
        if (before === null) continue;
        delete actionMap[k];
        moved = true;
        const area = actions.get(k)?.area;
        if (area)
          changes.push({ target, key: { kind: 'action', action: k, area }, before, after: null });
      }
      if (moved) {
        const next = compact({ ...stored, areas, actions: actionMap });
        writes.push(() => this.deps.agents.writePermissions(agent.id, next));
      }
    }
    return {
      changes,
      write: async () => {
        for (const w of writes) await w();
      },
    };
  }

  /** The title an action id shows in a summary. */
  private titleFor(actions: Map<string, PermissionActionInfo>): (id: string) => string {
    return (id) => actions.get(id)?.title ?? id;
  }

  /** Record one event for a write. */
  private async record(
    record: Omit<PermissionChangeRecord, 'actionTitle'>,
    titles: (id: string) => string
  ) {
    await recordPermissionChange(this.deps.activity, { ...record, actionTitle: titles });
  }

  /**
   * Change the defaults: per area and per action, `null` removing a change.
   * `applyToAgents` removes those agents' own settings for the same keys in the
   * same write, so they follow the new default.
   *
   * @param input - The patch, the agents to bring along, and where it came from.
   * @param writer - Who is making the change.
   * @returns Every change the write made.
   */
  async setDefaults(
    input: PermissionPatch & { applyToAgents?: string[]; surface: PermissionSurface },
    writer: PermissionWriter
  ): Promise<PermissionChange[]> {
    const actions = this.actionIndex();
    this.validate(input, actions);
    const selected = this.agentsById(input.applyToAgents ?? []);
    const config = this.deps.config.get();
    const { next, changes } = this.applyPatch(config.defaults, input, { kind: 'default' }, actions);
    const cleared = await this.clearAgentKeys(
      selected,
      { areas: Object.keys(input.areas ?? {}), actions: Object.keys(input.actions ?? {}) },
      actions
    );
    if (changes.length > 0) this.deps.config.set({ ...config, defaults: next });
    await cleared.write();
    const all = [...changes, ...cleared.changes];
    await this.record({ changes: all, surface: input.surface, writer }, this.titleFor(actions));
    return all;
  }

  /**
   * Choose a preset. Clears the changes on top of the old one; `applyToAgents`
   * removes every setting those agents have of their own, so they follow the
   * new preset. The trust-stop coupling is later work: the event records the
   * stop only in its snapshot, so an Undo can restore it.
   *
   * @param input - The preset, the agents to bring along, and where it came from.
   * @param writer - Who is making the change.
   * @returns Every change the write made.
   */
  async setPreset(
    input: { preset: PermissionPreset; applyToAgents?: string[]; surface: PermissionSurface },
    writer: PermissionWriter
  ): Promise<PermissionChange[]> {
    const actions = this.actionIndex();
    const selected = this.agentsById(input.applyToAgents ?? []);
    const config = this.deps.config.get();
    const changes: PermissionChange[] = [];
    if (config.preset !== input.preset) {
      changes.push({
        target: { kind: 'default' },
        key: { kind: 'preset' },
        before: config.preset,
        after: input.preset,
      });
    }
    for (const [area, state] of Object.entries(config.defaults.areas)) {
      if (!(PERMISSION_AREA_IDS as readonly string[]).includes(area)) continue;
      changes.push({
        target: { kind: 'default' },
        key: { kind: 'area', area: area as PermissionAreaId },
        before: state,
        after: null,
      });
    }
    for (const [id, state] of Object.entries(config.defaults.actions)) {
      const area = actions.get(id)?.area;
      if (!area) continue;
      changes.push({
        target: { kind: 'default' },
        key: { kind: 'action', action: id, area },
        before: state,
        after: null,
      });
    }
    const cleared = await this.clearAgentKeys(selected, 'all', actions);
    const presetSnapshot = {
      preset: config.preset,
      defaults: config.defaults,
      trustStop: this.deps.config.trustStop(),
    };
    const moved =
      config.preset !== input.preset ||
      Object.keys(config.defaults.areas).length > 0 ||
      Object.keys(config.defaults.actions).length > 0;
    if (moved) {
      this.deps.config.set({
        ...config,
        preset: input.preset,
        defaults: { areas: {}, actions: {} },
      });
    }
    await cleared.write();
    const all = [...changes, ...cleared.changes];
    await this.record(
      { changes: all, surface: input.surface, writer, presetSnapshot },
      this.titleFor(actions)
    );
    return all;
  }

  /**
   * Change one agent's own settings; `null` puts a key back to the default.
   *
   * @param agentId - The agent.
   * @param input - The patch and where it came from.
   * @param writer - Who is making the change.
   * @returns Every change the write made.
   */
  async setAgent(
    agentId: string,
    input: PermissionPatch & { surface: PermissionSurface },
    writer: PermissionWriter
  ): Promise<PermissionChange[]> {
    const actions = this.actionIndex();
    this.validate(input, actions);
    const [agent] = this.agentsById([agentId]);
    const stored = (await this.deps.agents.readPermissions(agent!.projectPath)) ?? {};
    const { next, changes } = this.applyPatch(stored, input, this.agentTarget(agent!), actions);
    if (changes.length > 0) {
      await this.deps.agents.writePermissions(
        agentId,
        compact({ ...stored, areas: next.areas, actions: next.actions })
      );
    }
    await this.record({ changes, surface: input.surface, writer }, this.titleFor(actions));
    return changes;
  }

  /** Resolve at the default layer: no agent. */
  private resolveDefault(
    config: PermissionConfigInput,
    area: PermissionAreaId,
    actionId: string,
    tier: CapabilityTier,
    agent?: AgentPermissions
  ): ResolvedPermission {
    return resolvePermission({ area, actionId, tier, config, ...(agent ? { agent } : {}) });
  }

  /**
   * Every state area with its actions, resolved for one layer.
   *
   * @param agent - The agent's overrides, or `undefined` for the default layer.
   */
  private areaEntries(
    config: PermissionConfigInput,
    actions: PermissionActionInfo[],
    agent?: AgentPermissions
  ) {
    return PERMISSION_AREAS.filter((a) => a.kind === 'state').map((area) => {
      const id = area.id as PermissionAreaId;
      const resolved = this.resolveDefault(config, id, AREA_PROBE_ACTION, 'act', agent);
      return {
        id,
        label: area.label,
        description: area.description,
        floor: area.floor,
        kind: area.kind,
        actions: actions
          .filter((a) => a.area === id)
          .map((a): z.infer<typeof PermissionActionEntrySchema> => ({
            id: a.id,
            title: a.title,
            tier: a.tier,
            resolved: this.resolveDefault(config, id, a.id, a.tier, agent),
          })),
        resolved: { state: resolved.state, source: resolved.source, layer: resolved.layer },
      };
    });
  }

  /**
   * The default layer, every area, and the agents that differ from it.
   *
   * @returns The `GET /api/permissions` body.
   */
  async getOverview(): Promise<PermissionsResponse> {
    const config = this.deps.config.get();
    const actions = this.deps.actions().filter((a) => a.area !== null);
    const byId = new Map(actions.map((a) => [a.id, a]));
    const agents = this.deps.agents.list();
    const exceptions: PermissionException[] = [];
    for (const agent of agents) {
      let stored: AgentPermissions | undefined;
      try {
        stored = await this.deps.agents.readPermissions(agent.projectPath);
      } catch {
        // An unreadable manifest is refused at the gate; here it is simply not
        // listed as differing, since nothing about it can be read.
        continue;
      }
      for (const [area, state] of Object.entries(stored?.areas ?? {})) {
        if (!(PERMISSION_AREA_IDS as readonly string[]).includes(area) || !isState(state)) continue;
        exceptions.push({
          agentId: agent.id,
          agentName: agentName(agent),
          area: area as PermissionAreaId,
          state,
        });
      }
      for (const [id, state] of Object.entries(stored?.actions ?? {})) {
        const area = byId.get(id)?.area;
        if (!area || !isState(state)) continue;
        exceptions.push({
          agentId: agent.id,
          agentName: agentName(agent),
          area,
          action: id,
          state,
        });
      }
    }
    return {
      preset: config.preset,
      defaults: config.defaults,
      changeCount:
        Object.keys(config.defaults.areas).length + Object.keys(config.defaults.actions).length,
      areas: this.areaEntries(config, actions),
      exceptions,
      agentCount: agents.length,
    };
  }

  /**
   * One agent's resolved state per area and action, with where each came from.
   *
   * @param agentId - The agent.
   * @returns The `GET /api/agents/:id/permissions` body.
   */
  async getAgent(agentId: string): Promise<AgentPermissionsResponse> {
    const [agent] = this.agentsById([agentId]);
    const config = this.deps.config.get();
    const actions = this.deps.actions().filter((a) => a.area !== null);
    const stored = (await this.deps.agents.readPermissions(agent!.projectPath)) ?? {};
    const own = this.areaEntries(config, actions, stored);
    const inherited = this.areaEntries(config, actions);
    return {
      agentId: agent!.id,
      agentName: agentName(agent!),
      overrides: stored,
      areas: own.map((entry, i) => ({ ...entry, inherited: inherited[i]!.resolved })),
    };
  }
}
