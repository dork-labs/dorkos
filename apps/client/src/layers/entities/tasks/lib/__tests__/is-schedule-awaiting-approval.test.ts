import { describe, it, expect } from 'vitest';
import { isScheduleAwaitingApproval } from '../is-schedule-awaiting-approval';

describe('isScheduleAwaitingApproval', () => {
  it('is true for a schedule an agent proposed, which wants to run', () => {
    expect(
      isScheduleAwaitingApproval({ status: 'pending_approval', enabled: true, origin: null })
    ).toBe(true);
  });

  it('is false for a schedule a package shipped switched off (DOR-2059)', () => {
    expect(
      isScheduleAwaitingApproval({ status: 'pending_approval', enabled: false, origin: 'file' })
    ).toBe(false);
  });

  it('is true for a schedule a package shipped switched on, even though its origin is `file`', () => {
    expect(
      isScheduleAwaitingApproval({ status: 'pending_approval', enabled: true, origin: 'file' })
    ).toBe(true);
  });

  it('stays true when an agent hides its OWN proposal by flipping `enabled` (adversarial review)', () => {
    // `tasks_create` parks a schedule with `enabled: true` and `origin: null`
    // — it never went through file discovery — and `enabled` is
    // agent-writable, so an agent could call `tasks_update({ enabled: false
    // })` on its own proposal without touching `status`. `origin` is the one
    // field no update path ever sets, so the condition cannot be hidden this
    // way.
    expect(
      isScheduleAwaitingApproval({ status: 'pending_approval', enabled: false, origin: null })
    ).toBe(true);
  });

  it('is false for an active schedule', () => {
    expect(isScheduleAwaitingApproval({ status: 'active', enabled: true, origin: null })).toBe(
      false
    );
  });

  it('is false for a paused schedule', () => {
    expect(isScheduleAwaitingApproval({ status: 'paused', enabled: true, origin: null })).toBe(
      false
    );
  });
});
