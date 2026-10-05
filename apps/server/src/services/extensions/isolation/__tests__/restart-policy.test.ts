/**
 * RestartPolicy (DOR-2686 task 3.5): restarts back off 1 s, 5 s, then 30 s;
 * the third unexpected exit inside 10 minutes ends the attempts; exits spread
 * wider than the window keep restarting; reset forgets everything.
 */
import { describe, expect, it } from 'vitest';
import { RestartPolicy } from '../restart-policy.js';

/** A policy on a clock the test moves. */
function policyAt(start = 0): { policy: RestartPolicy; advance: (ms: number) => void } {
  let t = start;
  return { policy: new RestartPolicy({ now: () => t }), advance: (ms) => (t += ms) };
}

describe('RestartPolicy', () => {
  // Purpose: the spec's sequence inside one window: 1 s, 5 s, then stop.
  it('backs off, then gives up on the third exit within 10 minutes', () => {
    const { policy, advance } = policyAt();
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 1_000 });
    advance(60_000);
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 5_000 });
    advance(60_000);
    expect(policy.onUnexpectedExit()).toEqual({ giveUp: true });
  });

  // Purpose: exits spread beyond the window keep restarting, and the delay
  // keeps climbing to 30 s (a slow crash loop backs off too).
  it('keeps restarting exits spread wider than the window', () => {
    const { policy, advance } = policyAt();
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 1_000 });
    advance(6 * 60_000);
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 5_000 });
    advance(6 * 60_000);
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 30_000 });
    advance(6 * 60_000);
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 30_000 });
  });

  // Purpose: reset (reload, enable, approve) clears the budget and the backoff.
  it('forgets everything on reset', () => {
    const { policy, advance } = policyAt();
    policy.onUnexpectedExit();
    advance(1_000);
    policy.onUnexpectedExit();
    policy.reset();
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 1_000 });
    expect(policy.onUnexpectedExit()).toEqual({ restartIn: 5_000 });
    expect(policy.onUnexpectedExit()).toEqual({ giveUp: true });
  });
});
