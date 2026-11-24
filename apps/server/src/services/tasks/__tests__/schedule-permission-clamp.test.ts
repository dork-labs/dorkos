import { describe, it, expect } from 'vitest';
import { needsScheduleApprovalAttention } from '../schedule-permission-clamp.js';

describe('needsScheduleApprovalAttention', () => {
  it.each([
    ['an agent proposal that wants to run', 'pending_approval', true, null, true],
    [
      'a package schedule shipped switched off (DOR-2059)',
      'pending_approval',
      false,
      'file',
      false,
    ],
    ['a package schedule shipped switched on', 'pending_approval', true, 'file', true],
    // `enabled` is agent-writable; `origin` is the one field no update path
    // sets, so an agent cannot hide its own proposal by switching it off.
    ['an agent proposal the agent switched off', 'pending_approval', false, null, true],
    ['an active schedule', 'active', true, null, false],
  ] as const)('%s', (_label, status, enabled, origin, expected) => {
    expect(needsScheduleApprovalAttention({ status, enabled, origin })).toBe(expected);
  });
});
