import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
 *
 * Canonicalized on creation, because the resolver returns canonical paths and
 * macOS hands out temp directories under `/var`, which is itself a symlink to
 * `/private/var`. Realpathing the fixture keeps every assertion about the
 * resolver rather than about that symlink.
 */
let home: string;

/** A throwaway directory OUTSIDE the home, canonicalized for the same reason. */
function makeOutsideDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

beforeEach(async () => {
  vi.resetModules();
  home = makeOutsideDir('dorkos-cwd-test-');
  mkdirSync(path.join(home, '.dork'), { recursive: true });

  const { app, resetElectronMock } = await getElectronMock();
  const { resetLogMock } = await getLogMock();
  resetElectronMock();
  resetLogMock();
  app.isPackaged = true;
  app.getPath = vi.fn(() => home);
  // Unset, not blank: these two steer the resolver now, and a developer who
  // exports either would otherwise change what these tests measure.
  vi.stubEnv('DORKOS_DEFAULT_CWD', undefined);
  vi.stubEnv('DORKOS_BOUNDARY', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    const outside = makeOutsideDir('dorkos-outside-');
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
    const workspace = makeOutsideDir('dorkos-workspace-');
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
    const workspace = makeOutsideDir('dorkos-workspace-');
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

describe('resolveServerCwd and the environment it was launched in', () => {
  it('clamps against an inherited DORKOS_BOUNDARY, which the child enforces either way', async () => {
    // The failure this closes: the child inherits this process's environment
    // wholesale, so an exported DORKOS_BOUNDARY reached it whether or not
    // anything here read it. Clamping against home while the child enforced
    // /tmp/scope produced a DORKOS_DEFAULT_CWD the child then refused — the
    // exact "path outside directory boundary" bug this module exists to stop.
    const scope = makeOutsideDir('dorkos-scope-');
    const inside = path.join(scope, 'repo');
    mkdirSync(inside);
    try {
      vi.stubEnv('DORKOS_BOUNDARY', scope);
      const { resolveServerCwd } = await import('../server-cwd');

      // Home is outside the inherited boundary, so it cannot be the answer.
      expect(resolveServerCwd()).toEqual({ cwd: scope, boundary: scope });
    } finally {
      rmSync(scope, { recursive: true, force: true });
    }
  });

  it('lets an inherited DORKOS_DEFAULT_CWD win over config.json', async () => {
    const fromEnv = makeDir('from-env');
    writeConfig({ cwd: makeDir('from-config') });
    vi.stubEnv('DORKOS_DEFAULT_CWD', fromEnv);
    const { resolveServerCwd } = await import('../server-cwd');

    expect(resolveServerCwd().cwd).toBe(fromEnv);
  });

  it('lets an inherited DORKOS_BOUNDARY win over config.json', async () => {
    const scope = makeOutsideDir('dorkos-scope-');
    const ignored = makeOutsideDir('dorkos-ignored-boundary-');
    try {
      writeConfig({ boundary: ignored });
      vi.stubEnv('DORKOS_BOUNDARY', scope);
      const { resolveServerCwd } = await import('../server-cwd');

      expect(resolveServerCwd().boundary).toBe(scope);
    } finally {
      rmSync(scope, { recursive: true, force: true });
      rmSync(ignored, { recursive: true, force: true });
    }
  });

  it('clamps an inherited DORKOS_DEFAULT_CWD too, wherever it came from', async () => {
    const outside = makeOutsideDir('dorkos-outside-');
    try {
      vi.stubEnv('DORKOS_DEFAULT_CWD', outside);
      const { resolveServerCwd } = await import('../server-cwd');

      expect(resolveServerCwd().cwd).toBe(home);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('resolveServerCwd and symlinks', () => {
  it('refuses a working directory whose real target is outside the boundary', async () => {
    // The server compares CANONICAL paths (initBoundary / resolveCanonicalPath
    // in apps/server/src/lib/boundary.ts), so a lexical check here would hand
    // over a path that looks contained and is then refused on every request.
    const external = makeOutsideDir('dorkos-external-');
    const link = path.join(home, 'work');
    symlinkSync(external, link);
    try {
      writeConfig({ cwd: link });
      const { resolveServerCwd } = await import('../server-cwd');
      const { default: log } = await getLogMock();

      expect(resolveServerCwd().cwd).toBe(home);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(external));
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('accepts a symlink whose real target is inside the boundary, resolved', async () => {
    const real = makeDir('projects', 'dorkos');
    const link = path.join(home, 'current');
    symlinkSync(real, link);
    writeConfig({ cwd: link });
    const { resolveServerCwd } = await import('../server-cwd');

    // Canonical, so the child's own boundary check lands on the same string.
    expect(resolveServerCwd().cwd).toBe(real);
  });
});
