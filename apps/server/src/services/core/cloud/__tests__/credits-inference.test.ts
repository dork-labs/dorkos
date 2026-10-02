/**
 * The credits path, and the thing it has to get right: refusing.
 *
 * A launch that chose credits gets the endpoint and token, or a refusal; never
 * an empty object it could mistake for "run on whatever else is there". A
 * runtime that does not declare credits never gets a token, whatever is held.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import { InferenceTokenSchema } from '@dork-labs/cloud-api';

const link = vi.hoisted(() => ({ linked: true }));
vi.mock('../v1-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../v1-client.js')>()),
  isCloudLinked: () => link.linked,
  readCloudInstanceToken: () => (link.linked ? 'ik' : null),
  captureCloudV1Context: () => null,
}));

import {
  CREDITS_KILL_SWITCH_NAME,
  creditsKilled,
  isCreditsKillSwitchOn,
} from '../credits-availability.js';
import {
  CreditsUnavailableError,
  creditsEnvFor,
  creditsWiringReport,
  primeCreditsInferenceGated,
  resolveCreditsLaunchEnv,
  __setCreditsStateForTests,
} from '../credits-inference.js';

const token = InferenceTokenSchema.parse(tokenFixture);
/** A clock an hour before the token expires: well outside the refresh margin. */
const live = () => Date.parse(token.expiresAt) - 60 * 60_000;
const DECLARES = { credits: { protocol: 'anthropic-messages' as const } };

describe('the credits kill switch', () => {
  it('names itself, so it stays findable', () => {
    expect(CREDITS_KILL_SWITCH_NAME).toBe('DORKOS_CLOUD_CREDITS');
  });

  it('only ever turns credits OFF: the old "1" arms nothing and switches nothing off', () => {
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) {
      expect(isCreditsKillSwitchOn(off)).toBe(true);
    }
    for (const notOff of [undefined, '', '1', 'true', 'yes', 'on', 'maybe']) {
      expect(isCreditsKillSwitchOn(notOff)).toBe(false);
    }
  });

  it('is not on in a test run, because no task passes it through', () => {
    expect(creditsKilled()).toBe(false);
  });

  it('stops a mint before any request when it is on', async () => {
    const capture = vi.fn(() => null);
    expect(await primeCreditsInferenceGated(true, capture)).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('a launch that chose credits', () => {
  beforeEach(() => {
    link.linked = true;
  });
  afterEach(() => {
    __setCreditsStateForTests({ token: null });
  });

  it('gets the endpoint and token it was handed', async () => {
    __setCreditsStateForTests({ token, now: live });
    expect(await resolveCreditsLaunchEnv(DECLARES, 'Claude Code', 0)).toEqual({
      ANTHROPIC_BASE_URL: token.endpoints.anthropicMessages,
      ANTHROPIC_AUTH_TOKEN: token.token,
    });
  });

  it('is refused, not emptied, when no live token can be had (fail closed)', async () => {
    __setCreditsStateForTests({ token: null });
    const refusal = resolveCreditsLaunchEnv(DECLARES, 'Claude Code', 0);
    await expect(refusal).rejects.toBeInstanceOf(CreditsUnavailableError);
    await expect(refusal).rejects.toMatchObject({
      reason: 'unreachable',
      code: 'credits_unavailable',
      message: expect.stringContaining("Couldn't reach DorkOS credits"),
    });
  });

  it('is never handed a token about to expire (inside the refresh margin)', async () => {
    __setCreditsStateForTests({ token, now: () => Date.parse(token.expiresAt) - 60_000 });
    await expect(resolveCreditsLaunchEnv(DECLARES, 'Claude Code', 0)).rejects.toMatchObject({
      reason: 'unreachable',
    });
  });

  it('is refused once the held token has expired', async () => {
    __setCreditsStateForTests({ token, now: () => Date.parse(token.expiresAt) + 1 });
    await expect(resolveCreditsLaunchEnv(DECLARES, 'Claude Code', 0)).rejects.toMatchObject({
      reason: 'unreachable',
    });
  });

  it('is refused when this computer is no longer linked, even holding a token', async () => {
    __setCreditsStateForTests({ token, now: live });
    link.linked = false;
    await expect(resolveCreditsLaunchEnv(DECLARES, 'Claude Code', 0)).rejects.toMatchObject({
      reason: 'not-linked',
    });
  });

  it('never hands a token to a runtime that does not declare credits', async () => {
    __setCreditsStateForTests({ token, now: live });
    await expect(resolveCreditsLaunchEnv({}, 'Codex', 0)).rejects.toMatchObject({
      reason: 'not-supported',
    });
  });

  it('names the runtime in the sentence, and offers its own sign-in', () => {
    const err = new CreditsUnavailableError('unreachable', 'Claude Code');
    expect(err.message).toBe(
      "Couldn't reach DorkOS credits, so nothing was sent. Try again, or use your Claude Code sign-in."
    );
  });
});

describe('the wiring report', () => {
  afterEach(() => {
    __setCreditsStateForTests({ token: null });
  });

  it('derives the wired set from what each runtime declares, never a list of its own', () => {
    const report = creditsWiringReport([
      { type: 'claude-code', ...DECLARES },
      { type: 'codex' },
      { type: 'opencode' },
    ]);
    expect(report.runtimes).toEqual({
      'claude-code': 'wired',
      codex: 'follow-up',
      opencode: 'follow-up',
    });
    expect(creditsWiringReport([{ type: 'claude-code' }]).runtimes['claude-code']).toBe(
      'follow-up'
    );
  });

  it('reports readiness without ever carrying the token or the endpoint', () => {
    __setCreditsStateForTests({ token, now: live });
    const report = creditsWiringReport([{ type: 'claude-code', ...DECLARES }]);
    expect(report.ready).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(token.token);
    expect(serialized).not.toContain(token.endpoints.anthropicMessages);
  });

  it('reports a runtime as wired only where its protocol really contributes an environment', () => {
    expect(Object.keys(creditsEnvFor(token, 'anthropic-messages'))).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
  });
});
