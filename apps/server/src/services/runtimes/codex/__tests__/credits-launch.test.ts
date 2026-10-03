/**
 * What a Codex turn on DorkOS credits is handed (ADR 261001-000811): its own
 * home, the credits provider entry, and nothing of the person's that routes a
 * turn or pays for one. The real binary's behaviour with these options is
 * proved in `credits-provider.binary.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDITS_TOKEN_ENV_NAME } from '../../../core/cloud/credits-protocols.js';
import {
  CODEX_CREDITS_PROVIDER_ID,
  codexCreditsProcessEnv,
  codexRoutesOrPays,
  threadRunsOnCredits,
  withCodexCredits,
} from '../credits-launch.js';
import { creditsCodexHome } from '../codex-home.js';

const LAUNCH = {
  protocol: 'openai-responses' as const,
  baseUrl: 'https://credits.invalid/openai/v1',
  token: 'tok-not-a-secret',
  tokenId: 'it_1',
};

let dorkHome: string;
beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-credits-home-'));
  vi.stubEnv('DORK_HOME', dorkHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('the credits home', () => {
  it('is a folder DorkOS owns, never the person’s Codex home', () => {
    expect(creditsCodexHome()).toBe(path.join(dorkHome, 'runtimes', 'codex', 'credits'));
  });

  it('decides which side a thread is on by where its rollout lives', async () => {
    const threadId = '01a0fe54-278e-76b2-a9e7-f0eab09acc17';
    expect(await threadRunsOnCredits(threadId)).toBe(false);
    const stamp = Number.parseInt('01a0fe54278e', 16);
    const day = new Date(stamp);
    const dir = path.join(
      creditsCodexHome(),
      'sessions',
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-10-02T15-35-23-${threadId}.jsonl`), '{}\n');
    expect(await threadRunsOnCredits(threadId)).toBe(true);
    expect(await threadRunsOnCredits('not-a-thread-id')).toBe(false);
  });
});

describe('what routes a Codex turn or pays for one', () => {
  it.each([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'CODEX_API_KEY',
    'CODEX_HOME',
    'CODEX_SOMETHING_NEW',
    'AZURE_OPENAI_API_KEY',
  ])('%s does', (name) => expect(codexRoutesOrPays(name)).toBe(true));

  it.each([
    'PATH',
    'HOME',
    'GITHUB_TOKEN',
    'DORKOS_AGENT_TOKEN',
    'DORKOS_MCP_HDR_X',
    'HTTPS_PROXY',
  ])('%s does not', (name) => expect(codexRoutesOrPays(name)).toBe(false));
});

describe('a credits turn’s environment', () => {
  it('drops the person’s keys, endpoint and home, and carries the credits home and token', () => {
    const env = codexCreditsProcessEnv(
      {
        PATH: '/bin',
        HOME: '/Users/person',
        CODEX_HOME: '/Users/person/.codex',
        OPENAI_API_KEY: 'person-key',
        CODEX_API_KEY: 'person-key-2',
        OPENAI_BASE_URL: 'https://elsewhere.invalid',
        DORKOS_AGENT_TOKEN: 'agent',
        GITHUB_TOKEN: 'gh',
      },
      LAUNCH
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/Users/person',
      DORKOS_AGENT_TOKEN: 'agent',
      GITHUB_TOKEN: 'gh',
      CODEX_HOME: creditsCodexHome(),
      [CREDITS_TOKEN_ENV_NAME]: LAUNCH.token,
    });
  });
});

describe('a credits turn’s client options', () => {
  it('select the credits provider, name the token’s variable, and keep the token out of config', () => {
    const options = withCodexCredits(
      {
        codexPathOverride: '/bin/codex',
        config: { mcp_servers: { dorkos: { url: 'http://127.0.0.1:1/mcp' } } },
        env: { PATH: '/bin', OPENAI_API_KEY: 'person-key' },
      },
      LAUNCH
    );
    expect(options.codexPathOverride).toBe('/bin/codex');
    expect(options.config).toEqual({
      mcp_servers: { dorkos: { url: 'http://127.0.0.1:1/mcp' } },
      model_provider: CODEX_CREDITS_PROVIDER_ID,
      model_providers: {
        [CODEX_CREDITS_PROVIDER_ID]: {
          name: 'DorkOS credits',
          base_url: LAUNCH.baseUrl,
          env_key: CREDITS_TOKEN_ENV_NAME,
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    });
    // `config` becomes visible argv: the token must never be in it.
    expect(JSON.stringify(options.config)).not.toContain(LAUNCH.token);
    expect(options.env).toEqual({
      PATH: '/bin',
      CODEX_HOME: creditsCodexHome(),
      [CREDITS_TOKEN_ENV_NAME]: LAUNCH.token,
    });
  });

  it('win over a provider any other contributor put in config', () => {
    const options = withCodexCredits(
      { config: { model_provider: 'theirs', model_providers: { theirs: {} } }, env: {} },
      LAUNCH
    );
    expect(options.config?.model_provider).toBe(CODEX_CREDITS_PROVIDER_ID);
    expect(Object.keys(options.config?.model_providers as object)).toEqual([
      CODEX_CREDITS_PROVIDER_ID,
    ]);
  });
});
