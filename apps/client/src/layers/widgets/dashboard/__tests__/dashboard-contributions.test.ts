import { describe, it, expect } from 'vitest';
import { DASHBOARD_SECTION_CONTRIBUTIONS } from '../model/dashboard-contributions';

/**
 * Retirement guard. The `promo` (dashboard-main), `your-agents` and
 * `system-status` sections were removed, not hidden — every job they did now
 * has a home elsewhere. If one of these ids shows up again, the section came
 * back from the dead and this test is the tripwire.
 */
describe('DASHBOARD_SECTION_CONTRIBUTIONS', () => {
  const ids = DASHBOARD_SECTION_CONTRIBUTIONS.map((section) => section.id);

  it.each(['promo', 'your-agents', 'system-status'])('no longer registers %s', (retired) => {
    expect(ids).not.toContain(retired);
  });

  it('still registers the sections Phase 2 moves', () => {
    expect(ids).toEqual(['composer', 'pending-approvals', 'needs-attention', 'recent-activity']);
  });

  it('orders sections by ascending priority', () => {
    const priorities = DASHBOARD_SECTION_CONTRIBUTIONS.map((section) => section.priority ?? 50);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('uses first-party ids — never the `extension:id` namespaced form', () => {
    for (const id of ids) {
      expect(id).not.toContain(':');
    }
  });
});
