/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createMockAccountUsage, createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '../../TransportContext';
import { accountKeys } from '../query-keys';
import { seedAccountUsage, useAccountUsage } from '../use-account-usage';
import { useAccountUsageSync } from '../use-account-usage-sync';

/** The mock event stream: the handler each event name was subscribed with. */
const handlers = new Map<string, (data: unknown) => void>();

vi.mock('../../event-stream-context', () => ({
  useEventSubscription: (event: string, handler: (data: unknown) => void) => {
    handlers.set(event, handler);
  },
}));

beforeEach(() => handlers.clear());
afterEach(cleanup);

const ACCT_2 = createMockAccountUsage();

function renderSync(queryClient: QueryClient) {
  const transport = createMockTransport();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  // A reader on the entry, as a mounted chip would be, so the entry is held.
  const reader = renderHook(
    () => {
      useAccountUsageSync();
      return useAccountUsage('claude-code', { accountId: 'acct-2' });
    },
    { wrapper }
  );
  return { transport, reader };
}

describe('useAccountUsageSync', () => {
  it('subscribes to account_usage', () => {
    renderSync(createTestQueryClient());
    expect([...handlers.keys()]).toEqual(['account_usage']);
  });

  it('upserts an event into its runtime’s cached usage with no request', () => {
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [ACCT_2]);
    const { transport } = renderSync(queryClient);

    const newer = { ...ACCT_2, updatedAt: '2026-09-27T13:00:00.000Z', state: 'warning' as const };
    handlers.get('account_usage')!(newer);

    expect(queryClient.getQueryData(accountKeys.usage('claude-code'))).toEqual([newer]);
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('ignores an event older than the cached reading', () => {
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [ACCT_2]);
    renderSync(queryClient);

    handlers.get('account_usage')!({ ...ACCT_2, updatedAt: '2026-09-27T11:00:00.000Z' });

    expect(queryClient.getQueryData(accountKeys.usage('claude-code'))).toEqual([ACCT_2]);
  });

  it('does nothing for a runtime nothing has cached', () => {
    const queryClient = createTestQueryClient();
    seedAccountUsage(queryClient, [ACCT_2]);
    renderSync(queryClient);

    handlers.get('account_usage')!({ ...ACCT_2, runtime: 'codex', accountId: 'default' });

    expect(queryClient.getQueryData(accountKeys.usage('codex'))).toBeUndefined();
  });
});
