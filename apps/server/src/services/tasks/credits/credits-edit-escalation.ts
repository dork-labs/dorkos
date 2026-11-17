/**
 * The tool gate's half of DOR-4609: an agent's `tasks_update` that makes a
 * live task on DorkOS credits spend more is carded for a person, whatever the
 * agent's own level, and changes nothing until that yes. A turn marked by
 * outside words, or a caller DorkOS cannot name, is let through to the tool,
 * which refuses it whole: nobody is asked about a call that cannot run.
 *
 * The handler reads the gate's note back (`escalatedGrantFor`) and refuses a
 * credits raise that reached it without a card.
 *
 * @module services/tasks/credits/credits-edit-escalation
 */
import type { Task } from '@dorkos/shared/types';
import type { CallPermission } from '../../core/capabilities/permission-enforcement.js';
import type { GatedAction } from '../../core/capabilities/tier-enforcement.js';
import type { ToolCallEscalation } from '../../core/capabilities/tool-call-escalation.js';
import { agentEditRaisesCredits, type CreditsEdit } from './credits-work.js';

/** The card's line: what the person approves. */
export const CREDITS_EDIT_CHANGE = 'Change a scheduled task that runs on DorkOS credits.';

/**
 * Decide a `tasks_update` call on a credits task, on top of what the mode
 * escalator decided. A call that doesn't raise credits work keeps the mode
 * escalator's answer, `null` included.
 *
 * @param call - The tool's action and permission, the edit, the task, and whether the turn is marked.
 * @param modeEscalation - What the mode escalator decided, or `null`.
 */
export function creditsEditEscalation(
  call: {
    action: GatedAction;
    permission: CallPermission | null;
    body: CreditsEdit;
    task: Task;
    marked: boolean;
  },
  modeEscalation: ToolCallEscalation | null
): ToolCallEscalation | null {
  if (!agentEditRaisesCredits(call.body, call.task)) return modeEscalation;
  const area = call.permission?.area ?? 'tasks';
  // Let a marked turn reach the tool, decided as the tool's own action, which
  // refuses it with its own reason. No card: nothing it asks can run.
  if (call.marked) {
    return {
      action: call.action,
      permission: { area, state: 'allowed', source: 'floor', layer: 'floor' },
    };
  }
  // The mode escalator already let a refusal through: the tool refuses it.
  if (modeEscalation && modeEscalation.action.id === call.action.id) return modeEscalation;
  const base = modeEscalation ?? { action: call.action, permission: call.permission };
  return {
    action: base.action,
    // Always a card: credits are the owner's money, whatever the agent's level.
    permission:
      base.permission?.state === 'blocked'
        ? base.permission
        : { area, state: 'ask', source: 'always-asks', layer: 'floor' },
    change: base.change ? `${base.change} ${CREDITS_EDIT_CHANGE}` : CREDITS_EDIT_CHANGE,
  };
}
