import { describe, expect, it } from 'vitest';
import { describeOperatorOnlyRefusal } from '../operator-only-refusal.js';
import { fullPersonSettingRefusal } from '../../capabilities/person-setting-refusal.js';
import { findOperatorOnlyPaths, CONFIG_WRITE_POLICY } from '../config-write-policy.js';

const REFUSAL =
  "DorkOS can't wake this computer for scheduled tasks yet. They only run while it's awake.";

describe('scheduled waking guidance for an agent', () => {
  it('gives the exact approved refusal and the existing keep-awake path', () => {
    const message = describeOperatorOnlyRefusal(['keepAwake.wakeForScheduledTasks']);
    expect(message).toBe(REFUSAL);
  });

  it('keeps guidance for the other settings in a mixed patch', () => {
    const message = describeOperatorOnlyRefusal([
      'keepAwake.wakeForScheduledTasks',
      'auth.enabled',
    ]);
    expect(message).toContain(REFUSAL);
    expect(message).toContain('A person can change the other settings in Settings.');
    expect(message).toContain('auth.enabled');
  });

  it('leaves ordinary person-only guidance unchanged', () => {
    expect(describeOperatorOnlyRefusal(['auth.enabled'])).toContain(
      'Ask the person to change them in DorkOS Settings.'
    );
  });

  it('gives the exact approved refusal at Full autonomy', () => {
    const message = fullPersonSettingRefusal(['`keepAwake.wakeForScheduledTasks` (Safety limits)']);
    expect(message).toBe(REFUSAL);
  });

  it('preserves Full guidance for other settings in a mixed patch', () => {
    const message = fullPersonSettingRefusal([
      '`keepAwake.wakeForScheduledTasks` (Safety limits)',
      '`auth.enabled` (Reach & secrets)',
    ]);
    expect(message).toContain(REFUSAL);
    expect(message).toContain('A person can change the other settings in Settings.');
  });

  it('keeps enabling scheduled waking behind the person-only policy', () => {
    expect(CONFIG_WRITE_POLICY['keepAwake.wakeForScheduledTasks']).toBe('operator-only');
    expect(findOperatorOnlyPaths({ keepAwake: { wakeForScheduledTasks: true } })).toEqual([
      'keepAwake.wakeForScheduledTasks',
    ]);
  });
});
