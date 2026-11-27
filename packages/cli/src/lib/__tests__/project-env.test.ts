/**
 * The project `.env` fills in what the environment left unset, and never sets
 * a trust setting: those are read only from the server's own environment.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProjectEnv, TRUST_ENV_KEYS } from '../project-env.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-project-env-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Write a `.env` and return its path. */
function envFile(body: string): string {
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, body);
  return file;
}

describe('loadProjectEnv', () => {
  it('leaves the trusted-host list unchanged, and says once which keys it ignored, by name', () => {
    const target: NodeJS.ProcessEnv = { DORKOS_TRUSTED_HOSTS: 'mine.example.com' };
    const warn = vi.fn();
    const result = loadProjectEnv(
      envFile(
        'DORKOS_TRUSTED_HOSTS=evil.example\nDORKOS_CORS_ORIGIN=https://evil.example\nDORKOS_HOST=0.0.0.0\n'
      ),
      target,
      warn
    );
    expect(target.DORKOS_TRUSTED_HOSTS).toBe('mine.example.com');
    expect(target).not.toHaveProperty('DORKOS_CORS_ORIGIN');
    expect(target).not.toHaveProperty('DORKOS_HOST');
    expect(result.ignored).toEqual(['DORKOS_TRUSTED_HOSTS', 'DORKOS_CORS_ORIGIN', 'DORKOS_HOST']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).not.toContain('evil.example');
  });

  it('never sets any trust setting, set elsewhere or not', () => {
    const body = Object.keys(TRUST_ENV_KEYS)
      .map((key) => `${key}=x`)
      .join('\n');
    const target: NodeJS.ProcessEnv = {};
    loadProjectEnv(envFile(body), target, () => undefined);
    expect(target).toEqual({});
  });

  it('fills in an ordinary setting the environment left unset, and overrides nothing', () => {
    const target: NodeJS.ProcessEnv = { DORKOS_PORT: '4242' };
    const warn = vi.fn();
    const result = loadProjectEnv(
      envFile('DORKOS_PORT=5000\nDORKOS_TASKS_ENABLED=false\n'),
      target,
      warn
    );
    expect(target).toEqual({ DORKOS_PORT: '4242', DORKOS_TASKS_ENABLED: 'false' });
    expect(result.applied).toEqual(['DORKOS_TASKS_ENABLED']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads nothing when there is no file', () => {
    expect(loadProjectEnv(path.join(dir, '.env'), {}, () => undefined)).toEqual({
      applied: [],
      ignored: [],
    });
  });
});
