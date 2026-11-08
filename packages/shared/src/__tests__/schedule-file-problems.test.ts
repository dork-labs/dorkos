import { describe, it, expect } from 'vitest';
import {
  hasMisplacedSchedulePermissions,
  MISPLACED_SCHEDULE_PERMISSIONS,
} from '../schedule-file-problems.js';
describe('only the server can identify its schedule fault', () => {
  it.each(['agent', undefined, null])('does not trust reason source %s', (reasonSource) => {
    expect(
      hasMisplacedSchedulePermissions({
        status: 'pending_approval',
        reason: MISPLACED_SCHEDULE_PERMISSIONS,
        reasonSource,
      })
    ).toBe(false);
  });
  it('recognizes the server fault on a parked schedule', () => {
    expect(
      hasMisplacedSchedulePermissions({
        status: 'pending_approval',
        reason: MISPLACED_SCHEDULE_PERMISSIONS,
        reasonSource: 'dorkos',
      })
    ).toBe(true);
  });
});
