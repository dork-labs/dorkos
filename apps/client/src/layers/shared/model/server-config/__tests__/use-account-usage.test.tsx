/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockAccountUsage, createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '../../TransportContext';
import { accountKeys } from '../query-keys';
import {
  mergeAccountUsage,
  seedAccountUsage,
  useAccountUsage,
  type UseAccountUsageOptions,
} from '../use-account-usage';

afterEach(cleanup);

const ACCT_2 = createMockAccountUsage();
const ACCT_3 = createMockAccountUsage({
  accountId: 'acct-3',
  path: '/Users/test/.claude-acct-3',
  label: 'Acct 3',
});

function renderUsage(
  queryClient: QueryClient,
  transport: Transport,
  runtime: string | null,
  opts?: UseAccountUsageOptions
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useAccountUsage(runtime, opts), { wrapper });
}

describe('mergeAccountUsage', () => {
  it('replaces a record with a newer reading', () => {
    const newer = { ...ACCT_2, updatedAt: '2026-09-27T13:00:00.000Z', state: 'warning' as const };
    expect(mergeAccountUsage([ACCT_2], [newer])).toEqual([newer]);
  });

  it('ignores an older reading', () => {
    const older = { ...ACCT_2, updatedAt: '2026-09-27T11:00:00.000Z', state: 'limited' as const };
    expect(mergeAccountUsage([ACCT_2], [older])).toEqual([ACCT_2]);
  });

  it('compares as dates, not strings, and lets a null time lose', () => {
    const offset = {
      ...ACCT_2,
      updatedAt: '2026-09-27T14:00:00.000+03:00',
      state: 'limited' as const,
    };
    // 14:00+03:00 is 11:00Z, older than 12:00Z, though it sorts later as text.
    expect(mergeAccountUsage([ACCT_2], [offset])).toEqual([ACCT_2]);
    const unknown = { ...ACCT_2, updatedAt: null };
    expect(mergeAccountUsage([ACCT_2], [unknown])).toEqual([ACCT_2]);
    expect(mergeAccountUsage([unknown], [ACCT_2])).toEqual([ACCT_2]);
  });

  it('appends an account it has not seen', () => {
    expect(mergeAccountUsage([ACCT_2], [ACCT_3])).toEqual([ACCT_2, ACCT_3]);
  });

  it('matches an unregistered account by its path', () => {
    const root = { ...ACCT_2, accountId: null, path: '/Users/test/.claude' };
    const newer = { ...root, updatedAt: '2026-09-27T13:00:00.000Z' };
    const other = { ...root, path: '/Users/test/.claude-other' };
    expect(mergeAccountUsage([root], [newer, other])).toEqual([newer, other]);
  });

  it('keeps the default account of two runtimes apart', () => {
    const codex = { ...ACCT_2, runtime: 'codex' as const, accountId: 'default' };
    const opencode = { ...ACCT_2, runtime: 'opencode' as const, accountId: 'default' };
    expect(mergeAccountUsage([codex], [opencode])).toEqual([codex, opencode]);
  });
});

describe('seedAccountUsage', () => {
  it('fills each runtime’s entry from the records, without a request', () => {
    const queryClient = createTestQueryClient();
    const codex = { ...ACCT_2, runtime: 'codex' as const, accountId: 'default' };
    seedAccountUsage(queryClient, [ACCT_2, codex, ACCT_3]);
    expect(queryClient.getQueryData(accountKeys.usage('claude-code'))).toEqual([ACCT_2, ACCT_3]);
    expect(queryClient.getQueryData(accountKeys.usage('codex'))).toEqual([codex]);
  });
});

describe('useAccountUsage', () => {
  it('answers from the seed on the first render and asks nothing', () => {
    const queryClient = createTestQueryClient();
    const transport = createMockTransport();
    seedAccountUsage(queryClient, [ACCT_2]);

    const { result } = renderUsage(queryClient, transport, 'claude-code', { accountId: 'acct-2' });

    expect(result.current.byId.get('acct-2')).toEqual(ACCT_2);
    expect(result.current.byPath.get(ACCT_2.path)).toEqual(ACCT_2);
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('asks the route once when the seed lacks the account', async () => {
    const queryClient = createTestQueryClient();
    const transport = createMockTransport({
      getAccountUsage: vi.fn().mockResolvedValue({ accounts: [ACCT_2, ACCT_3] }),
    });
    seedAccountUsage(queryClient, [ACCT_2]);

    const { result } = renderUsage(queryClient, transport, 'claude-code', { accountId: 'acct-3' });

    await waitFor(() => expect(result.current.byId.get('acct-3')).toEqual(ACCT_3));
    expect(transport.getAccountUsage).toHaveBeenCalledTimes(1);
    expect(transport.getAccountUsage).toHaveBeenCalledWith('claude-code');
  });

  it('asks the route for an account it knows only by path', async () => {
    const queryClient = createTestQueryClient();
    const transport = createMockTransport({
      getAccountUsage: vi.fn().mockResolvedValue({ accounts: [ACCT_3] }),
    });

    const { result } = renderUsage(queryClient, transport, 'claude-code', { path: ACCT_3.path });

    await waitFor(() => expect(result.current.byPath.get(ACCT_3.path)).toEqual(ACCT_3));
    expect(transport.getAccountUsage).toHaveBeenCalledTimes(1);
  });

  it('asks the route when told to fetch, even with the account seeded', async () => {
    const queryClient = createTestQueryClient();
    const transport = createMockTransport({
      getAccountUsage: vi.fn().mockResolvedValue({ accounts: [ACCT_2] }),
    });
    seedAccountUsage(queryClient, [ACCT_2]);

    renderUsage(queryClient, transport, 'claude-code', { accountId: 'acct-2', fetch: true });

    await waitFor(() => expect(transport.getAccountUsage).toHaveBeenCalledTimes(1));
  });

  it('keeps a reading newer than the route’s answer', async () => {
    const queryClient = createTestQueryClient();
    const fresh = { ...ACCT_2, updatedAt: '2026-09-27T13:00:00.000Z', state: 'warning' as const };
    const transport = createMockTransport({
      getAccountUsage: vi.fn().mockResolvedValue({ accounts: [ACCT_2] }),
    });
    seedAccountUsage(queryClient, [fresh]);

    const { result } = renderUsage(queryClient, transport, 'claude-code', { fetch: true });

    await waitFor(() => expect(transport.getAccountUsage).toHaveBeenCalledTimes(1));
    expect(result.current.byId.get('acct-2')).toEqual(fresh);
  });

  it('reads nothing without a runtime', () => {
    const queryClient = createTestQueryClient();
    const transport = createMockTransport();

    const { result } = renderUsage(queryClient, transport, null, { fetch: true });

    expect(result.current.byId.size).toBe(0);
    expect(transport.getAccountUsage).not.toHaveBeenCalled();
  });

  it('leaves an account with no registry id out of byId', () => {
    const queryClient = createTestQueryClient();
    const root = { ...ACCT_2, accountId: null, path: '/Users/test/.claude' };
    seedAccountUsage(queryClient, [root]);

    const { result } = renderUsage(queryClient, createMockTransport(), 'claude-code');

    expect(result.current.byId.size).toBe(0);
    expect(result.current.byPath.get('/Users/test/.claude')).toEqual(root);
  });
});
