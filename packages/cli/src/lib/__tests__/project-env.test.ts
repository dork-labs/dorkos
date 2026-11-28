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
import { takeProjectSettings } from '@dorkos/shared/project-environment';
import { loadProjectEnv } from '../project-env.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-project-env-'));
});
afterEach(() => {
  takeProjectSettings();
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

  it('keeps only the allowed settings, frozen, and hands them to the server once', () => {
    envFile('LOG_LEVEL=debug\nDO_NOT_TRACK=1\nMY_TOOL_URL=http://localhost:9000\n');
    const settings = loadProjectEnv(dir, () => undefined, {});
    expect(settings).toEqual({ LOG_LEVEL: 'debug', DO_NOT_TRACK: '1' });
    expect(Object.isFrozen(settings)).toBe(true);
    expect(takeProjectSettings()).toEqual(settings);
    expect(takeProjectSettings()).toEqual({});
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
