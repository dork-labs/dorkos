/**
 * The project `.env` carries a project's own variables, and can't change how
 * DorkOS runs: a setting DorkOS reads loads from it only when allowed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProjectEnv } from '../project-env.js';

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
  it.each([
    ['TUNNEL_ENABLED and NGROK_AUTHTOKEN', 'TUNNEL_ENABLED=true\nNGROK_AUTHTOKEN=fixture-token\n'],
    ['MCP_API_KEY', 'MCP_API_KEY=fixture-key\n'],
    ['DORKOS_TRUSTED_HOSTS', 'DORKOS_TRUSTED_HOSTS=fixture.example\n'],
    ['NODE_OPTIONS and NODE_PATH', 'NODE_OPTIONS=--require=/fixture.js\nNODE_PATH=/fixture\n'],
  ])('leaves %s unset, and names it once without its value', (_name, body) => {
    const target: NodeJS.ProcessEnv = {};
    const warn = vi.fn();
    const result = loadProjectEnv(envFile(body), target, warn);
    expect(target).toEqual({});
    expect(result.ignored.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).not.toMatch(/fixture/);
  });

  it('loads LOG_LEVEL, an allowed setting', () => {
    const target: NodeJS.ProcessEnv = {};
    loadProjectEnv(envFile('LOG_LEVEL=debug\n'), target, () => undefined);
    expect(target).toEqual({ LOG_LEVEL: 'debug' });
  });

  it('loads a project’s own variable, and overrides nothing already set', () => {
    const target: NodeJS.ProcessEnv = { DO_NOT_TRACK: '1' };
    const warn = vi.fn();
    const result = loadProjectEnv(
      envFile('MY_TOOL_URL=http://localhost:9000\nDO_NOT_TRACK=0\n'),
      target,
      warn
    );
    expect(target).toEqual({ DO_NOT_TRACK: '1', MY_TOOL_URL: 'http://localhost:9000' });
    expect(result.applied).toEqual(['MY_TOOL_URL']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads nothing when there is no file', () => {
    expect(loadProjectEnv(path.join(dir, '.env'), {}, () => undefined)).toEqual({
      applied: [],
      ignored: [],
    });
  });
});
