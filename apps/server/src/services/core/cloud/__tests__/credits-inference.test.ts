/**
 * The credits path, and the thing it has to get right: being OFF.
 *
 * The flag is read once at module scope, so these tests deliberately cannot
 * arm it — which is the property under test. What they do cover is the parsing
 * that decides, the inertness of every function while it is off, and the fact
 * that the report handed to the client carries no credential.
 */
import { describe, it, expect, afterEach } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };
import { InferenceTokenSchema } from '@dork-labs/cloud-api';
import {
  CREDITS_FLAG_NAME,
  creditsEnvFor,
  creditsFlagEnabled,
  creditsTurnEnv,
  creditsWiringReport,
  isCreditsFlagOn,
  __setCreditsStateForTests,
} from '../credits-inference.js';

const token = InferenceTokenSchema.parse(tokenFixture);

describe('the credits flag', () => {
  afterEach(() => {
    __setCreditsStateForTests({ token: null });
  });

  it('names itself, so the flag and its key stay findable together', () => {
    expect(CREDITS_FLAG_NAME).toBe('DORKOS_CLOUD_CREDITS');
  });

  it('reads the affirmative spellings and nothing else', () => {
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE', ' on ']) {
      expect(isCreditsFlagOn(on)).toBe(true);
    }
    for (const off of [undefined, '', '0', 'false', 'no', 'maybe']) {
      expect(isCreditsFlagOn(off)).toBe(false);
    }
  });

  it('is off in every test run, because no task passes it through', () => {
    expect(creditsFlagEnabled()).toBe(false);
  });

  it('contributes no turn environment while it is off, even holding a live token', () => {
    __setCreditsStateForTests({ token, now: () => Date.parse(token.expiresAt) - 1000 });
    expect(creditsTurnEnv('claude-code')).toEqual({});
    expect(creditsTurnEnv('opencode')).toEqual({});
    expect(creditsTurnEnv('codex')).toEqual({});
  });

  it('reports readiness without ever carrying the token, the endpoint or an amount', () => {
    __setCreditsStateForTests({ token, now: () => Date.parse(token.expiresAt) - 1000 });
    const report = creditsWiringReport();
    expect(report.enabled).toBe(false);
    expect(report.ready).toBe(true);
    expect(report.runtimes['claude-code']).toBe('wired');
    expect(report.runtimes.opencode).toBe('follow-up');
    expect(report.runtimes.codex).toBe('follow-up');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(token.token);
    expect(serialized).not.toContain(token.endpoints.anthropicMessages);
  });

  it('points Claude Code at the endpoint it was handed, once somebody turns it on', () => {
    // The ON path, which the wrapper can never reach because the flag is a
    // module constant. Without this, misspelling a variable name or deleting the
    // spread at the launch site would go unnoticed by every test in the repo.
    expect(creditsEnvFor(token, 'claude-code', true)).toEqual({
      ANTHROPIC_BASE_URL: token.endpoints.anthropicMessages,
      ANTHROPIC_AUTH_TOKEN: token.token,
    });
  });

  it('contributes nothing for a runtime that is not wired, or with no token', () => {
    expect(creditsEnvFor(token, 'opencode', true)).toEqual({});
    expect(creditsEnvFor(token, 'codex', true)).toEqual({});
    expect(creditsEnvFor(null, 'claude-code', true)).toEqual({});
    expect(creditsEnvFor(token, 'claude-code', false)).toEqual({});
  });

  it('reports a runtime as wired only where it really contributes an environment', () => {
    const report = creditsWiringReport();
    for (const [runtime, state] of Object.entries(report.runtimes)) {
      const wired = Object.keys(creditsEnvFor(token, runtime, true)).length > 0;
      expect(wired, `${runtime} claims ${state}`).toBe(state === 'wired');
    }
  });

  it('stops reporting ready once the held token is past its expiry', () => {
    __setCreditsStateForTests({ token, now: () => Date.parse(token.expiresAt) + 1000 });
    expect(creditsWiringReport().ready).toBe(false);
  });
});
