import { describe, expect, it } from 'vitest';
import {
  ALL_STEPS,
  REMOTE_RUN_STEPS,
  REMOTE_SKIPPED_STEPS,
  assertEveryStepAccounted,
  runsStep,
  stepIdOf,
} from '../plan.js';

describe('two-Desktop step plan', () => {
  it('a remote run takes or skips every step exactly once', () => {
    // Catches a step dropped from both lists, or listed in both.
    const skipped = Object.keys(REMOTE_SKIPPED_STEPS);
    const all = [...REMOTE_RUN_STEPS, ...skipped];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ALL_STEPS].sort());
    expect(ALL_STEPS).toHaveLength(30); // 1-29 with 15b
  });

  it('runs the remote journey the spec names and gives every skip a reason', () => {
    // Pins the run list to spec community-launch-acceptance task 1.2 (5-7 and 9-15b, 17-20, 22,
    // 23, 25): step 8 is skipped because it needs the second community remote mode never starts.
    expect(REMOTE_RUN_STEPS).toEqual([
      '5',
      '6',
      '7',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '15b',
      '17',
      '18',
      '19',
      '20',
      '22',
      '23',
      '25',
    ]);
    for (const reason of Object.values(REMOTE_SKIPPED_STEPS))
      expect(reason.length).toBeGreaterThan(20);
  });

  it('a local run takes every step', () => {
    // Catches remote-mode skips leaking into the ordinary local run.
    for (const id of ALL_STEPS) expect(runsStep('local', id)).toBe(true);
  });

  it('reads a step id from the start of its name only', () => {
    // Catches "15b" being read as "15", and unnumbered steps being counted.
    expect(stepIdOf('15b a reader scrolled up reopens at that row')).toBe('15b');
    expect(stepIdOf('15 A switches back to the community')).toBe('15');
    expect(stepIdOf('1 (skipped)')).toBe('1');
    expect(stepIdOf('remote: B signs in on the live community')).toBeNull();
    expect(stepIdOf('30 not a step')).toBeNull();
  });

  it('a finished run must account for every step, the way its mode says', () => {
    // Catches a journey stage that forgets to record a skip, or runs a skipped step.
    const remote = ALL_STEPS.map((id) =>
      runsStep('remote', id)
        ? { name: `${id} ran`, ok: true }
        : { name: `${id} (skipped)`, skipped: 'remote-mode' as const }
    );
    expect(() => assertEveryStepAccounted('remote', remote)).not.toThrow();
    expect(() => assertEveryStepAccounted('remote', remote.slice(1))).toThrow(
      /step 1 recorded 0 times/
    );
    expect(() => assertEveryStepAccounted('remote', [...remote, remote[4]!])).toThrow(
      /step 5 recorded 2 times/
    );
    const ranSixteen = remote.map((r) =>
      r.name.startsWith('16 ') ? { name: '16 ran', ok: true } : r
    );
    expect(() => assertEveryStepAccounted('remote', ranSixteen)).toThrow(/step 16 ran/);
    expect(() => assertEveryStepAccounted('local', remote)).toThrow(/a local run ran it/);
  });
});
