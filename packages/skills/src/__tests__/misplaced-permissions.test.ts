import { describe, expect, it } from 'vitest';
import { SkillFrontmatterSchema } from '../schema.js';
import { hasSchedule, scheduleProblem } from '../schedule-schema.js';
import { MISPLACED_SCHEDULE_PERMISSIONS } from '@dorkos/shared/schedule-file-problems';

describe('misplaced schedule permissions', () => {
  it.each(['plan', 'acceptEdits', 'auto', 'bypassPermissions', 'imaginary', null, 42, false, {}])(
    'reports the presence of %j without granting it',
    (permissions) => {
      const meta = SkillFrontmatterSchema.parse({
        name: 'sample',
        description: 'Sample',
        permissions,
        schedule: { cron: '0 3 * * *' },
      });
      expect(scheduleProblem(meta)).toBe(MISPLACED_SCHEDULE_PERMISSIONS);
      expect(hasSchedule(meta)).toBe(true);
      if (hasSchedule(meta)) expect(meta.schedule.permissions).toBe('acceptEdits');
    }
  );
  it('keeps a valid nested mode and still reports a misplaced key', () => {
    const meta = SkillFrontmatterSchema.parse({
      name: 'sample',
      description: 'Sample',
      permissions: 'bypassPermissions',
      schedule: { permissions: 'plan' },
    });
    expect(scheduleProblem(meta)).toBe(MISPLACED_SCHEDULE_PERMISSIONS);
    if (hasSchedule(meta)) expect(meta.schedule.permissions).toBe('plan');
  });
  it('accepts the mode once it is moved under schedule', () => {
    const meta = SkillFrontmatterSchema.parse({
      name: 'sample',
      description: 'Sample',
      schedule: { permissions: 'plan' },
    });
    expect(scheduleProblem(meta)).toBeNull();
    if (hasSchedule(meta)) expect(meta.schedule.permissions).toBe('plan');
  });
  it('leaves an ordinary skill without a schedule alone', () => {
    const meta = SkillFrontmatterSchema.parse({
      name: 'sample',
      description: 'Sample',
      permissions: 'plan',
    });
    expect(scheduleProblem(meta)).toBeNull();
    expect(hasSchedule(meta)).toBe(false);
  });
});
