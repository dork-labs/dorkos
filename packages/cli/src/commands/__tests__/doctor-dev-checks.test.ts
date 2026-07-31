/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  checkDistFreshness,
  checkNativeSqlite,
  checkOrphanedWatchers,
} from '../doctor-dev-checks.js';

/** A fixed "now" so the tests never race the clock. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

describe('checkDistFreshness', () => {
  it('passes when the build is newer than the source', () => {
    const result = checkDistFreshness({
      packageName: '@dorkos/shared',
      newestSourceMs: NOW - 60_000,
      newestDistMs: NOW,
    });
    expect(result.status).toBe('pass');
  });

  it('passes when the two are within the clock-skew tolerance', () => {
    const result = checkDistFreshness({
      packageName: '@dorkos/shared',
      newestSourceMs: NOW + 500,
      newestDistMs: NOW,
    });
    expect(result.status).toBe('pass');
  });

  it('warns when the source is newer than the build', () => {
    const result = checkDistFreshness({
      packageName: '@dorkos/shared',
      newestSourceMs: NOW,
      newestDistMs: NOW - 300_000,
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('5 minutes');
    expect(result.fix).toContain('pnpm --filter @dorkos/shared build');
  });

  it('warns when the package has never been built', () => {
    const result = checkDistFreshness({
      packageName: '@dorkos/db',
      newestSourceMs: NOW,
      newestDistMs: null,
    });
    expect(result.status).toBe('warn');
    expect(result.label).toContain('never been built');
  });

  it('says nothing when there is no source at all', () => {
    const result = checkDistFreshness({
      packageName: '@dorkos/db',
      newestSourceMs: null,
      newestDistMs: null,
    });
    expect(result.status).toBe('info');
  });
});

describe('checkOrphanedWatchers', () => {
  it('passes when no watcher is running', () => {
    const result = checkOrphanedWatchers([
      { pid: 1, command: '/bin/zsh' },
      { pid: 2, command: 'node packages/cli/dist/bin/cli.js' },
    ]);
    expect(result.status).toBe('pass');
  });

  it('warns and names the pids of leftover tsx watchers', () => {
    const result = checkOrphanedWatchers([
      { pid: 111, command: 'node .../tsx watch src/index.ts' },
      { pid: 222, command: 'node .../tsx  watch --clear-screen=false src/index.ts' },
      { pid: 333, command: 'vite' },
    ]);
    expect(result.status).toBe('warn');
    expect(result.label).toContain('2 dev servers are');
    expect(result.fix).toContain('kill 111 222');
  });

  it('passes on an empty process list rather than guessing', () => {
    expect(checkOrphanedWatchers([]).status).toBe('pass');
  });
});

describe('checkNativeSqlite', () => {
  it('passes when the binding loaded', () => {
    expect(checkNativeSqlite(null).status).toBe('pass');
  });

  it('fails on an Electron ABI mismatch and points at the rebuild', () => {
    const result = checkNativeSqlite(
      new Error(
        'The module better_sqlite3.node was compiled against a different Node.js version ' +
          'using NODE_MODULE_VERSION 133. This version of Node.js requires NODE_MODULE_VERSION 137.'
      )
    );
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('pnpm rebuild better-sqlite3');
  });

  it('warns on any other load failure', () => {
    const result = checkNativeSqlite(new Error("Cannot find module 'better-sqlite3'"));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('Cannot find module');
  });
});
