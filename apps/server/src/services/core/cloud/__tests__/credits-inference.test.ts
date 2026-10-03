/**
 * The credits path, and the thing it has to get right: refusing.
 *
 * A launch that chose credits gets the endpoint and token, or a refusal; never
 * an empty object it could mistake for "run on whatever else is there". A
 * runtime that does not declare credits never gets a token, whatever is held.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import everyFormatFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token-every-format.json' with { type: 'json' };
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
  creditsRuntimeWired,
  creditsWiringReport,
  primeCreditsInferenceGated,
  resolveCreditsLaunch,
  resolveCreditsLaunchEnv,
  __setCreditsStateForTests,
} from '../credits-inference.js';
import {
  CREDITS_TOKEN_ENV_NAME,
  CreditsUnavailableError,
  asCreditsStopped,
  creditsEndpointFor,
  creditsEnvFor,
  creditsProtocolServed,
  creditsRefusalEvent,
} from '../credits-protocols.js';

const token = InferenceTokenSchema.parse(tokenFixture);
/** A clock an hour before the token expires: well outside the refresh margin. */
const live = () => Date.parse(token.expiresAt) - 60 * 60_000;
const DECLARES = {
  credits: { protocol: 'anthropic-messages' as const, scope: 'conversation' as const },
};
/** A token from a service that also serves the responses format. */
const everyFormat = InferenceTokenSchema.parse(everyFormatFixture);
const SPEAKS_CHAT = {
  credits: { protocol: 'openai-chat-completions' as const, scope: 'runtime' as const },
};
const SPEAKS_RESPONSES = {
  credits: { protocol: 'openai-responses' as const, scope: 'conversation' as const },
};

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

  it('gets the chat endpoint and the token in its own variable for the chat format', async () => {
    __setCreditsStateForTests({ token, now: live });
    const launch = await resolveCreditsLaunch(SPEAKS_CHAT, 'OpenCode', 0);
    expect(launch).toEqual({
      protocol: 'openai-chat-completions',
      baseUrl: token.endpoints.openaiChat,
      token: token.token,
      tokenId: token.tokenId,
    });
    expect(creditsEnvFor(launch)).toEqual({ [CREDITS_TOKEN_ENV_NAME]: token.token });
  });

  it('is refused for a format the held token does not serve, never sent to another endpoint', async () => {
    // The fixture token is from a service that does not serve `responses`.
    __setCreditsStateForTests({ token, now: live });
    await expect(resolveCreditsLaunch(SPEAKS_RESPONSES, 'Codex', 0)).rejects.toMatchObject({
      reason: 'not-supported',
      code: 'credits_unavailable',
    });
  });

  it('gets the responses endpoint once the service serves that format', async () => {
    __setCreditsStateForTests({
      token: everyFormat,
      now: () => Date.parse(everyFormat.expiresAt) - 3_600_000,
    });
    const launch = await resolveCreditsLaunch(SPEAKS_RESPONSES, 'Codex', 0);
    expect(launch.baseUrl).toBe(everyFormat.endpoints.openaiResponses);
    expect(launch.token).toBe(everyFormat.token);
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
    const launch = {
      protocol: 'anthropic-messages' as const,
      baseUrl: token.endpoints.anthropicMessages,
      token: token.token,
      tokenId: token.tokenId,
    };
    expect(Object.keys(creditsEnvFor(launch))).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
  });

  it('reports a runtime whose format is not served as not wired, though it declares credits', () => {
    // No live token: the optional format is not known to be served.
    expect(
      creditsWiringReport([
        { type: 'claude-code', ...DECLARES },
        { type: 'opencode', ...SPEAKS_CHAT },
        { type: 'codex', ...SPEAKS_RESPONSES },
      ]).runtimes
    ).toEqual({ 'claude-code': 'wired', opencode: 'wired', codex: 'follow-up' });
    // A token from a service that does not serve it: still not wired.
    __setCreditsStateForTests({ token, now: live });
    expect(creditsWiringReport([{ type: 'codex', ...SPEAKS_RESPONSES }]).runtimes.codex).toBe(
      'follow-up'
    );
    expect(creditsRuntimeWired(SPEAKS_RESPONSES)).toBe(false);
  });

  it('reports it as wired once the held token carries its endpoint', () => {
    __setCreditsStateForTests({
      token: everyFormat,
      now: () => Date.parse(everyFormat.expiresAt) - 3_600_000,
    });
    expect(creditsWiringReport([{ type: 'codex', ...SPEAKS_RESPONSES }]).runtimes.codex).toBe(
      'wired'
    );
    expect(creditsRuntimeWired(SPEAKS_RESPONSES)).toBe(true);
    expect(creditsRuntimeWired({})).toBe(false);
  });
});

describe('which endpoint serves which format', () => {
  it('answers the two formats every token carries, and the optional one only when present', () => {
    expect(creditsEndpointFor(token.endpoints, 'anthropic-messages')).toBe(
      token.endpoints.anthropicMessages
    );
    expect(creditsEndpointFor(token.endpoints, 'openai-chat-completions')).toBe(
      token.endpoints.openaiChat
    );
    expect(creditsEndpointFor(token.endpoints, 'openai-responses')).toBeNull();
    expect(creditsProtocolServed('openai-responses', null)).toBe(false);
    expect(creditsProtocolServed('openai-responses', everyFormat)).toBe(true);
    expect(creditsProtocolServed('openai-chat-completions', null)).toBe(true);
  });
});

describe('what a refused or stopped credits turn says', () => {
  it('turns a refusal into the credits card, and anything else into nothing', () => {
    expect(creditsRefusalEvent(new CreditsUnavailableError('off', 'Codex'))).toMatchObject({
      type: 'error',
      data: { code: 'credits_unavailable', reason: 'off' },
    });
    expect(creditsRefusalEvent(new Error('other'))).toBeNull();
  });

  it('says a refused token mid-turn as credits, never as the runtime’s own sign-in', () => {
    const stopped = asCreditsStopped(
      { type: 'error', data: { message: '401', category: 'auth_error' } },
      'Codex'
    );
    expect(stopped).toMatchObject({
      type: 'error',
      data: { code: 'credits_unavailable', reason: 'stopped', details: '401' },
    });
    expect((stopped.data as { message: string }).message).toContain('Codex');
    const other = { type: 'error' as const, data: { message: 'x', category: 'execution_error' } };
    expect(asCreditsStopped(other, 'Codex')).toBe(other);
  });
});
