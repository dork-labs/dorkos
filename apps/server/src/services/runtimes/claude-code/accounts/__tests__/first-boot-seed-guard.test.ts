/**
 * A throwaway test server stays off this computer's real data (DOR-3587): real
 * temp folders, a real sign-in policy file, and only the folder read observed.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { DORKOS_TEST_RUNTIME: false },
  harness: {} as Record<string, unknown>,
  readLogin: vi.fn((): null => null),
  pinRepoBaseline: vi.fn(async () => true),
}));

vi.mock('../../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../env.js')>();
  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'DORKOS_TEST_RUNTIME' ? mocks.env.DORKOS_TEST_RUNTIME : Reflect.get(target, key),
    }),
  };
});
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'harness' ? mocks.harness : undefined),
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'harness') mocks.harness = value;
    },
  },
}));
vi.mock('../../../../core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../../connect/signin-accounts.js', () => ({ signinAccounts: () => [] }));
vi.mock('../account-login-metadata.js', () => ({ readAccountLoginMetadata: mocks.readLogin }));
vi.mock('../../repo-settings/repo-baseline.js', () => ({ pinRepoBaseline: mocks.pinRepoBaseline }));

import { initAccountSigninPolicy } from '../../../../health/account-signin-policy.js';
import { pinKnownRepoBaselinesOnce } from '../../repo-settings/pin-repo-baselines.js';
import { firstBootSeedsMayRun } from '../first-boot-seed-guard.js';
import { seedAccountSigninPolicy } from '../seed-signin-policy.js';

let root: string;
let dorkHome: string;
let outsideHome: string;
let insideHome: string;

const policyFile = () => path.join(dorkHome, 'account-signin-policy.json');

/** Run both seeds as a booting server would, with a real folder list for the sign-in one. */
async function runBothSeeds(): Promise<{ folders: ReturnType<typeof vi.fn> }> {
  initAccountSigninPolicy(dorkHome);
  seedAccountSigninPolicy();
  const folders = vi.fn(async () => ['/some/repo']);
  await pinKnownRepoBaselinesOnce(folders);
  return { folders };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor3587-')));
  dorkHome = path.join(root, 'dork');
  outsideHome = path.join(root, 'real-home');
  insideHome = path.join(dorkHome, 'home');
  // `projects` is what makes a folder count as a Claude root (`isClaudeAccountRoot`).
  fs.mkdirSync(path.join(outsideHome, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(insideHome, '.claude', 'projects'), { recursive: true });
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  mocks.env.DORKOS_TEST_RUNTIME = true;
  mocks.harness = {};
  mocks.readLogin.mockClear();
  mocks.pinRepoBaseline.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the first-boot seeds under the test runtime', () => {
  it('skips both on a home outside DORK_HOME, reading no folder and writing no marker', async () => {
    vi.stubEnv('HOME', outsideHome);

    const { folders } = await runBothSeeds();

    expect(mocks.readLogin).not.toHaveBeenCalled();
    expect(fs.existsSync(policyFile())).toBe(false);
    expect(folders).not.toHaveBeenCalled();
    expect(mocks.pinRepoBaseline).not.toHaveBeenCalled();
    expect(mocks.harness.repoBaselinesPinned).toBeUndefined();
  });

  it('runs both on a home inside DORK_HOME', async () => {
    vi.stubEnv('HOME', insideHome);

    const { folders } = await runBothSeeds();

    expect(mocks.readLogin).toHaveBeenCalledWith(path.join(insideHome, '.claude'));
    expect(JSON.parse(fs.readFileSync(policyFile(), 'utf8')).seededAt).toEqual(expect.any(String));
    expect(folders).toHaveBeenCalledOnce();
    expect(mocks.pinRepoBaseline).toHaveBeenCalledWith('/some/repo');
    expect(mocks.harness.repoBaselinesPinned).toBe(true);
  });

  it('does not read an inherited CLAUDE_CONFIG_DIR, on either kind of home', async () => {
    const excluded = path.join(root, 'excluded-claude');
    fs.mkdirSync(path.join(excluded, 'projects'), { recursive: true });
    vi.stubEnv('CLAUDE_CONFIG_DIR', excluded);

    for (const home of [outsideHome, insideHome]) {
      vi.stubEnv('HOME', home);
      await runBothSeeds();
    }

    expect(mocks.readLogin).not.toHaveBeenCalled();
    expect(fs.existsSync(policyFile())).toBe(false);

    // The control: the same folder is read once the guard is out of the way.
    mocks.env.DORKOS_TEST_RUNTIME = false;
    await runBothSeeds();
    expect(mocks.readLogin).toHaveBeenCalledWith(excluded);
  });

  it('runs with a CLAUDE_CONFIG_DIR inside DORK_HOME, the way the harness sets it', () => {
    vi.stubEnv('HOME', insideHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(insideHome, '.claude'));
    expect(firstBootSeedsMayRun()).toBe(true);
  });

  it('does not take DORK_HOME itself, or a symlink out of it, as a home inside it', () => {
    vi.stubEnv('HOME', dorkHome);
    expect(firstBootSeedsMayRun()).toBe(false);

    const link = path.join(dorkHome, 'link-out');
    fs.symlinkSync(outsideHome, link);
    vi.stubEnv('HOME', link);
    expect(firstBootSeedsMayRun()).toBe(false);
  });

  it('does not take a home that cannot be resolved', () => {
    vi.stubEnv('HOME', path.join(dorkHome, 'missing'));
    expect(firstBootSeedsMayRun()).toBe(false);
  });
});

describe('the first-boot seeds without the test runtime', () => {
  it('runs both on any home, as before', async () => {
    mocks.env.DORKOS_TEST_RUNTIME = false;
    vi.stubEnv('HOME', outsideHome);

    const { folders } = await runBothSeeds();

    expect(mocks.readLogin).toHaveBeenCalledWith(path.join(outsideHome, '.claude'));
    expect(fs.existsSync(policyFile())).toBe(true);
    expect(folders).toHaveBeenCalledOnce();
    expect(mocks.harness.repoBaselinesPinned).toBe(true);
  });
});
