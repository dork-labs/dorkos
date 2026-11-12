/**
 * The tool gate's half of `tasks.set_mode` and `tasks.approve` (DOR-3703): an
 * escalator for `tasks_create` and `tasks_update` on both MCP servers, so a
 * call that names a mode or approves a task is decided, and carded, as that
 * action rather than as "change a scheduled task".
 *
 * A card raised here is the standard one: bound to a hash of these exact
 * arguments, held in the chat while the person decides, answered only through
 * the person's approval route, never by an agent. A call the decision refuses
 * is let through to the tool, which refuses it whole with its own reason, so
 * nobody is asked about something that cannot run.
 *
 * @module services/tasks/agent-mode/agent-mode-escalation
 */
import type { MeshCore } from '@dorkos/mesh';
import type { CallPermission } from '../../core/capabilities/permission-enforcement.js';
import type { GatedAction } from '../../core/capabilities/tier-enforcement.js';
import {
  registerToolCallEscalator,
  type ToolCallContext,
  type ToolCallEscalation,
} from '../../core/capabilities/tool-call-escalation.js';
import { marksOf } from '../../core/turn-power/turn-levels.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import { liveRunOriginSources, withRunOrigin } from './agent-mode-run-origin.js';
import type { TaskStore } from '../task-store.js';
import {
  AGENT_MODE_ACTION_TITLES,
  AGENT_MODE_AREA,
  TASK_APPROVE_ACTION,
  agentModeControlOn,
  reachesAgentMode,
} from './agent-mode-actions.js';
import {
  decideAgentModeCall,
  type AgentModeCaller,
  type AgentModeDecision,
  type AgentModeSources,
} from './agent-mode-decision.js';
import { liveAgentModeSources } from './agent-mode-sources.js';
import { identityResolutionOf } from './agent-mode-identity.js';
import { agentModeChangeOf } from './agent-mode-change.js';

const STATE_RANK = { allowed: 0, ask: 1, blocked: 2 } as const;

/**
 * The caller as the gate verified it. Structural only for an agent's own tools
 * inside its own chat with a live identity; every other caller, a token, a
 * key or nothing at all, is never the person and never Allowed.
 *
 * @param context - What the gate knows about the call.
 */
