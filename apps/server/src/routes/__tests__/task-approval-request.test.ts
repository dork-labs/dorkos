import { describe, expect, it } from 'vitest';
import { createMockSchedule } from '@dorkos/test-utils';
import { taskApprovalRequestRefusal } from '../task-approval-request.js';

describe('task approval request limits', () => {
  it('refuses a mode looser than proposed without explicit confirmation', () => {
    const task = createMockSchedule({
      status: 'pending_approval',
      requestedPermissionMode: 'dontAsk',
    });

    expect(
      taskApprovalRequestRefusal(
        task,
        { status: 'active', permissionMode: 'acceptEdits' },
        undefined
      )
    ).toMatchObject({ code: 'looser_than_requested_confirmation_required' });
    expect(
      taskApprovalRequestRefusal(task, { status: 'active', permissionMode: 'acceptEdits' }, true)
    ).toBeNull();
  });

  it('refuses an outsider at edit power without explicit confirmation', () => {
    const task = createMockSchedule({
      status: 'pending_approval',
      originMarks: { outsider: true },
    });

    expect(
      taskApprovalRequestRefusal(
        task,
        { status: 'active', permissionMode: 'acceptEdits' },
        undefined
      )
    ).not.toBeNull();
  });

  it('refuses allow rules beyond the proposal without explicit confirmation', () => {
    const task = createMockSchedule({
      status: 'pending_approval',
      requestedAllow: ['Read(/tmp/report)'],
    });

    expect(
      taskApprovalRequestRefusal(
        task,
        { status: 'active', approvedAllow: ['Read(/tmp/report)', 'Write(/tmp/report)'] },
        undefined
      )
    ).not.toBeNull();
    expect(
      taskApprovalRequestRefusal(
        task,
        { status: 'active', approvedAllow: ['Read(/tmp/report)'] },
        undefined
      )
    ).toBeNull();
  });
});
