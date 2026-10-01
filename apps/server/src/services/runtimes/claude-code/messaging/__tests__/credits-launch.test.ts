/**
 * The pieces of a credits launch (ADR 261001-000811): the process-env
 * allowlist, which folder settings a turn can be redirected by, and how a
 * credits turn's sign-in failure is said.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { asCreditsStopped, creditsProcessEnv, folderSettingsFiles } from '../credits-launch.js';

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