function gateCallerOf(context: ToolCallContext): AgentModeCaller {
  const identity = context.identity && !context.identity.inactive ? context.identity : undefined;
  const resolved = !identity
    ? 'unidentified'
    : context.origin !== 'session'
      ? 'token'
      : identityResolutionOf(context.cwd, identity.agentPath);
  // A chat whose folder names another agent is not that agent's own chat.
  const structural =
    context.origin === 'session' && identity !== undefined && resolved !== 'unidentified';
  return {
    structural,
    resolved,
    ...(identity ? { agentPath: identity.agentPath } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    // A caller off the chat that DorkOS cannot name is held as an outsider's, as
    // the external server holds it everywhere else (DOR-3036).
    marked:
      marksHold(marksOf(context.sessionId, identity?.agentPath)) ||
      (context.origin !== 'session' && identity === undefined),
  };
}

/** The approval-card fields of each door, most consequential first. */
const CARD_FIELDS = {
  tasks_update: ['id', 'status', 'permissionMode'],
  tasks_create: ['name', 'permissionMode', 'cron', 'target'],
} as const;

/**
 * What the gate does with a decision: nothing, let a refusal reach the tool,
 * or decide and card the call as the action it reaches.
 *
 * @param decision - The decision.
 * @param action - The tool's own gated action.
 * @param outer - The tool's own permission for this caller.
 * @param change - What the person approves, content hash included
 *   (`agentModeChangeOf`): bound into the card and shown on it.
 */
export function escalationFor(
  decision: AgentModeDecision,
  action: GatedAction,
  outer: CallPermission | null,
  change?: string
): ToolCallEscalation | null {
  if (decision.kind === 'none') return null;
  if (decision.kind === 'refuse') {
    // Let the call reach the tool, decided as the TOOL's own action, so nobody
    // is asked about a call that cannot run. This never grants anything: the
    // door re-decides, and it only grants on a note naming the action itself
    // (`tasks.set_mode` / `tasks.approve`), never this tool-named one, so the
    // tool refuses the call whole with its own reason (S4).
    return {
      action,
      permission: { area: AGENT_MODE_AREA, state: 'allowed', source: 'floor', layer: 'floor' },
    };
  }
  const forced = decision.state !== decision.permission.state;
  const own: CallPermission = forced
    ? { area: AGENT_MODE_AREA, state: decision.state, source: 'always-asks', layer: 'floor' }
    : decision.permission;
  const permission = outer && STATE_RANK[outer.state] > STATE_RANK[own.state] ? outer : own;
  const fields = CARD_FIELDS[action.id as keyof typeof CARD_FIELDS] ?? action.approvalDisplayFields;
  return {
    action: {
      ...action,
      id: decision.primary,
      title: AGENT_MODE_ACTION_TITLES[decision.primary],
      ...(decision.primary === TASK_APPROVE_ACTION ? { consent: 'standing-grant' as const } : {}),
      ...(fields ? { approvalDisplayFields: fields } : {}),
    },
    permission,
    ...(change !== undefined ? { change } : {}),
  };
}

/** The write body a tool call carries: its arguments, without an update's `id`. */
function bodyOf(input: unknown): Record<string, unknown> {
  const { id: _id, ...body } = (input ?? {}) as Record<string, unknown>;
  return body;
}

/**
 * Register the escalators for `tasks_create` and `tasks_update`. Called once at
 * boot, when the Tasks store exists.
 *
 * @param deps - The store and Mesh.
 * @param sources - Override for tests.
 * @returns A function that removes both again.
 */
export function registerAgentModeEscalators(
  deps: {
    store: Pick<TaskStore, 'getTask' | 'approvals' | 'resolveTaskOrigins'>;
    meshCore?: Pick<MeshCore, 'getProjectPath'>;
  },
  sources: AgentModeSources = liveAgentModeSources(deps.meshCore)
): () => void {
  const removeUpdate = registerToolCallEscalator(
    'tasks_update',
    async ({ action, input, permission, context }) => {
      const body = bodyOf(input);
      if (!agentModeControlOn() || !reachesAgentMode(body)) return null;
      // The tool itself is off for this caller: its own refusal stands.
      if (permission?.state === 'blocked') return null;
      const id = (input as { id?: unknown } | undefined)?.id;
      const task = typeof id === 'string' ? deps.store.getTask(id) : null;
      if (!task) return null;
      const caller = withRunOrigin(gateCallerOf(context), liveRunOriginSources(deps.store));
      const decision = await decideAgentModeCall(
        { door: 'update', body, task, edits: deps.store.approvals.agentEditsOf(task.id) },
        caller,
        sources
      );
      const change =
        decision.kind === 'decided'
          ? agentModeChangeOf(
              { door: 'update', body, task },
              decision,
              deps.meshCore,
              caller.agentPath
            )
          : undefined;
      return escalationFor(decision, action, permission, change);
    }
  );
  const removeCreate = registerToolCallEscalator(
    'tasks_create',
    async ({ action, input, permission, context }) => {
      const body = bodyOf(input);
      if (!agentModeControlOn() || !reachesAgentMode(body)) return null;
      if (permission?.state === 'blocked') return null;
      const target = typeof body.target === 'string' ? body.target : undefined;
      const caller = withRunOrigin(gateCallerOf(context), liveRunOriginSources(deps.store));
      const decision = await decideAgentModeCall(
        { door: 'create', body, ...(target ? { target } : {}) },
        caller,
        sources
      );
      const change =
        decision.kind === 'decided'
          ? agentModeChangeOf({ door: 'create', body }, decision, deps.meshCore, caller.agentPath)
          : undefined;
      return escalationFor(decision, action, permission, change);
    }
  );
  return () => {
    removeUpdate();
    removeCreate();
  };
}
