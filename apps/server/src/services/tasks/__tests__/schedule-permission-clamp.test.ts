import { describe, it, expect } from 'vitest';
import { needsScheduleApprovalAttention } from '../schedule-permission-clamp.js';

describe('needsScheduleApprovalAttention', () => {
  it('is true for a schedule pending approval that wants to run', () => {
    expect(needsScheduleApprovalAttention({ status: 'pending_approval', enabled: true })).toBe(
      true
    );
  });

  it('is false for a schedule a package shipped switched off (DOR-2059)', () => {
    expect(needsScheduleApprovalAttention({ status: 'pending_approval', enabled: false })).toBe(
      false
    );
  });

  it('is false for an active schedule', () => {
    expect(needsScheduleApprovalAttention({ status: 'active', enabled: true })).toBe(false);
  });

  it('is false for a paused schedule', () => {
    expect(needsScheduleApprovalAttention({ status: 'paused', enabled: true })).toBe(false);
  });
});
