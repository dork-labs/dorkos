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
  PERMISSION_PRESET_TABLES,
  presetTableFor,
  resolveFilesAndCommands,
} from '@dorkos/shared/permissions';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { PERMISSION_STOPS } from '@dorkos/shared/permission-semantics';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { z } from 'zod';

import {
  listPermissionHistory,
  recordPermissionChange,
  type PermissionChangeRecord,
  type PermissionWriter,
} from './permission-history.js';
import type { ActivityService } from '../../activity/activity-service.js';
import { narrowArrivedPermissions } from './arrival-narrowing.js';

/** Who a setting DorkOS declined on arrival is recorded under. */
const ARRIVAL_WRITER: PermissionWriter = {
  attribution: 'outside',
  actorType: 'system',
  actorLabel: 'DorkOS',
};

/** The line a declined-on-arrival event carries. */
export const ARRIVAL_NOTE =
  "Permissions in this folder's settings file that were not stricter than everyone's " +
  'defaults were not applied. Set them in DorkOS.';

/** The line an arrival whose file could not be written back carries. */
export const ARRIVAL_WRITE_FAILED_NOTE =
  "DorkOS couldn't apply this folder's settings file, so this agent follows everyone's " +
  'defaults except where its file is stricter. Set its permissions in DorkOS.';

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
  /** Its card shows the change it would make, so it is never Allowed (DOR-2328). */
  alwaysAsks?: true;
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
  /** The runtime it runs on, for its per-runtime Files & commands stop. */
  runtime?: string;
}

/** The stored Files & commands stops: the global one, and each runtime's own. */
export interface StoredTrustStops {
  /** `runtimes.defaultTrustStop`. */
  global: PermissionStop | null;
  /** Each runtime's own stop, by runtime id (`claude-code`, `codex`, `opencode`). */
  perRuntime: Readonly<Record<string, PermissionStop | null>>;
}

/** The sentence a Full-autonomy write without an acknowledgement is refused with. */
export const AUTONOMY_ACK_MESSAGE =
  'Full autonomy lets agents edit files and run commands without asking. Confirm that in the ' +
  'app first, then try again.';

/** Everything the service reads and writes through. */
export interface PermissionServiceDeps {
  /** The install's `permissions` config section, read and written whole. */
  config: {
    get: () => PermissionConfigInput & { upgradeSweptVersion: string | null };
    set: (next: PermissionConfigInput & { upgradeSweptVersion: string | null }) => void;
    /** The stored Files & commands stops. */
    trustStops: () => StoredTrustStops;
    /**
     * Write the global Files & commands stop, recording the person's
     * acknowledgement of Full autonomy in the same write when `acknowledge`.
     */
    setGlobalTrustStop: (stop: PermissionStop, acknowledge: boolean) => void;
    /** Whether an acknowledgement of Full autonomy is on file. */
    hasAutonomyAck: () => boolean;
    /** Record the acknowledgement on its own (an agent's own stop set to Full autonomy). */
    recordAutonomyAck: () => void;
  };
  /** The registered agents and the manifest write-through. */
  agents: {
    list: () => PermissionAgentRef[];
    /** Read an agent's stored overrides fresh off its manifest file. */
    readPermissions: (projectPath: string) => Promise<AgentPermissions | undefined>;
    /** Write an agent's overrides through the manifest (absent = inherit all). */
    writePermissions: (agentId: string, next: AgentPermissions | undefined) => Promise<void>;
    /**
     * The agent's settings exactly as its file holds them, for the arrival
     * screen, which must see what it is narrowing. Defaults to
     * {@link readPermissions}.
     */
    readStoredPermissions?: (projectPath: string) => Promise<AgentPermissions | undefined>;
  };
  /** Every action an agent can reach, with its area. Read per call. */
  actions: () => PermissionActionInfo[];
  /** Whether the record of screened arrivals can be read and saved. */
  arrivalsHealthy?: () => boolean;
  /** The Activity log, absent in a process with none. */
  activity?: Pick<ActivityService, 'emit' | 'list'>;
}

/** A per-key request: a state to set, or `null` to remove the change. */
export type PermissionPatch = {
  areas?: Record<string, PermissionState | null>;
  actions?: Record<string, PermissionState | null>;
  /** An agent's own Files & commands stop; `null` = back to the default. */
  filesAndCommands?: PermissionStop | null;
};

/**
 * The patch with every action key dropped whose stored value is no longer the
 * expected one (see `setAgent`'s `expectActions`).
 */
