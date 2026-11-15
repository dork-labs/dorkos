import { describe, it, expect } from 'vitest';
import {
  isTelemetryDisabledByEnv,
  isTelemetryDebugEnabled,
  resolveTelemetryConsent,
  hasTier1SendGate,
  resolveTier1ChannelConsent,
  effectiveTier1Telemetry,
  tier1ChannelsSettledByFirstAnswer,
  TIER1_CHANNELS,
  TELEMETRY_DISABLE_ENV_VARS,
  TELEMETRY_DEBUG_ENV_VAR,
} from '../telemetry-consent.js';

describe('isTelemetryDisabledByEnv', () => {
  it('is false when no kill switch is set', () => {
    expect(isTelemetryDisabledByEnv({})).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'True', ' 1 ', '  true  '])(
    'treats DO_NOT_TRACK=%j as on',
    (value) => {
      expect(isTelemetryDisabledByEnv({ DO_NOT_TRACK: value })).toBe(true);
    }
  );

  it.each(['1', 'true', 'TrUe'])('treats DORKOS_TELEMETRY_DISABLED=%j as on', (value) => {
    expect(isTelemetryDisabledByEnv({ DORKOS_TELEMETRY_DISABLED: value })).toBe(true);
  });

  it.each(['0', 'false', '', 'yes', 'on', '2', 'no'])('treats DO_NOT_TRACK=%j as off', (value) => {
    expect(isTelemetryDisabledByEnv({ DO_NOT_TRACK: value })).toBe(false);
  });

  it('is on when either kill switch is on (independent)', () => {
    expect(isTelemetryDisabledByEnv({ DO_NOT_TRACK: '0', DORKOS_TELEMETRY_DISABLED: '1' })).toBe(
      true
    );
    expect(isTelemetryDisabledByEnv({ DO_NOT_TRACK: '1', DORKOS_TELEMETRY_DISABLED: '0' })).toBe(
      true
    );
  });

  it('exposes the exact kill-switch var names', () => {
    expect([...TELEMETRY_DISABLE_ENV_VARS]).toEqual(['DO_NOT_TRACK', 'DORKOS_TELEMETRY_DISABLED']);
  });
});

describe('isTelemetryDebugEnabled', () => {
  it.each(['1', 'true', 'TRUE', ' true '])('is true for %j', (value) => {
    expect(isTelemetryDebugEnabled({ [TELEMETRY_DEBUG_ENV_VAR]: value })).toBe(true);
  });

  it.each(['0', 'false', '', undefined])('is false for %j', (value) => {
    expect(isTelemetryDebugEnabled({ [TELEMETRY_DEBUG_ENV_VAR]: value })).toBe(false);
  });
});

describe('resolveTelemetryConsent (precedence: env > config)', () => {
  it('returns the config value when no kill switch is set', () => {
    expect(resolveTelemetryConsent(true, {})).toBe(true);
    expect(resolveTelemetryConsent(false, {})).toBe(false);
  });

  it('forces false when a kill switch is set, even if config opted in', () => {
    expect(resolveTelemetryConsent(true, { DO_NOT_TRACK: '1' })).toBe(false);
    expect(resolveTelemetryConsent(true, { DORKOS_TELEMETRY_DISABLED: 'true' })).toBe(false);
  });

  it('stays false when config is off regardless of env', () => {
    expect(resolveTelemetryConsent(false, { DO_NOT_TRACK: '1' })).toBe(false);
    expect(resolveTelemetryConsent(false, {})).toBe(false);
  });

  it('an off-valued kill switch does not disable an opted-in channel', () => {
    expect(resolveTelemetryConsent(true, { DO_NOT_TRACK: '0' })).toBe(true);
    expect(resolveTelemetryConsent(true, { DORKOS_TELEMETRY_DISABLED: 'false' })).toBe(true);
  });
});

describe('hasTier1SendGate (notice-before-first-send)', () => {
  it('is closed for a never-answered, never-prompted install', () => {
    expect(hasTier1SendGate({ userHasDecided: false, lastPromptedVersion: null })).toBe(false);
  });

  it('opens once the user has explicitly decided', () => {
    expect(hasTier1SendGate({ userHasDecided: true, lastPromptedVersion: null })).toBe(true);
  });

  it('opens once the first-run notice has been recorded', () => {
    expect(hasTier1SendGate({ userHasDecided: false, lastPromptedVersion: '0.47.0' })).toBe(true);
  });

  it('is open when both conditions hold', () => {
    expect(hasTier1SendGate({ userHasDecided: true, lastPromptedVersion: '0.47.0' })).toBe(true);
  });

  it('is closed for null/undefined config (defensive)', () => {
    expect(hasTier1SendGate(null)).toBe(false);
    expect(hasTier1SendGate(undefined)).toBe(false);
  });
});

