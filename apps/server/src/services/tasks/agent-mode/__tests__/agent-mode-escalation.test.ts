/**
 * Whose permission the approval card carries when two apply to one call.
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-escalation
 */
import { describe, it, expect } from 'vitest';
import type { CallPermission } from '../../../core/capabilities/permission-enforcement.js';
import type { GatedAction } from '../../../core/capabilities/tier-enforcement.js';
import { escalationFor } from '../agent-mode-escalation.js';
import type { AgentModeDecision } from '../agent-mode-decision.js';

const TOOL_ACTION = { id: 'tasks_update', title: 'Update a task' } as unknown as GatedAction;

describe('escalationFor', () => {
  it('keeps the operator’s Ask over the action’s own Allowed', () => {
    const own: CallPermission = {
      area: 'tasks',
      state: 'allowed',
      source: 'floor',
      layer: 'floor',
    };
    const outer: CallPermission = { area: 'tasks', state: 'ask', source: 'floor', layer: 'floor' };
    const decision = {
      kind: 'decided',
      state: 'allowed',
      permission: own,
      primary: 'tasks.set_mode',
      actions: ['tasks.set_mode'],
    } as unknown as AgentModeDecision;

    expect(escalationFor(decision, TOOL_ACTION, outer)!.permission?.state).toBe('ask');
  });
});