function unchanged(
  stored: AgentPermissions,
  patch: PermissionPatch,
  expected: Record<string, PermissionState | null>
): PermissionPatch {
  const actions: Record<string, PermissionState | null> = {};
  for (const [key, value] of Object.entries(patch.actions ?? {})) {
    const current = (stored.actions as Record<string, unknown> | undefined)?.[key] ?? null;
    if (!(key in expected) || current === expected[key]) actions[key] = value;
  }
  return { ...(patch.areas ? { areas: patch.areas } : {}), actions };
}

/** How far back the agent page looks for a change made outside DorkOS. */
const OUTSIDE_HISTORY_DEPTH = 50;

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
      if (state === 'allowed' && action.alwaysAsks) {
        throw new PermissionError(
          'ALWAYS_ASKS',
          `"${action.title}" always shows you what it would change, so it is never Allowed. Choose Ask or Blocked.`
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
      // Following the new preset means its Files & commands stop too.
      let files = stored.filesAndCommands;
      if (keys === 'all' && files) {
        changes.push({ target, key: { kind: 'files' }, before: files, after: null });
        files = undefined;
        moved = true;
      }
      if (moved) {
        const { filesAndCommands: _previous, ...rest } = stored;
        const next = compact({
          ...rest,
          areas,
          actions: actionMap,
          ...(files ? { filesAndCommands: files } : {}),
        });
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
   * Screen the settings a newly arrived agent brought in its own folder.
   *
   * An agent is registered from a folder whose `.dork/agent.json` anybody (or
   * any agent with file tools) may have written, so the permissions in it were
   * never a person's choice in DorkOS. Every arrival is screened: the agent
   * keeps only what is strictly stricter than the defaults it would otherwise
   * follow ({@link narrowArrivedPermissions}), the rest is dropped from the
   * file, and one history line says so.
   *
   * Until this returns `written: true` the agent is pending in the arrival
   * record, and every reader narrows its settings the same way, so a write
   * that cannot land (a read-only file) never leaves the folder's settings in
   * force. A failed write is recorded too, and left for the next boot to retry.
   *
   * @param agentId - The agent that just arrived.
   * @returns What was dropped, and whether the file now says what the agent keeps.
   */
  async screenArrivedAgent(
    agentId: string
  ): Promise<{ changes: PermissionChange[]; written: boolean }> {
    const agent = this.deps.agents.list().find((a) => a.id === agentId);
    if (!agent) return { changes: [], written: false };
    const read = this.deps.agents.readStoredPermissions ?? this.deps.agents.readPermissions;
    const stored = await read(agent.projectPath);
    const actions = this.actionIndex();
    const { kept, dropped, droppedUnknown } = narrowArrivedPermissions(stored, {
      config: this.deps.config.get(),
      actions,
      globalStop: this.deps.config.trustStops().global,
    });
    const target = this.agentTarget(agent);
    const changes: PermissionChange[] = dropped.map((d) => ({ ...d, target, after: null }));
    if (changes.length === 0 && !droppedUnknown) return { changes, written: true };

    try {
      await this.deps.agents.writePermissions(agentId, kept);
    } catch (err) {
      await this.record(
        { changes, surface: 'file-edit', writer: ARRIVAL_WRITER, note: ARRIVAL_WRITE_FAILED_NOTE },
        this.titleFor(actions)
      );
      throw err;
    }
    if (changes.length > 0) {
      await this.record(
        { changes, surface: 'file-edit', writer: ARRIVAL_WRITER, note: ARRIVAL_NOTE },
        this.titleFor(actions)
      );
    }
    return { changes, written: true };
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
    input: PermissionPatch & {
      applyToAgents?: string[];
      surface: PermissionSurface;
      /** The approval an agent's request was answered through, when it was one. */
      approvalId?: string;
    },
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
    await this.record(
      {
        changes: all,
        surface: input.surface,
        writer,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      this.titleFor(actions)
    );
    return all;
  }

  /**
   * Choose a preset (spec `agent-permissions` D5). Clears the changes on top of
   * the old one, and moves the global Files & commands stop to the preset's
   * (Careful: Ask first, Balanced: Act, Full power: Full autonomy). Per-runtime
   * stops are left alone and show as changes. `applyToAgents` removes every
   * setting those agents have of their own, so they follow the new preset.
   *
   * All or nothing: a preset that moves the stop to Full autonomy with no
   * acknowledgement on file, and none sent with it, is refused (428
   * `AUTONOMY_ACK_REQUIRED`) before anything is written, preset included.
   *
   * @param input - The preset, the agents to bring along, where it came from,
   *   and whether the person acknowledged Full autonomy in this request.
   * @param writer - Who is making the change.
   * @returns Every change the write made.
   * @throws {PermissionError} `AUTONOMY_ACK_REQUIRED` (428).
   */
  async setPreset(
    input: {
      preset: PermissionPreset;
      applyToAgents?: string[];
      surface: PermissionSurface;
      acknowledgeAutonomy?: boolean;
    },
    writer: PermissionWriter
  ): Promise<PermissionChange[]> {
    const actions = this.actionIndex();
    const selected = this.agentsById(input.applyToAgents ?? []);
    const presetStop = PERMISSION_PRESET_TABLES[input.preset].filesStop;
    const acknowledge = input.acknowledgeAutonomy === true;
    if (presetStop === 'autonomy' && !acknowledge && !this.deps.config.hasAutonomyAck()) {
      throw new PermissionError('AUTONOMY_ACK_REQUIRED', AUTONOMY_ACK_MESSAGE, 428);
    }
    const config = this.deps.config.get();
    const stops = this.deps.config.trustStops();
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
    if (presetStop !== null && stops.global !== presetStop) {
      changes.push({
        target: { kind: 'default' },
        key: { kind: 'files' },
        before: stops.global,
        after: presetStop,
      });
    }
    const cleared = await this.clearAgentKeys(selected, 'all', actions);
    const presetSnapshot = {
      preset: config.preset,
      defaults: config.defaults,
      trustStop: stops.global,
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
    if (presetStop !== null && (stops.global !== presetStop || acknowledge)) {
      this.deps.config.setGlobalTrustStop(presetStop, acknowledge);
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
   * @param input - The patch, where it came from, the approval it answered
   *   (an Always allow on a request card), and, for a compare-and-set, the
   *   value each action key must still hold for its change to be written.
   * @param writer - Who is making the change.
   * @returns Every change the write made.
   */
  async setAgent(
    agentId: string,
    input: PermissionPatch & {
      surface: PermissionSurface;
      approvalId?: string;
      /**
       * Per action key, the value the agent's own setting must still hold
       * (`null` = not set); a key whose stored value differs is left alone.
       * How a reversal avoids undoing a write it did not make.
       */
      expectActions?: Record<string, PermissionState | null>;
      /** The person acknowledged Full autonomy in this request. */
      acknowledgeAutonomy?: boolean;
    },
    writer: PermissionWriter
  ): Promise<PermissionChange[]> {
    const actions = this.actionIndex();
    this.validate(input, actions);
    const files = input.filesAndCommands;
    if (files !== undefined && files !== null && !PERMISSION_STOPS.includes(files)) {
      throw new PermissionError(
        'INVALID_STOP',
        `"${String(files)}" is not a Files & commands stop.`
      );
    }
    // The same consent door the global stop has: an agent's own Full autonomy
    // needs the acknowledgement on file, or sent with it (428 otherwise).
    const acknowledge = input.acknowledgeAutonomy === true;
    if (files === 'autonomy' && !acknowledge && !this.deps.config.hasAutonomyAck()) {
      throw new PermissionError('AUTONOMY_ACK_REQUIRED', AUTONOMY_ACK_MESSAGE, 428);
    }
    const [agent] = this.agentsById([agentId]);
    const stored = (await this.deps.agents.readPermissions(agent!.projectPath)) ?? {};
    const patch = input.expectActions ? unchanged(stored, input, input.expectActions) : input;
    const target = this.agentTarget(agent!);
    const { next, changes } = this.applyPatch(stored, patch, target, actions);
    let nextFiles = stored.filesAndCommands;
    if (files !== undefined && (stored.filesAndCommands ?? null) !== files) {
      changes.push({
        target,
        key: { kind: 'files' },
        before: stored.filesAndCommands ?? null,
        after: files,
      });
      nextFiles = files ?? undefined;
    }
    if (changes.length > 0) {
      if (files === 'autonomy' && acknowledge) this.deps.config.recordAutonomyAck();
      const { filesAndCommands: _previous, ...rest } = stored;
      await this.deps.agents.writePermissions(
        agentId,
        compact({
          ...rest,
          areas: next.areas,
          actions: next.actions,
          ...(nextFiles ? { filesAndCommands: nextFiles } : {}),
        })
      );
    }
    await this.record(
      {
        changes,
        surface: input.surface,
        writer,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      },
      this.titleFor(actions)
    );
    return changes;
  }

  /**
   * The registered agent whose project directory this is, when there is one.
   *
   * @param agentPath - The agent's project directory.
   */
  agentByPath(agentPath: string): PermissionAgentRef | undefined {
    return this.deps.agents.list().find((agent) => agent.projectPath === agentPath);
  }

  /** Resolve at the default layer: no agent. */
  private resolveDefault(
    config: PermissionConfigInput,
    area: PermissionAreaId,
    actionId: string,
    tier: CapabilityTier,
    agent?: AgentPermissions,
    alwaysAsks?: true
  ): ResolvedPermission {
    return resolvePermission({
      area,
      actionId,
      tier,
      config,
      ...(agent ? { agent } : {}),
      ...(alwaysAsks ? { alwaysAsks } : {}),
    });
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
            ...(a.alwaysAsks ? { alwaysAsks: true as const } : {}),
            resolved: this.resolveDefault(config, id, a.id, a.tier, agent, a.alwaysAsks),
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
    const filesExceptions: { agentId: string; agentName: string; stop: PermissionStop }[] = [];
    for (const agent of agents) {
      let stored: AgentPermissions | undefined;
      try {
        stored = await this.deps.agents.readPermissions(agent.projectPath);
      } catch {
        // An unreadable manifest is refused at the gate; here it is simply not
        // listed as differing, since nothing about it can be read.
        continue;
      }
      if (stored?.filesAndCommands) {
        filesExceptions.push({
          agentId: agent.id,
          agentName: agentName(agent),
          stop: stored.filesAndCommands,
        });
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
    const stops = this.deps.config.trustStops();
    const presetStop = presetTableFor(config.preset).filesStop;
    const runtimeStops = Object.entries(stops.perRuntime).flatMap(([runtime, stop]) =>
      stop ? [{ runtime, stop }] : []
    );
    // "Custom" is never stored: it is the default changes, plus the global stop
    // when it is not the one the preset sets (an unset stop included: an install
    // whose preset came from an upgrade, or whose stop was cleared, does not
    // start where its preset says), plus each per-runtime stop that differs.
    // Undecided installs have no preset stop, so their stops are not changes to
    // anything.
    const stopChanges =
      presetStop === null
        ? 0
        : (stops.global !== presetStop ? 1 : 0) +
          runtimeStops.filter((entry) => entry.stop !== presetStop).length;
    return {
      preset: config.preset,
      defaults: config.defaults,
      changeCount:
        Object.keys(config.defaults.areas).length +
        Object.keys(config.defaults.actions).length +
        stopChanges,
      filesAndCommands: {
        stop: stops.global,
        presetStop,
        runtimes: runtimeStops,
        exceptions: filesExceptions,
      },
      areas: this.areaEntries(config, actions),
      exceptions,
      agentCount: agents.length,
      ...(this.deps.arrivalsHealthy && !this.deps.arrivalsHealthy()
        ? { newAgentRecordUnreadable: true as const }
        : {}),
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
    const outside = await this.changedOutsideAt(agent!.id);
    const stops = this.deps.config.trustStops();
    const perRuntime = agent!.runtime ? (stops.perRuntime[agent!.runtime] ?? null) : null;
    const inheritedFiles = resolveFilesAndCommands({ perRuntime, global: stops.global });
    const files = resolveFilesAndCommands({
      ...(stored.filesAndCommands ? { agent: { filesAndCommands: stored.filesAndCommands } } : {}),
      perRuntime,
      global: stops.global,
    });
    return {
      agentId: agent!.id,
      agentName: agentName(agent!),
      overrides: stored,
      areas: own.map((entry, i) => ({
        ...entry,
        inherited: inherited[i]!.resolved,
        changedOutsideAt: outside.get(entry.id) ?? null,
      })),
      filesAndCommands: { ...files, inherited: inheritedFiles },
    };
  }

  /**
   * For each area of one agent, when its most recent change was made outside
   * DorkOS, or nothing when the most recent change came through DorkOS. An
   * action's change counts for the area it belongs to.
   */
  private async changedOutsideAt(agentId: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!this.deps.activity) return found;
    const decided = new Set<string>();
    const history = await listPermissionHistory(this.deps.activity, {
      agentId,
      limit: OUTSIDE_HISTORY_DEPTH,
    });
    for (const entry of history.items) {
      for (const change of entry.metadata.changes) {
        if (change.target.kind !== 'agent' || change.target.agentId !== agentId) continue;
        const area =
          change.key.kind === 'area' || change.key.kind === 'action' ? change.key.area : undefined;
        if (!area || decided.has(area)) continue;
        decided.add(area);
        if (entry.metadata.attribution === 'outside') found.set(area, entry.occurredAt);
      }
    }
    return found;
  }
}
