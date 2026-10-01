/**
 * The pieces of a credits launch (ADR 261001-000811): what the process env
 * keeps, what the launch's own settings blank or put back over a folder's, which
 * folder settings a turn can be redirected by, and how a
 * credits turn's sign-in failure is said.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  asCreditsStopped,
  creditsProcessEnv,
  creditsSettingsEnv,
  folderSettingsFiles,
  routesOrPays,
} from '../credits-launch.js';

describe('the process env of a credits turn', () => {
  it('keeps the baseline, DorkOS’s own names and the git hardening, and nothing else', () => {
    const env = creditsProcessEnv(
      {
        PATH: '/bin',
        HTTPS_PROXY: 'http://proxy',
        CLAUDE_CONFIG_DIR: '/credits',
        DORKOS_AGENT_TOKEN: 'agent',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/dev/null',
        ANTHROPIC_API_KEY: 'own-key',
        ANTHROPIC_MODEL: 'some-arn',
        CLAUDE_CODE_USE_SOMETHING_NEW: '1',
        GITHUB_TOKEN: 'inherited',
      },
      { ANTHROPIC_BASE_URL: 'http://credits', ANTHROPIC_AUTH_TOKEN: 'tok' }
    );
    expect(Object.keys(env).sort()).toEqual(
      [
        'PATH',
        'HTTPS_PROXY',
        'CLAUDE_CONFIG_DIR',
        'DORKOS_AGENT_TOKEN',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
      ].sort()
    );
  });

  it('keeps the person’s inherit list, minus every name that routes or pays', () => {
    const env = creditsProcessEnv(
      {
        PATH: '/bin',
        DATABASE_URL: 'postgres://local',
        GITHUB_TOKEN: 'gh',
        ANTHROPIC_API_KEY: 'own-key',
        AWS_SECRET_ACCESS_KEY: 'aws',
        GOOGLE_APPLICATION_CREDENTIALS: '/gcp.json',
        CLAUDE_CODE_USE_BEDROCK: '1',
      },
      { ANTHROPIC_BASE_URL: 'http://credits', ANTHROPIC_AUTH_TOKEN: 'tok' },
      [
        'DATABASE_URL',
        'GITHUB_TOKEN',
        'ANTHROPIC_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'CLAUDE_CODE_USE_BEDROCK',
      ]
    );
    expect(env).toEqual({
      PATH: '/bin',
      DATABASE_URL: 'postgres://local',
      GITHUB_TOKEN: 'gh',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GOOGLE_APPLICATION_CREDENTIALS: '/gcp.json',
      ANTHROPIC_BASE_URL: 'http://credits',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
  });
});

describe('which names route a turn or pay for one', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_SOMETHING_NEW',
    'CLAUDE_CODE_USE_SOMETHING_NEW',
    'CLAUDE_CODE_SKIP_SOMETHING_AUTH',
    'CLAUDE_CODE_OAUTH_TOKEN',
    '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
    'AWS_BEARER_TOKEN_BEDROCK',
  ])('%s routes or pays', (name) => expect(routesOrPays(name)).toBe(true));

  // The agent's own cloud tools keep their accounts: with every CLAUDE_CODE_USE_*
  // switch blanked, these cannot route or pay for a Claude Code turn.
  it.each([
    'PATH',
    'DATABASE_URL',
    'GITHUB_TOKEN',
    'MAX_THINKING_TOKENS',
    'NODE_OPTIONS',
    'AWS_PROFILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'CLOUDSDK_CONFIG',
    'AZURE_CLIENT_SECRET',
  ])('%s does not', (name) => expect(routesOrPays(name)).toBe(false));
});

describe('the launch’s own settings over a folder’s', () => {
  let folder: string;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-settings-'));
    fs.mkdirSync(path.join(folder, '.claude'));
  });
  afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

  const writeSettings = (settings: unknown, file = 'settings.json') =>
    fs.writeFileSync(path.join(folder, '.claude', file), JSON.stringify(settings));

  it('leaves a folder’s own variables alone and puts the server’s PATH, proxy and certificates back', () => {
    writeSettings({
      env: {
        PATH: '/folder/bin',
        DATABASE_URL: 'postgres://folder',
        HTTPS_PROXY: 'http://folder-proxy',
        NODE_EXTRA_CA_CERTS: '/folder/ca.pem',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        ANTHROPIC_MODEL: 'folder-model',
        AWS_PROFILE: 'folder',
      },
    });
    const env = creditsSettingsEnv(folder, 'http://credits', {
      PATH: '/server/bin',
      HTTPS_PROXY: 'http://server-proxy',
    });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/server/bin');
    expect(env.HTTPS_PROXY).toBe('http://server-proxy');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('');
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('');
    expect(env.ANTHROPIC_MODEL).toBe('');
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://credits');
  });

  it('never blanks PATH, even when the turn’s own env has none', () => {
    writeSettings({ env: { PATH: '/folder/bin' } });
    const env = creditsSettingsEnv(folder, 'http://credits', {});
    expect(env.PATH).not.toBe('');
    expect(env.PATH).not.toBe('/folder/bin');
  });

  it('puts nothing on the command line for a proxy a folder did not set', () => {
    const env = creditsSettingsEnv(folder, 'http://credits', { HTTPS_PROXY: 'http://u:p@proxy' });
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.PATH).toBeUndefined();
  });

  it.each([[{ apiKeyHelper: 'echo key' }], [{ env: { ANTHROPIC_AUTH_TOKEN: 'folder-token' } }]])(
    'refuses a folder with its own sign-in: %j',
    (settings) => {
      writeSettings(settings, 'settings.local.json');
      expect(() => creditsSettingsEnv(folder, 'http://credits', {})).toThrow(
        expect.objectContaining({ code: 'credits_unavailable', reason: 'folder-sign-in' })
      );
    }
  );
});

describe('which folder settings a credits turn reads', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-folders-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the working directory’s and its repository root’s .claude settings', () => {
    fs.mkdirSync(path.join(root, '.git'));
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    expect(folderSettingsFiles(sub)).toEqual([
      path.join(sub, '.claude', 'settings.json'),
      path.join(sub, '.claude', 'settings.local.json'),
      path.join(root, '.claude', 'settings.json'),
      path.join(root, '.claude', 'settings.local.json'),
    ]);
  });
});

describe('a credits turn’s sign-in failure', () => {
  it('is said as the credits card, keeping what the backend said', () => {
    const event: StreamEvent = {
      type: 'error',
      data: { message: 'Sign in again', category: 'auth_error', details: '401 invalid token' },
    };
    expect(asCreditsStopped(event)).toEqual({
      type: 'error',
      data: {
        message: expect.stringContaining('DorkOS credits stopped working partway through'),
        code: 'credits_unavailable',
        category: 'execution_error',
        reason: 'stopped',
        details: '401 invalid token',
      },
    });
  });

  it('passes every other event through untouched', () => {
    const text: StreamEvent = { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;
    const other: StreamEvent = {
      type: 'error',
      data: { message: 'x', category: 'execution_error' },
    };
    expect(asCreditsStopped(text)).toBe(text);
    expect(asCreditsStopped(other)).toBe(other);
  });
});
