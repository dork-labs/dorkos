import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockAccountUsage } from '@dorkos/test-utils';
import { accountSigninPolicy, initAccountSigninPolicy } from '../account-signin-policy.js';
import { readAccountLoginMetadata } from '../../runtimes/claude-code/accounts/account-login-metadata.js';
import { rankAccounts, coreRanking } from '../../core/usage/account-ranking.js';
import { setAccountUsageStore } from '../../core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import type { RuntimeAccount } from '../../core/usage/runtime-accounts.js';
import {
  registerAccountAdvisor,
  __resetAccountAdvisorForTests,
} from '../../core/usage/account-advisor.js';

vi.mock('../../core/config-manager.js', () => ({ configManager: { get: () => undefined } }));
vi.mock('../../runtimes/claude-code/claude-config-dir.js', () => ({
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
}));
vi.mock('../../core/usage/account-eligibility.js', async (original) => ({
  ...(await original<typeof import('../../core/usage/account-eligibility.js')>()),
  projectOfFolder: async () => null,
}));
let home: string;
const ids = ['confirmed', 'changed', 'unconfirmed', 'unreadable'];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-ranking-identity-'));
  initAccountSigninPolicy(home);
  accountSigninPolicy()!.initializeInstall(false, [], () => null);
  for (const id of ids) {
    const root = path.join(home, id);
    fs.mkdirSync(root);
    if (id === 'unreadable') continue;
    fs.writeFileSync(
      path.join(root, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          accountUuid: '11111111-1111-4111-8111-111111111111',
          organizationUuid: '22222222-2222-4222-8222-222222222222',
          emailAddress: 'fixture@example.test',
        },
      })
    );
  }
  const root = path.join(home, 'confirmed');
  accountSigninPolicy()!.accept(root, readAccountLoginMetadata(root));
  accountSigninPolicy()!.accept(path.join(home, 'changed'), {
    ...readAccountLoginMetadata(root)!,
    accountUuid: '33333333-3333-4333-8333-333333333333',
  });
  const accounts = ids.map((id): RuntimeAccount => ({
    id,
    runtime: 'claude-code',
    path: path.join(home, id),
    canonicalPath: path.join(home, id),
    label: id,
    color: '#123456',
    storedColor: '#123456',
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: id,
  }));
  setAccountUsageStore({
    listAccounts: () => accounts,
    usageOfAccount: (account: RuntimeAccount) =>
      createMockAccountUsage({
        accountId: account.id,
        state: 'ok',
        path: account.path,
      }),
  } as unknown as AccountUsageStore);
});
afterEach(() => {
  __resetAccountAdvisorForTests();
  setAccountUsageStore(undefined);
  fs.rmSync(home, { recursive: true, force: true });
  initAccountSigninPolicy(path.join(home, 'removed'));
});
it('never recommends unconfirmed, changed or unreadable folders despite available usage', async () => {
  const ranking = await rankAccounts({
    purpose: 'continue',
    caller: 'advisor',
    runtime: 'claude-code',
    cwd: '',
  });
  expect(ranking.recommendedId).toBe('confirmed');
  expect(ranking.accounts.filter((row) => row.eligible).map((row) => row.id)).toEqual([
    'confirmed',
  ]);
  expect(
    coreRanking('claude-code', null)
      .filter((row) => row.eligible)
      .map((row) => row.id)
  ).toEqual(['confirmed']);
  const alone = await rankAccounts({
    purpose: 'continue',
    caller: 'advisor',
    runtime: 'claude-code',
    cwd: '',
    excludeAccountId: 'confirmed',
  });
  expect(alone.recommendedId).toBeNull();
  expect(alone.accounts.every((row) => !row.eligible)).toBe(true);
});
it('an advisor cannot override the confirmed-only constraint', async () => {
  registerAccountAdvisor('fixture', {
    rank: async () => ({
      accounts: ids.map((id) => ({ id, eligible: true, reason: 'Available' })),
      recommendedId: 'changed',
    }),
  });
  const ranking = await rankAccounts({
    purpose: 'continue',
    caller: 'advisor',
    runtime: 'claude-code',
    cwd: '',
  });
  expect(ranking.advised).toBe(true);
  expect(ranking.recommendedId).toBe('confirmed');
  expect(ranking.accounts.find((row) => row.id === 'changed')?.eligible).toBe(false);
});
