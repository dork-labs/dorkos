/**
 * Tests for `dorkos version` (`commands/version.ts`).
 *
 * Covers argument parsing, the server-reachable path, and the local-cache
 * fallback when no server is running (api-client mocked).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return { ApiError, apiCall: vi.fn() };
});

import { apiCall } from '../../lib/api-client.js';
import { parseVersionArgs, runVersionCheck, runVersionDispatcher } from '../version.js';

const apiCallMock = vi.mocked(apiCall);

let logSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true) as never;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('parseVersionArgs', () => {
  it('defaults check + json to false', () => {
    expect(parseVersionArgs([])).toEqual({ check: false, json: false });
  });

  it('parses --check and --json', () => {
    expect(parseVersionArgs(['--check', '--json'])).toEqual({ check: true, json: true });
  });

  it('throws on an unknown option', () => {
    expect(() => parseVersionArgs(['--nope'])).toThrow(/Unknown option for 'version'/);
  });
});

describe('runVersionCheck', () => {
  it('reports server + latest from /api/config when reachable', async () => {
    apiCallMock.mockResolvedValue({ version: '0.55.0', latestVersion: '0.56.0' });
    const code = await runVersionCheck('0.55.0', '/tmp/nope', true);
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/config');
    const printed = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(printed)).toMatchObject({
      cli: '0.55.0',
      server: '0.55.0',
      latest: '0.56.0',
      source: 'server',
    });
  });

  it('degrades to the local cache when no server is running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-version-'));
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cache', 'update-check.json'),
      JSON.stringify({ latestVersion: '0.56.0', checkedAt: Date.now() })
    );
    apiCallMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const code = await runVersionCheck('0.55.0', dir, true);
    expect(code).toBe(0);
    const printed = writeSpy.mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(printed)).toMatchObject({
      cli: '0.55.0',
      server: null,
      latest: '0.56.0',
      source: 'cache',
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runVersionDispatcher', () => {
  it('prints the CLI version with no flags', async () => {
    const code = await runVersionDispatcher('0.55.0', '/tmp/nope', []);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('0.55.0');
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it('runs the check with --check', async () => {
    apiCallMock.mockResolvedValue({ version: '0.55.0', latestVersion: null });
    const code = await runVersionDispatcher('0.55.0', '/tmp/nope', ['--check']);
    expect(code).toBe(0);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/config');
  });

  it('prints help for --help', async () => {
    expect(await runVersionDispatcher('0.55.0', '/tmp/nope', ['--help'])).toBe(0);
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});