// DOR-4400: consent is read from the person's answer, never from a migration.
describe('resolveTier1ChannelConsent', () => {
  // QA's #3643 row-5 case 1: every channel stored on, and nobody answered.
  const undecidedAllOn = { install: true, heartbeat: true, usage: true, userHasDecided: false };

  it.each(TIER1_CHANNELS)('reads %s as off when nobody has answered', (channel) => {
    expect(resolveTier1ChannelConsent(undecidedAllOn, channel, {})).toBe(false);
  });

  it.each(TIER1_CHANNELS)('reads %s as off when the answer is missing', (channel) => {
    expect(
      resolveTier1ChannelConsent({ install: true, heartbeat: true, usage: true }, channel, {})
    ).toBe(false);
  });

  it.each([1, 'true', null])('reads a non-boolean answer (%j) as no answer', (answer) => {
    const config = { install: true, heartbeat: true, usage: true, userHasDecided: answer };
    expect(resolveTier1ChannelConsent(config, 'install', {})).toBe(false);
  });

  it.each(TIER1_CHANNELS)('reads %s as on once the person said yes', (channel) => {
    expect(
      resolveTier1ChannelConsent({ ...undecidedAllOn, userHasDecided: true }, channel, {})
    ).toBe(true);
  });

  it('keeps a decided "off" off, and lets the env kill switch win', () => {
    const decided = { install: false, heartbeat: true, usage: true, userHasDecided: true };
    expect(resolveTier1ChannelConsent(decided, 'install', {})).toBe(false);
    expect(resolveTier1ChannelConsent(decided, 'heartbeat', { DO_NOT_TRACK: '1' })).toBe(false);
  });

  it('reads no telemetry block at all as off', () => {
    expect(resolveTier1ChannelConsent(undefined, 'usage', {})).toBe(false);
    expect(resolveTier1ChannelConsent(null, 'usage', {})).toBe(false);
  });
});

describe('effectiveTier1Telemetry', () => {
  it('shows an unanswered all-on block as all off, keeping everything else', () => {
    const stored = {
      install: true,
      heartbeat: true,
      usage: true,
      userHasDecided: false,
      errorReporting: false,
      lastPromptedVersion: '0.135.0',
    };
    expect(effectiveTier1Telemetry(stored)).toEqual({
      ...stored,
      install: false,
      heartbeat: false,
      usage: false,
    });
  });

  it('leaves an answered block exactly as stored', () => {
    const stored = { install: true, heartbeat: false, usage: true, userHasDecided: true };
    expect(effectiveTier1Telemetry(stored)).toEqual(stored);
  });
});

describe('tier1ChannelsSettledByFirstAnswer (DOR-4400 M1)', () => {
  const unanswered = { install: true, heartbeat: true, usage: true, userHasDecided: false };

  it('stores off every channel a first answer does not name', () => {
    expect(
      tier1ChannelsSettledByFirstAnswer(unanswered, { errorReporting: true, userHasDecided: true })
    ).toEqual({ install: false, heartbeat: false, usage: false });
  });

  it('keeps the channels the answer names', () => {
    expect(
      tier1ChannelsSettledByFirstAnswer(unanswered, { usage: true, userHasDecided: true })
    ).toEqual({ install: false, heartbeat: false });
  });

  it('does nothing when the person had already answered, or this is not an answer', () => {
    expect(
      tier1ChannelsSettledByFirstAnswer(
        { ...unanswered, userHasDecided: true },
        { userHasDecided: true }
      )
    ).toEqual({});
    expect(tier1ChannelsSettledByFirstAnswer(unanswered, { errorReporting: true })).toEqual({});
    expect(tier1ChannelsSettledByFirstAnswer(unanswered, undefined)).toEqual({});
  });

  it('treats a missing stored block as unanswered', () => {
    expect(tier1ChannelsSettledByFirstAnswer(undefined, { userHasDecided: true })).toEqual({
      install: false,
      heartbeat: false,
      usage: false,
    });
  });
});

describe('resolveTelemetryConsent (DOR-4400 S3)', () => {
  it('reads only an exact true as on', () => {
    expect(resolveTelemetryConsent(true, {})).toBe(true);
    for (const value of [1, 'true', null, undefined, {}]) {
      expect(resolveTelemetryConsent(value as unknown as boolean, {})).toBe(false);
    }
  });
});
