import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AccountUsageStore } from '../../../../core/usage/account-usage-store.js';
import { setAccountUsageStore } from '../../../../core/usage/current-usage-store.js';
import { handleAccountsUsage } from '../account-tools.js';

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
