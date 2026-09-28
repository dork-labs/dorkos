import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../../core/usage/current-usage-store.js';
import { resetAccountProbeState } from '../../accounts/account-probe.js';
import { getAccountTools, handleAccountsProbe, handleAccountsUsage } from '../account-tools.js';
import type { McpToolDeps } from '../types.js';

describe('accounts_usage', () => {
  afterEach(() => setAccountUsageStore(undefined));

  it("returns every runtime's accounts as structured content", async () => {
    const accounts = [{ runtime: 'claude-code', accountId: 'default' }];
    setAccountUsageStore({
      list: vi.fn().mockReturnValue(accounts),
    } as unknown as AccountUsageStore);
    const result = await handleAccountsUsage();
    expect('structuredContent' in result && result.structuredContent).toEqual({ accounts });
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
