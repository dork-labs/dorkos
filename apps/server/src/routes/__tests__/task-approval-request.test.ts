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

  it('measures a raise from the saved mode when nothing was requested (D-1)', () => {
    const task = createMockSchedule({ status: 'pending_approval', permissionMode: 'default' });

    expect(
      taskApprovalRequestRefusal(
        task,
        { status: 'active', permissionMode: 'bypassPermissions' },
        undefined
      )
    ).not.toBeNull();
    expect(taskApprovalRequestRefusal(task, { status: 'active' }, undefined)).toBeNull();
  });

  it('asks for the confirmation before any rule that runs programs (D-2)', () => {
    const task = createMockSchedule({
      status: 'pending_approval',
      permissionMode: 'dontAsk',
      requestedPermissionMode: 'dontAsk',
      requestedAllow: ['Bash(/abs/report.sh --once)'],
    });
    const update = { status: 'active' as const, approvedAllow: ['Bash(/abs/report.sh --once)'] };

    expect(taskApprovalRequestRefusal(task, update, undefined)).not.toBeNull();
    expect(taskApprovalRequestRefusal(task, update, true)).toBeNull();
  });

  it('asks for the confirmation before an outsider’s requested rules (D-3)', () => {
    const task = createMockSchedule({
      status: 'pending_approval',
      permissionMode: 'dontAsk',
      originMarks: { outsider: true },
      requestedPermissionMode: 'dontAsk',
      requestedAllow: ['Read(/abs/notes/today.md)'],
    });
    const update = { status: 'active' as const, approvedAllow: ['Read(/abs/notes/today.md)'] };

    expect(taskApprovalRequestRefusal(task, update, undefined)).not.toBeNull();
    expect(taskApprovalRequestRefusal(task, update, true)).toBeNull();
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
  it('takes the separate yes for a file-writing rule outside the task folder', () => {
    const task = createMockSchedule({
      status: 'pending_approval',
      requestedPermissionMode: 'acceptEdits',
      permissionMode: 'acceptEdits',
      requestedAllow: ['Edit(~/.zshrc)'],
    });
    const update = { status: 'active' as const, approvedAllow: ['Edit(~/.zshrc)'] };
    expect(taskApprovalRequestRefusal(task, update, undefined)).not.toBeNull();
    expect(taskApprovalRequestRefusal(task, update, true)).toBeNull();
    // A relative path stays in the task's own folder and needs no extra yes.
    const inside = { status: 'active' as const, approvedAllow: ['Edit(notes/today.md)'] };
    expect(
      taskApprovalRequestRefusal(
        { ...task, requestedAllow: ['Edit(notes/today.md)'] },
        inside,
        undefined
      )
    ).toBeNull();
  });
});
