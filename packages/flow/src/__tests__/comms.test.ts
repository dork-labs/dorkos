import { describe, it, expect } from 'vitest';
import { InvolvementSchema } from '../config-schema.js';
import { resolveCommsChannel, type CommsTrigger, type InvolvementConfig } from '../comms.js';
import type { IdentityMode } from '../identity.js';

/** The §9 resolved default involvement config — the oracle the spec ships. */
const DEFAULT_INVOLVEMENT: InvolvementConfig = InvolvementSchema.parse({});

/** Build a trigger with overridable source + live-session flag. */
function trigger(overrides: Partial<CommsTrigger> = {}): CommsTrigger {
  return { source: 'manual', liveSession: true, ...overrides };
}

describe('resolveCommsChannel — channel inference (§5)', () => {
  it('manual + live session (e.g. /flow auto in the terminal) → interactive (two-account)', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'manual', liveSession: true }),
      'two-account',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('interactive');
    expect(route.nudgePrimary).toBe(false);
  });

  it('manual + live session → interactive in SHARED mode too (live reachability wins)', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'manual', liveSession: true }),
      'shared',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('interactive');
    expect(route.nudgePrimary).toBe(false);
  });

  it('PM-driven + no live session, two-account (a Pulse tick) → comment-and-assign', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: false }),
      'two-account',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-assign');
    expect(route.nudgePrimary).toBe(false);
  });

  it('PM-driven + no live session, SHARED → comment-and-nudge (nudge primary)', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: false }),
      'shared',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-nudge');
    expect(route.nudgePrimary).toBe(true);
  });

  it('manual but AWAY (no live session), two-account routes like PM-driven → comment-and-assign', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'manual', liveSession: false }),
      'two-account',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-assign');
  });

  it('manual but AWAY in SHARED mode → comment-and-nudge', () => {
    const route = resolveCommsChannel(
      trigger({ source: 'manual', liveSession: false }),
      'shared',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-nudge');
    expect(route.nudgePrimary).toBe(true);
  });

  it('PM-driven WITH a live session still routes to the tracker (source is not interactive)', () => {
    // A PM-driven run is not the human-at-the-terminal door even if a session
    // happens to be attached; only manual + live session asks inline.
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: true }),
      'two-account',
      DEFAULT_INVOLVEMENT
    );
    expect(route.channel).toBe('comment-and-assign');
  });
});

describe('resolveCommsChannel — the full 3-channel matrix (trigger × identity mode)', () => {
  const cases: Array<{
    source: CommsTrigger['source'];
    liveSession: boolean;
    mode: IdentityMode;
    expected: string;
    nudgePrimary: boolean;
  }> = [
    // Live session → interactive in EITHER mode.
    {
      source: 'manual',
      liveSession: true,
      mode: 'two-account',
      expected: 'interactive',
      nudgePrimary: false,
    },
    {
      source: 'manual',
      liveSession: true,
      mode: 'shared',
      expected: 'interactive',
      nudgePrimary: false,
    },
    // Unattended, two-account → comment-and-assign.
    {
      source: 'manual',
      liveSession: false,
      mode: 'two-account',
      expected: 'comment-and-assign',
      nudgePrimary: false,
    },
    {
      source: 'pm-driven',
      liveSession: false,
      mode: 'two-account',
      expected: 'comment-and-assign',
      nudgePrimary: false,
    },
    {
      source: 'pm-driven',
      liveSession: true,
      mode: 'two-account',
      expected: 'comment-and-assign',
      nudgePrimary: false,
    },
    // Unattended, shared → comment-and-nudge (nudge primary).
    {
      source: 'manual',
      liveSession: false,
      mode: 'shared',
      expected: 'comment-and-nudge',
      nudgePrimary: true,
    },
    {
      source: 'pm-driven',
      liveSession: false,
      mode: 'shared',
      expected: 'comment-and-nudge',
      nudgePrimary: true,
    },
    {
      source: 'pm-driven',
      liveSession: true,
      mode: 'shared',
      expected: 'comment-and-nudge',
      nudgePrimary: true,
    },
  ];

  it.each(cases)(
    '$source + liveSession=$liveSession + $mode → $expected (nudgePrimary=$nudgePrimary)',
    ({ source, liveSession, mode, expected, nudgePrimary }) => {
      const route = resolveCommsChannel(
        trigger({ source, liveSession }),
        mode,
        DEFAULT_INVOLVEMENT
      );
      expect(route.channel).toBe(expected);
      expect(route.nudgePrimary).toBe(nudgePrimary);
    }
  );
});

describe('resolveCommsChannel — infer-from-trigger + nudge', () => {
  it('comms tone (concise/verbose) does NOT change the channel — only trigger + mode do', () => {
    const concise = InvolvementSchema.parse({ comms: 'concise' });
    const verbose = InvolvementSchema.parse({ comms: 'verbose' });
    const t = trigger({ source: 'manual', liveSession: true });
    expect(resolveCommsChannel(t, 'two-account', concise).channel).toBe('interactive');
    expect(resolveCommsChannel(t, 'shared', verbose).channel).toBe('interactive');
  });

  it('echoes the involvement.nudge flags verbatim (both off by default)', () => {
    const route = resolveCommsChannel(trigger(), 'two-account', DEFAULT_INVOLVEMENT);
    expect(route.nudge).toEqual({ relay: false, telegram: false });
  });

  it('passes configured nudge channels through for an out-of-band ping (two-account, courtesy)', () => {
    const withNudge = InvolvementSchema.parse({ nudge: { relay: true, telegram: true } });
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: false }),
      'two-account',
      withNudge
    );
    expect(route.channel).toBe('comment-and-assign');
    expect(route.nudge).toEqual({ relay: true, telegram: true });
    // Courtesy ping, not the primary ask, in two-account mode.
    expect(route.nudgePrimary).toBe(false);
  });

  it('in shared mode the configured nudge is the PRIMARY ask (comment-and-nudge)', () => {
    const withNudge = InvolvementSchema.parse({ nudge: { relay: true, telegram: false } });
    const route = resolveCommsChannel(
      trigger({ source: 'pm-driven', liveSession: false }),
      'shared',
      withNudge
    );
    expect(route.channel).toBe('comment-and-nudge');
    expect(route.nudge).toEqual({ relay: true, telegram: false });
    expect(route.nudgePrimary).toBe(true);
  });
});
