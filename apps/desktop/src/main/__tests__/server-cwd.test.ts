import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier rather than by importing the mock
 * module directly.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('./electron-log-mock');
}

/**
 * A throwaway home directory the app pretends to own, with the packaged data
 * directory (`<home>/.dork`) already created.
 *
 * Real directories on disk rather than a mocked `fs`: the resolver's whole job
 * is to hand `utilityProcess.fork` a directory that EXISTS — a fork against a
 * deleted `server.cwd` fails to spawn and the app never starts — and a mocked
 * `fs` can only ever agree with itself about what exists.
 */
let home: string;

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-cwd-test-'));
  mkdirSync(path.join(home, '.dork'), { recursive: true });

  const { app, resetElectronMock } = await getElectronMock();
  const { resetLogMock } = await getLogMock();
  resetElectronMock();
  resetLogMock();
  app.isPackaged = true;
  app.getPath = vi.fn(() => home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Write a `server` section into the throwaway home's `config.json`. */
function writeConfig(server: Record<string, unknown>): void {
  writeFileSync(path.join(home, '.dork', 'config.json'), JSON.stringify({ server }), 'utf8');
}

/** Create a directory under the throwaway home and return its absolute path. */
function makeDir(...segments: string[]): string {
  const dir = path.join(home, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('resolveServerCwd', () => {
  it('falls back to the home directory when nothing is configured', async () => {
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd()).toEqual({ cwd: home, boundary: undefined });
  });

  it('falls back to the home directory when config.json is unparseable', async () => {
    writeFileSync(path.join(home, '.dork', 'config.json'), '{ not json', 'utf8');
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd().cwd).toBe(home);
  });

  it('uses server.cwd when it is set and inside the boundary', async () => {
    const projects = makeDir('projects', 'dorkos');
    writeConfig({ cwd: projects });
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd()).toEqual({ cwd: projects, boundary: undefined });
  });

  it('clamps a server.cwd outside the boundary back to the boundary root, and says so', async () => {
    // The whole point of the clamp: the server refuses every path outside its
    // boundary, so handing it one produces an app whose session list is a wall
    // of "Access denied" — which is exactly the packaged-app bug this fixes.
    const outside = mkdtempSync(path.join(os.tmpdir(), 'dorkos-outside-'));
    try {
      writeConfig({ cwd: outside });
      const { resolveServerCwd } = await import('../server-cwd');
      const { default: log } = await getLogMock();

      expect(resolveServerCwd().cwd).toBe(home);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(outside));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('clamps against a configured boundary rather than home, and passes it through', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'dorkos-workspace-'));
    const inside = path.join(workspace, 'repo');
    mkdirSync(inside);
    try {
      writeConfig({ boundary: workspace, cwd: inside });
      const { resolveServerCwd } = await import('../server-cwd');

      // Outside home, but the person widened the boundary to include it.
      expect(resolveServerCwd()).toEqual({ cwd: inside, boundary: workspace });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('falls back to the configured boundary root, not home, when the cwd is outside it', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'dorkos-workspace-'));
    try {
      writeConfig({ boundary: workspace, cwd: home });
      const { resolveServerCwd } = await import('../server-cwd');

      expect(resolveServerCwd()).toEqual({ cwd: workspace, boundary: workspace });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('falls back to home when server.cwd names a directory that is gone', async () => {
    // A stale pin is the realistic case: the directory was renamed months ago.
    // Forking the utility process with a nonexistent cwd fails to spawn, so
    // this fallback is the difference between a cockpit that opens in the wrong
    // place and an app that does not start at all.
    writeConfig({ cwd: path.join(home, 'deleted-last-year') });
    const { resolveServerCwd } = await import('../server-cwd');
    const { default: log } = await getLogMock();

    expect(resolveServerCwd().cwd).toBe(home);
    expect(log.warn).toHaveBeenCalled();
  });

  it('resolves a relative server.cwd against home, where a windowed app has no useful cwd', async () => {
    makeDir('projects');
    writeConfig({ cwd: 'projects' });
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd().cwd).toBe(path.join(home, 'projects'));
  });

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
  ])('ignores a %s server.cwd', async (_label, value) => {
    writeConfig({ cwd: value });
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd().cwd).toBe(home);
  });

  it('ignores a server.cwd that is not a string', async () => {
    writeConfig({ cwd: 42 });
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd().cwd).toBe(home);
  });

  it('ignores a boundary that is not a usable string', async () => {
    const projects = makeDir('projects');
    writeConfig({ boundary: '', cwd: projects });
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd()).toEqual({ cwd: projects, boundary: undefined });
  });
});
