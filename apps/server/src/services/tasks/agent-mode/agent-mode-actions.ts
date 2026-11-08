/**
 * The two permission actions an agent reaches when it names a scheduled task's
 * permission mode or approves a waiting task (DOR-3703), and the switch that
 * turns them on.
 *
 * Both live in Tasks & schedules and carry the `standing-grant` consent, so an
 * area-level Allowed (Trusted allows the whole area) still asks: only a setting
 * for the action itself allows it. Neither has a tool of its own. They are
 * reached through `tasks_create` and `tasks_update` (and their HTTP twins), and
 * decided in `agent-mode-decision.ts`.
 *
 * @module services/tasks/agent-mode/agent-mode-actions
 */
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import type { PermissionMode } from '@dorkos/shared/types';
import { configManager } from '../../core/config-manager.js';

/** The action an agent takes when it names a scheduled task's permission mode. */
export const TASK_SET_MODE_ACTION = 'tasks.set_mode';

/** The action an agent takes when it moves a waiting task to `active`. */
export const TASK_APPROVE_ACTION = 'tasks.approve';

/** Either of the two actions. */
export type AgentModeAction = typeof TASK_SET_MODE_ACTION | typeof TASK_APPROVE_ACTION;

/** The area both actions are set in. */
export const AGENT_MODE_AREA: PermissionAreaId = 'tasks';

/** The titles a person reads on the permissions page and on the approval card. */
export const AGENT_MODE_ACTION_TITLES: Readonly<Record<AgentModeAction, string>> = {
  [TASK_SET_MODE_ACTION]: 'Set how a scheduled task runs',
  [TASK_APPROVE_ACTION]: 'Approve a scheduled task',
};

/**
 * The loosest mode two cases reach without a person: a mode set from a turn
 * that read outside words (the ceiling's outside-content cap), and an
 * approval that would arm a task (looser asks). Don't ask runs only what the
 * agent's allow list already allows and widens nothing on its own (that list
 * still needs a person's folder-allow card).
 */
export const AGENT_MODE_WITHOUT_A_PERSON: PermissionMode = 'dontAsk';

/**
 * Whether a task whose current content a PERSON approved keeps running when its
 * own agent changes only its mode, to a mode looser than Don't ask and within
 * the agent's ceiling. `true` follows Dorian's rule (Nov 2: "If an agent is set
 * to fully autonomous / bypass permissions, then they should be able to set the
 * schedule's permissions at the same level, or lower"). A Security/PM ruling on
 * this one case is pending: `false` parks it for a person instead. A new task,
 * or any content change, above Don't ask parks for a person either way.
 */
export const MODE_ONLY_CHANGE_ON_PERSON_APPROVED_TASK_RUNS = true;

/**
 * Whether agents may set a scheduled task's mode or approve one at all
 * (`tasks.agentModeControl`, DOR-3703). On by default; a kill switch. Read on
 * every call, so turning it off takes effect at the next one. Off, both stay
 * refused exactly as before.
 */
export function agentModeControlOn(): boolean {
  // `configManager` is unset only before boot initializes it: off until then.
  return configManager?.get('tasks')?.agentModeControl === true;
}

/**
 * The two actions as the permissions pages list them, while the switch is on.
 * No tool name: a Blocked action must refuse the call that reaches it, not hide
 * `tasks_update`, which does far more than this. Only the approval carries the
 * `standing-grant` consent: a mode change follows its area.
 */
export function agentModeListedActions(): {
  id: AgentModeAction;
  title: string;
  tier: 'act';
  area: PermissionAreaId;
  consent?: 'standing-grant';
}[] {
  if (!agentModeControlOn()) return [];
  return [
    {
      id: TASK_SET_MODE_ACTION as AgentModeAction,
      title: AGENT_MODE_ACTION_TITLES[TASK_SET_MODE_ACTION],
    },
    {
      id: TASK_APPROVE_ACTION as AgentModeAction,
      title: AGENT_MODE_ACTION_TITLES[TASK_APPROVE_ACTION],
      consent: 'standing-grant' as const,
    },
  ].map((action) => ({ ...action, tier: 'act' as const, area: AGENT_MODE_AREA }));
}

/**
 * Whether a write body reaches either action: it names `permissionMode` or
 * `status`. Presence counts, not the value, as in `findOperatorOnlyTaskFields`.
 *
 * @param body - The raw write body.
 */
export function reachesAgentMode(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.hasOwn(body, 'permissionMode') || Object.hasOwn(body, 'status');
}
