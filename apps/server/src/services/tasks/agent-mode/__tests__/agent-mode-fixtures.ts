/**
 * Shared fixtures for the agent-mode tests (DOR-3703).
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-fixtures
 */
import type { PermissionMode } from '@dorkos/shared/types';
import type { AgentModeGrant } from '../agent-mode-door.js';

/** A grant as the door hands it over, for the parts these rules read. */
export function grantOf(over: {
  approves?: boolean;
  aboveDontAsk?: boolean;
  via?: 'card' | 'allowed';
  mode?: PermissionMode;
  snapshot?: string;
  vouched?: boolean;
  scheduledRaise?: boolean;
}): AgentModeGrant {
  return {
    decision: {
      kind: 'decided',
      state: 'allowed',
      permission: { area: 'tasks', state: 'allowed', source: 'preset', layer: 'default' },
      primary: over.approves ? 'tasks.approve' : 'tasks.set_mode',
      actions: [over.approves ? 'tasks.approve' : 'tasks.set_mode'],
      setsMode: !over.approves,
      approves: over.approves === true,
      mode: over.mode ?? 'bypassPermissions',
      previousMode: 'acceptEdits',
      aboveDontAsk: over.aboveDontAsk ?? true,
      raise: !over.approves,
      scheduledRaise: over.scheduledRaise === true,
      vouched: over.vouched === true,
      asks: [],
    },
    via: over.via ?? 'allowed',
    credential: 'in-session',
    resolved: 'home',
    ...(over.snapshot ? { snapshot: over.snapshot } : {}),
  };
}
