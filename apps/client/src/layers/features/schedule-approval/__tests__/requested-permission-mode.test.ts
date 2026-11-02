import { describe, expect, it } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { requestedPermissionMode } from '../lib/requested-permission-mode';

const modes: PermissionModeDescriptor[] = [
  {
    id: 'dontAsk',
    label: 'Never ask',
    stop: 'act',
    asks: 'never',
    reach: 'workspace',
    promise: 'Refuses unapproved tools.',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Asks before commands.',
  },
];

describe('requestedPermissionMode', () => {
  it.each(['Don’t ask', "Don't ask", 'Never ask', 'dontAsk'])(
    'recognizes %s in the reason',
    (label) => {
      expect(requestedPermissionMode(`Run this at ${label}.`, modes)?.id).toBe('dontAsk');
    }
  );
  it('leaves the saved choice alone for ambiguous and absent requests', () => {
    expect(requestedPermissionMode('Use Accept edits or Don’t ask.', modes)).toBeNull();
    expect(requestedPermissionMode('Triage the backlog.', modes)).toBeNull();
    expect(requestedPermissionMode(null, modes)).toBeNull();
  });
  it('cannot select a mode absent from this runtime', () => {
    expect(requestedPermissionMode('Use Don’t ask.', modes.slice(1))).toBeNull();
  });
  it('matches whole names, not a fragment of another word', () => {
    expect(requestedPermissionMode('dontAskAnything', modes)).toBeNull();
  });
  it('does not turn an explicitly rejected mode into a default', () => {
    expect(requestedPermissionMode('Do not use Don’t ask.', modes)).toBeNull();
    expect(requestedPermissionMode('Use Accept edits instead of Don’t ask.', modes)?.id).toBe(
      'acceptEdits'
    );
  });
  it('requires mode context for ordinary words such as plan', () => {
    const plan = { ...modes[0]!, id: 'plan', label: 'Plan' };
    expect(requestedPermissionMode('Plan the launch.', [plan])).toBeNull();
    expect(requestedPermissionMode('Run at Plan.', [plan])?.id).toBe('plan');
    expect(requestedPermissionMode('Needs plan mode.', [plan])?.id).toBe('plan');
  });
});
