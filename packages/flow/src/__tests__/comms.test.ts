import { describe, it, expect } from 'vitest';
import { InvolvementSchema } from '../config-schema.js';
import { resolveCommsChannel, type CommsTrigger, type InvolvementConfig } from '../comms.js';

/** The §9 resolved default involvement config — the oracle the spec ships. */
const DEFAULT_INVOLVEMENT: InvolvementConfig = InvolvementSchema.parse({});

/** Build a trigger with overridable source + live-session flag. */
function trigger(overrides: Partial<CommsTrigger> = {}): CommsTrigger {
  return { source: 'manual', liveSession: true, ...overrides };
}

describe('resolveCommsChannel — channel inference (§5)', () => {
  it('manual + live session (e.g. /flow auto in the terminal) → interactive', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'manual', liveSession: true }),
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('interactive');
  });

  it('PM-driven + no live session (a Pulse tick) → comment-and-assign', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: false }),
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-assign');
  });

  it('manual but AWAY (no live session) routes like PM-driven → comment-and-assign', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'manual', liveSession: false }),
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-assign');
  });

  it('PM-driven WITH a live session still routes to the tracker (source is not interactive)', () => {
    // A PM-driven run is not the human-at-the-terminal door even if a session
    // happens to be attached; only manual + live session asks inline.
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: true }),
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-assign');
  });
});

describe('resolveCommsChannel — the full 2×2 routing matrix', () => {
  const cases: Array<{ source: CommsTrigger['source']; liveSession: boolean; expected: string }> = [
    { source: 'manual', liveSession: true, expected: 'interactive' },
    { source: 'manual', liveSession: false, expected: 'comment-and-assign' },
    { source: 'pm-driven', liveSession: true, expected: 'comment-and-assign' },
    { source: 'pm-driven', liveSession: false, expected: 'comment-and-assign' },
  ];

  it.each(cases)(
    '$source + liveSession=$liveSession → $expected',
    ({ source, liveSession, expected }) => {
      const route = resolveCommsChannel(trigger({ source, liveSession }), DEFAULT_INVOLVEMENT);
      expect(route.channel).toBe(expected);
    }
  );
});

describe('resolveCommsChannel — infer-from-trigger + nudge', () => {
  it('comms tone (concise/verbose) does NOT change the channel — only the trigger does', () => {
    const concise = InvolvementSchema.parse({ comms: 'concise' });
    const verbose = InvolvementSchema.parse({ comms: 'verbose' });
    const t = trigger({ source: 'manual', liveSession: true });
    expect(resolveCommsChannel(t, concise).channel).toBe('interactive');
    expect(resolveCommsChannel(t, verbose).channel).toBe('interactive');
  });

  it('echoes the involvement.nudge flags verbatim (both off by default)', () => {
    const route = resolveCommsChannel(trigger(), DEFAULT_INVOLVEMENT);
    expect(route.nudge).toEqual({ relay: false, telegram: false });
  });

  it('passes configured nudge channels through for an out-of-band ping', () => {
    const withNudge = InvolvementSchema.parse({ nudge: { relay: true, telegram: true } });
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: false }),
      withNudge
    );
    expect(route.channel).toBe('comment-and-assign');
    expect(route.nudge).toEqual({ relay: true, telegram: true });
  });
});
