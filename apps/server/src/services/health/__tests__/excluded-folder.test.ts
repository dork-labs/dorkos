import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import os from 'node:os';
import path from 'node:path';
import { initAccountSigninPolicy, accountSigninPolicy } from '../account-signin-policy.js';
import {
  accountLoginIdentity,
  requireConfirmedAccountLogin,
} from '../../runtimes/claude-code/accounts/account-login-metadata.js';
import { resolveClaudeRootSet } from '../../runtimes/claude-code/claude-config-dir.js';
import { checkClaudeDependencies } from '../../runtimes/claude-code/tooling/check-dependency.js';
import { readClaudeSignInDeadlines } from '../../runtimes/claude-code/tooling/claude-sign-in-expiry.js';
import { readClaudeAuthStatus } from '../../runtimes/claude-code/tooling/claude-cli-auth.js';
import { runBinaryProbe } from '../../runtimes/shared/run-probe.js';
import { probeAccount } from '../../runtimes/claude-code/accounts/account-probe.js';
import { pickReseatAccount } from '../../rooms/reseat/reseat-accounts.js';
import { delegateRuntimeLogin } from '../../runtimes/connect/delegated-login.js';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import type { RankedAccount } from '../../core/usage/account-ranking.js';
import { spawn } from 'node:child_process';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../../runtimes/shared/run-probe.js', async (original) => ({
  ...(await original<typeof import('../../runtimes/shared/run-probe.js')>()),
  runBinaryProbe: vi.fn(async () => '2.1.224'),
  findBinaryOnPath: vi.fn(async () => null),
}));
vi.mock('../../runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeBinaryBeforePath: () => '/fake/claude',
  resolveClaudeCliPath: () => '/fake/claude',
}));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-excluded-'));
  initAccountSigninPolicy(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});
describe('zero-touch excluded folder', () => {
  it('does not read or spawn for the folder during health, readiness, failover and usage refresh', async () => {
    const root = path.join(home, 'excluded-fixture');
    accountSigninPolicy()!.addFolder({
      accountId: 'excluded',
      path: root,
      label: 'Excluded fixture',
    });
    const alias = path.join(home, 'allowed-looking-alias');
    const reads: string[] = [];
    // Every account filesystem seam is fake: no real account, token or credential store is consulted.
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown) => {
      reads.push(String(file));
      return '{}';
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'statSync').mockImplementation(((file: unknown) => {
      reads.push(String(file));
      return { isDirectory: () => false };
    }) as typeof fs.statSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: unknown) => {
      reads.push(String(file));
      return { isFile: () => false };
    }) as typeof fs.lstatSync);
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((file: unknown) => {
      reads.push(String(file));
      return String(file) === alias ? root : String(file);
    }) as typeof fs.realpathSync.native);
    const config = {
      get: () => ({
        defaultAccount: root,
        accounts: [{ id: 'excluded', path: root, label: 'Excluded fixture' }],
        claudeCode: {
          defaultAccount: root,
          accounts: [{ id: 'excluded', path: root, label: 'Excluded fixture' }],
        },
      }),
    };
    expect(accountLoginIdentity(root)).toEqual({ state: 'never-use' });
    expect(() => requireConfirmedAccountLogin(root)).toThrow();
    expect(resolveClaudeRootSet(config as never)).not.toContain(root);
    expect((await checkClaudeDependencies({ config: config as never }))[1].status).toBe('missing');
    expect(await readClaudeSignInDeadlines(root)).toBeNull();
    expect(await readClaudeAuthStatus('/fake/claude', { CLAUDE_CONFIG_DIR: root })).toBeNull();
    expect(accountLoginIdentity(alias).state).toBe('unreadable');
    expect(() => requireConfirmedAccountLogin(alias)).toThrow();
    expect(await readClaudeSignInDeadlines(alias)).toBeNull();
    expect(await readClaudeAuthStatus('/fake/claude', { CLAUDE_CONFIG_DIR: alias })).toBeNull();
    expect((await delegateRuntimeLogin('claude-code', { accountRoot: alias })).ok).toBe(false);
    const usage: AccountUsage = {
      runtime: 'claude-code',
      accountId: 'excluded',
      path: root,
      label: 'Excluded fixture',
      color: '#888888',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      limit: null,
      updatedAt: null,
      state: 'ok',
      windows: [],
    };
    const row: RankedAccount = {
      runtime: 'claude-code',
      id: 'excluded',
      label: 'Excluded fixture',
      color: '#888888',
      reason: '',
      eligible: true,
      usage,
    };
    expect(
      pickReseatAccount([row], { runtime: 'claude-code', currentAccountId: 'other' }).kind
    ).toBe('none');
    const store = {
      listAccounts: () => [{ ...row, path: root, canonicalPath: root, routable: true }],
      usageOfAccount: () => usage,
    } as unknown as AccountUsageStore;
    expect((await probeAccount('excluded', { store })).probe).toBe('failed');
    expect((await delegateRuntimeLogin('claude-code', { accountRoot: root })).ok).toBe(false);
    expect(reads.filter((file) => file === root || file.startsWith(root + path.sep))).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(runBinaryProbe)
        .mock.calls.filter(
          ([binary, args]) => String(binary).includes('security') || args.includes('auth')
        )
    ).toEqual([]);
  });
});
