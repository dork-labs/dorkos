import { describe, it, expect } from 'vitest';
import { isScheduleAwaitingApproval } from '../is-schedule-awaiting-approval';

describe('isScheduleAwaitingApproval', () => {
  it('is true for a schedule pending approval that wants to run', () => {
    expect(isScheduleAwaitingApproval({ status: 'pending_approval', enabled: true })).toBe(true);
  });

  it('is false for a schedule pending approval that ships switched off (DOR-2059)', () => {
    expect(isScheduleAwaitingApproval({ status: 'pending_approval', enabled: false })).toBe(false);
  });

  it('is false for an active schedule', () => {
    expect(isScheduleAwaitingApproval({ status: 'active', enabled: true })).toBe(false);
  });

  it('is false for a paused schedule', () => {
    expect(isScheduleAwaitingApproval({ status: 'paused', enabled: true })).toBe(false);
  });
});
