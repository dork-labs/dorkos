/**
 * The project `.env` can't change how DorkOS or its agents run: only its two
 * allowed settings are read, held in memory and handed to the server, and no
 * project value enters `process.env`.
 */
/* eslint-disable no-restricted-syntax -- this test reads process.env itself, to show the loader never writes it */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handProjectSettings, readProjectSettings } from '@dorkos/shared/project-environment';
import { loadProjectEnv } from '../project-env.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-project-env-'));
});
afterEach(() => {
  handProjectSettings({ settings: {}, authSecretFromFile: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write the project `.env`. */
function envFile(body: string): void {
  fs.writeFileSync(path.join(dir, '.env'), body);
}

describe('loadProjectEnv', () => {
  it('puts no project value into process.env', () => {
    const before = { ...process.env };
    envFile('PROJECT_SENTINEL_5481=fixture-value\nLOG_LEVEL=debug\nDO_NOT_TRACK=1\n');
    loadProjectEnv(dir, () => undefined);
    expect(process.env).toEqual(before);
    expect(Object.values(process.env)).not.toContain('fixture-value');
  });

  it('keeps only the allowed settings, frozen, and hands them to the server', () => {
    envFile('LOG_LEVEL=debug\nDO_NOT_TRACK=1\nMY_TOOL_URL=http://localhost:9000\n');
    const settings = loadProjectEnv(dir, () => undefined, {});
    expect(settings).toEqual({ LOG_LEVEL: 'debug', DO_NOT_TRACK: '1' });
    expect(Object.isFrozen(settings)).toBe(true);
    expect(readProjectSettings()).toEqual({ settings, authSecretFromFile: false });
  });

  it('names BETTER_AUTH_SECRET once, never hands its value on, and says it signed sign-ins', () => {
    envFile('BETTER_AUTH_SECRET=fixture-secret-value\n');
    const warn = vi.fn();
    expect(loadProjectEnv(dir, warn, {})).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('BETTER_AUTH_SECRET');
    expect(warn.mock.calls[0]![0]).not.toContain('fixture-secret-value');
    expect(JSON.stringify(readProjectSettings())).not.toContain('fixture-secret-value');
    expect(readProjectSettings()?.authSecretFromFile).toBe(true);
  });

  it('does not count a session secret the real environment also sets as the file’s', () => {
    envFile('BETTER_AUTH_SECRET=fixture-secret-value\n');
    loadProjectEnv(dir, () => undefined, { BETTER_AUTH_SECRET: 'real' });
    expect(readProjectSettings()?.authSecretFromFile).toBe(false);
  });

  it('lets a setting the real environment has win', () => {
    envFile('DO_NOT_TRACK=0\n');
    expect(loadProjectEnv(dir, () => undefined, { DO_NOT_TRACK: '1' })).toEqual({});
  });

  it.each([
    ['TUNNEL_ENABLED and NGROK_AUTHTOKEN', 'TUNNEL_ENABLED=true\nNGROK_AUTHTOKEN=fixture-token\n'],
    ['MCP_API_KEY', 'MCP_API_KEY=fixture-key\n'],
    ['DORKOS_TRUSTED_HOSTS', 'DORKOS_TRUSTED_HOSTS=fixture.example\n'],
    ['NODE_OPTIONS and NODE_PATH', 'NODE_OPTIONS=--require=/fixture.js\nNODE_PATH=/fixture\n'],
  ])('names %s once, without its value', (_name, body) => {
    envFile(body);
    const warn = vi.fn();
    expect(loadProjectEnv(dir, warn, {})).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).not.toMatch(/fixture/);
  });

  it('says nothing about a project’s own variables, and gives nothing without a file', () => {
    const warn = vi.fn();
    expect(loadProjectEnv(dir, warn, {})).toEqual({});
    envFile('MY_TOOL_URL=http://localhost:9000\n');
    expect(loadProjectEnv(dir, warn, {})).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });
});
