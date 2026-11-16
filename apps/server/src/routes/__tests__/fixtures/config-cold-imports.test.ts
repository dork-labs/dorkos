/** Bootstrap imports must leave no config, sign-in policy or directory behind. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { preloadConfigRouteModules } from './config-cold-imports.js';

const ambientHome = process.env.DORK_HOME;
const owned: string[] = [];
let callerHome: string;

beforeEach(() => {
  vi.resetModules();
  callerHome = mkdtempSync(join(tmpdir(), 'config-import-caller-'));
  owned.push(callerHome);
  writeFileSync(join(callerHome, 'keep.txt'), 'caller data');
  process.env.DORK_HOME = callerHome;
});

afterEach(() => {
  vi.resetModules();
  for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
  if (ambientHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = ambientHome;
});

/** Observe real initialized modules while retaining only the owned directory's name. */
async function observeBootstrap(): Promise<string> {
  const home = process.env.DORK_HOME!;
  expect(basename(home)).toMatch(/^dorkos-config-cold-import-/);
  owned.push(home);
  const { configManager } = await import('../../../services/core/config-manager.js');
  const { accountSigninPolicy } = await import('../../../services/health/account-signin-policy.js');
  expect(configManager.path).toBe(join(home, 'config.json'));
  expect(accountSigninPolicy()).toBeDefined();
  return home;
}

/** A real subsequent fixture must initialize both stores for itself. */
async function expectNoBootstrapState(home: string): Promise<void> {
  expect(existsSync(home)).toBe(false);
  expect(readFileSync(join(callerHome, 'keep.txt'), 'utf8')).toBe('caller data');
  const { configManager } = await import('../../../services/core/config-manager.js');
  const { accountSigninPolicy } = await import('../../../services/health/account-signin-policy.js');
  expect(configManager).toBeUndefined();
  expect(accountSigninPolicy()).toBeUndefined();
}

describe('cold config imports', () => {
  it('discards real bootstrap stores and preserves the caller home', async () => {
    let home = '';
    let loads = 0;
    await preloadConfigRouteModules(async () => {
      loads++;
      home = await observeBootstrap();
    });
    expect(loads).toBe(1);
    expect(process.env.DORK_HOME).toBe(callerHome);
    await expectNoBootstrapState(home);
  });

  it('restores an absent home without retaining bootstrap stores', async () => {
    delete process.env.DORK_HOME;
    let home = '';
    await preloadConfigRouteModules(async () => {
      home = await observeBootstrap();
    });
    expect(process.env.DORK_HOME).toBeUndefined();
    await expectNoBootstrapState(home);
  });

  it('cleans the real stores and home when a declaration import rejects', async () => {
    const failure = new Error('declaration import rejected');
    let home = '';
    let loads = 0;
    await expect(
      preloadConfigRouteModules(async () => {
        loads++;
        home = await observeBootstrap();
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(loads).toBe(1);
    expect(process.env.DORK_HOME).toBe(callerHome);
    await expectNoBootstrapState(home);
  });
});
