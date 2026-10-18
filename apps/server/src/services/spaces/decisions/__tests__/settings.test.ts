/**
 * The money rule for the post checks: a key alone arms nothing, the switch is read once at module
 * scope, and no test run can see it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@dorkos/decisions';
import {
  DECISIONS_KEY_VARS,
  DECISIONS_PAID_FLAG,
  PAID_DECISIONS_ARMED,
  decisionSettings,
} from '../settings.js';

const KEYS = {
  COMMUNITY_DECISIONS_JEV_KEY: 'jev-key',
  COMMUNITY_DECISIONS_OPENAI_KEY: 'openai-key',
  COMMUNITY_DECISIONS_OPENAI_BASE_URL: 'http://models.test/v1',
  COMMUNITY_DECISIONS_OPENAI_MODEL: 'test-model-1',
};

/** A fetch that fails the test if anything calls it. */
const noNetwork: FetchLike = () => {
  throw new Error('No test may reach the network.');
};

describe('the paid switch for post checks', () => {
  it('is off in every test run', () => {
    // Turbo strips it from every task, and AGENTS.md promises no task passes it on. A test run
    // that saw it would be one step from spending.
    // eslint-disable-next-line no-restricted-syntax -- asserting what the test process can see
    expect(process.env[DECISIONS_PAID_FLAG]).toBeUndefined();
    expect(PAID_DECISIONS_ARMED).toBe(false);
  });

  it('arms nothing from keys alone, and names the keys that were left unarmed', () => {
    const settings = decisionSettings(KEYS, { paidArmed: false, fetch: noNetwork });
    expect(settings.models).toEqual([]);
    expect(settings.unarmedKeys).toEqual([DECISIONS_KEY_VARS.jev, DECISIONS_KEY_VARS.openai]);
  });

  it('ignores a copy of the switch in the environment it reads', () => {
    const settings = decisionSettings(
      { ...KEYS, [DECISIONS_PAID_FLAG]: '1' },
      { paidArmed: false, fetch: noNetwork }
    );
    expect(settings.models).toEqual([]);
  });

  it('is not armed by a later environment write: it was read when the module loaded', async () => {
    vi.stubEnv(DECISIONS_PAID_FLAG, '1');
    try {
      const reloaded = await import('../settings.js');
      expect(reloaded.PAID_DECISIONS_ARMED).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('arms each model that has its key once the switch is on, side by side', () => {
    const settings = decisionSettings(KEYS, { paidArmed: true, fetch: noNetwork });
    expect(settings.models.map((slot) => slot.check)).toEqual(['jev', 'openai']);
    expect(settings.unarmedKeys).toEqual([]);
    const only = decisionSettings(
      { COMMUNITY_DECISIONS_JEV_KEY: 'jev-key' },
      { paidArmed: true, fetch: noNetwork }
    );
    expect(only.models.map((slot) => slot.check)).toEqual(['jev']);
  });

  it('arms nothing with the switch on and no key', () => {
    expect(decisionSettings({}, { paidArmed: true, fetch: noNetwork }).models).toEqual([]);
  });

  it('refuses an OpenAI-format key with no server or model to call', () => {
    expect(() =>
      decisionSettings(
        { COMMUNITY_DECISIONS_OPENAI_KEY: 'k' },
        { paidArmed: true, fetch: noNetwork }
      )
    ).toThrow(/BASE_URL and COMMUNITY_DECISIONS_OPENAI_MODEL/u);
  });

  it('caps calls per model per day, 1000 unless the host says otherwise', () => {
    expect(decisionSettings({}, { paidArmed: false, fetch: noNetwork }).dailyCallCap).toBe(1000);
    expect(
      decisionSettings(
        { COMMUNITY_DECISIONS_DAILY_CAP: '25' },
        { paidArmed: false, fetch: noNetwork }
      ).dailyCallCap
    ).toBe(25);
    expect(() =>
      decisionSettings(
        { COMMUNITY_DECISIONS_DAILY_CAP: '-1' },
        { paidArmed: false, fetch: noNetwork }
      )
    ).toThrow();
  });
});
