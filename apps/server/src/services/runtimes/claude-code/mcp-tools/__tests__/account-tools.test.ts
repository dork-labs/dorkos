import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../../core/usage/current-usage-store.js';
import { resetAccountProbeState } from '../../accounts/account-probe.js';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import {
  getAccountTools,
  handleAccountsProbe,
  handleAccountsUsage,
  usageAttention,
} from '../account-tools.js';
import type { McpToolDeps } from '../types.js';

describe('accounts_usage', () => {
  afterEach(() => setAccountUsageStore(undefined));

  it("returns every runtime's accounts as structured content", async () => {
    const accounts = [{ runtime: 'claude-code', accountId: 'default' }];
    setAccountUsageStore({
      list: vi.fn().mockReturnValue(accounts),
    } as unknown as AccountUsageStore);
    const result = await handleAccountsUsage();
    expect('structuredContent' in result && result.structuredContent).toEqual({
      attention: [],
      accounts,
    });
  });

  // DOR-4620. Red when: an unreadable account is left out of `attention`, read as 0%.
  it('puts out accounts first, then unreadable usage with since when, then never-read ones', () => {
    const base = { runtime: 'claude-code' as const, label: null };
    const accounts = [
      { ...base, accountId: 'fresh', state: 'ok' },
      {
        ...base,
        accountId: 'blind',
        state: 'ok',
        unknown: [
          { key: 'seven_day', label: 'Weekly', since: '2026-11-18T03:00:00.000Z' },
          { key: 'five_hour', label: '5-hour window', since: '2026-11-18T01:00:00.000Z' },
        ],
      },
      { ...base, accountId: 'never', state: 'unknown' },
      { ...base, accountId: 'out', state: 'limited' },
      { ...base, accountId: 'high', state: 'warning' },
    ] as unknown as AccountUsage[];
    expect(usageAttention(accounts)).toEqual([
      { ...base, accountId: 'out', reason: 'limited', since: null },
      { ...base, accountId: 'blind', reason: 'usage-unknown', since: '2026-11-18T01:00:00.000Z' },
      { ...base, accountId: 'never', reason: 'never-read', since: null },
    ]);
  });

  it('answers an error before the store is running', async () => {
    const result = await handleAccountsUsage();
    expect('isError' in result && result.isError).toBe(true);
  });
});

describe('accounts_probe', () => {
  afterEach(() => {
    setAccountUsageStore(undefined);
    resetAccountProbeState();
  });

  it('is an error for an id nobody registered, and starts nothing', async () => {
    setAccountUsageStore({
      listAccounts: vi.fn().mockReturnValue([]),
    } as unknown as AccountUsageStore);
    const result = await handleAccountsProbe({ account: 'nobody' });
    expect('isError' in result && result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('nobody');
  });

  it('answers an error before the store is running', async () => {
    const result = await handleAccountsProbe({ account: 'work' });
    expect('isError' in result && result.isError).toBe(true);
  });

  it('is declared with an `account` input', () => {
    const probe = getAccountTools({} as McpToolDeps).find((t) => t.name === 'accounts_probe');
    expect(probe).toBeDefined();
    expect(Object.keys(probe!.inputSchema)).toEqual(['account']);
  });
});
