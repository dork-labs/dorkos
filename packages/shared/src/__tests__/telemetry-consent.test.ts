import { describe, it, expect } from 'vitest';
import {
  isTelemetryDisabledByEnv,
  isTelemetryDebugEnabled,
  resolveTelemetryConsent,
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
