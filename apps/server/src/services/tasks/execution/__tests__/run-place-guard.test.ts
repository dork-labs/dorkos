/**
 * Where a scheduled run may stand (DOR-4060). Real folders in a fixture home
 * with a dummy value only; HOME, DORK_HOME and CLAUDE_CONFIG_DIR point inside it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_RUN_HOME_MESSAGE,
  SCHEDULED_RUNS_DIR,
  SCHEDULED_RUNS_UNSAFE_MESSAGE,
  guardRunPlacement,
} from '../run-place-guard.js';
import { isProtectedLaunchFolder } from '../../../session/launch/launch-caller.js';
import { protectedPathRefusal } from '../../../runtimes/shared/policy/protected-file-guard.js';

let above: string;
let home: string;
let dork: string;
let agent: string;
let runs: string;

beforeEach(() => {
  above = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4060-runs-')));
  home = path.join(above, 'home');
  dork = path.join(home, '.dork');
  agent = path.join(home, 'agents', 'qa');
  runs = path.join(dork, SCHEDULED_RUNS_DIR);
  fs.mkdirSync(dork, { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(dork, 'host.key'), 'TOKEN=dor-4060-dummy-canary');
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(above, 'claude-fixture'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(above, { recursive: true, force: true });
});

describe("an agent's scheduled run", () => {
  it('runs in its own folder when the folder chain fell back to home', () => {
    expect(guardRunPlacement({ cwd: home, agentPath: agent })).toEqual({
      cwd: agent,
      agentPath: agent,
    });
  });

  it('keeps a folder the chain chose that is not protected', () => {
    const placement = { cwd: path.join(agent, 'checkout'), agentPath: agent };
    expect(guardRunPlacement(placement)).toBe(placement);
  });

  it('is refused when its own folder is the data folder', () => {
    expect(() => guardRunPlacement({ cwd: dork, agentPath: dork })).toThrow(
      GLOBAL_RUN_HOME_MESSAGE
    );
  });
});

describe('a scheduled run with no agent', () => {
  it.each([
    ['the home folder', () => home],
    ['a folder above it', () => above],
    ['the data folder', () => dork],
  ])('started from %s runs in a fresh, empty, private folder', (_name, cwd) => {
    const { cwd: placed } = guardRunPlacement({ cwd: cwd() });
    expect(path.dirname(placed)).toBe(runs);
    expect(fs.readdirSync(placed)).toEqual([]);
    expect(fs.statSync(placed).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runs).mode & 0o777).toBe(0o700);
  });

  it('gets a new folder each run, so nothing one run leaves loads into the next', () => {
    const first = guardRunPlacement({ cwd: home }).cwd;
    fs.writeFileSync(path.join(first, 'CLAUDE.md'), '# planted');
    const second = guardRunPlacement({ cwd: home }).cwd;
    expect(second).not.toBe(first);
    expect(fs.readdirSync(second)).toEqual([]);
  });

  it.each([
    ['a planted CLAUDE.md', () => fs.writeFileSync(path.join(runs, 'CLAUDE.md'), '# planted')],
    ['a planted .mcp.json', () => fs.writeFileSync(path.join(runs, '.mcp.json'), '{}')],
    ['a symlink', () => fs.symlinkSync(home, path.join(runs, 'link'))],
  ])('is refused when the scheduled-runs folder holds %s', (_name, plant) => {
    fs.mkdirSync(runs, { mode: 0o700 });
    plant();
    expect(() => guardRunPlacement({ cwd: home })).toThrow(SCHEDULED_RUNS_UNSAFE_MESSAGE);
  });

  it('is refused when the scheduled-runs folder is a symlink', () => {
    fs.mkdirSync(path.join(above, 'elsewhere'));
    fs.symlinkSync(path.join(above, 'elsewhere'), runs);
    expect(() => guardRunPlacement({ cwd: home })).toThrow(SCHEDULED_RUNS_UNSAFE_MESSAGE);
  });

  it('still runs in a folder that only holds the data folder, as a dev checkout does', () => {
    vi.stubEnv('DORK_HOME', path.join(above, 'repo', 'apps', 'server', '.temp', '.dork'));
    const repo = path.join(above, 'repo');
    expect(guardRunPlacement({ cwd: repo })).toEqual({ cwd: repo });
  });

  it('cannot reach the data folder’s protected files from its run folder', () => {
    const placed = guardRunPlacement({ cwd: home }).cwd;
    expect(protectedPathRefusal('../../host.key', placed)?.code).toBe('PROTECTED_FILE');
    expect(protectedPathRefusal(path.join(dork, 'host.key'), placed)?.code).toBe('PROTECTED_FILE');
  });

  it('opens no door for an agent: a new chat there is still refused', () => {
    const placed = guardRunPlacement({ cwd: home }).cwd;
    expect(isProtectedLaunchFolder(placed, agent)).toBe(true);
    expect(isProtectedLaunchFolder(runs, agent)).toBe(true);
  });
});
