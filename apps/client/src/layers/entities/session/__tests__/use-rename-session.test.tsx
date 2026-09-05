/**
 * @vitest-environment jsdom
 *
 * Renaming a session that lives on a Claude account other than the active one
 * (spec `claude-code-accounts` §10). The rename IS saved, but DorkOS only reads a
 * session's custom title while that session's account is active, so the list
 * keeps showing the derived title until the operator switches. Unsaid, that reads
 * as "rename did nothing".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig, Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useClaudeAccounts } from '@/layers/shared/model';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from 'sonner';
import { useRenameSession } from '../model/rename/use-rename-session';
import { sessionKeys } from '../api/query-keys';

const CWD = '/projects/api';
const HOME = '/Users/dev/.claude';
const WORK = '/Users/dev/.claude2';

function makeSession(account?: string): Session {
  return {
    id: 's1',
    title: 'Fix the parser',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: CWD,
    ...(account ? { account } : {}),
  };
}

function config(resolvedAccount: string): Partial<ServerConfig> {
  return {
    claudeCode: {
      resolvedAccount,
      inherited: false,
      accounts: [
        { id: 'personal', path: HOME, label: 'Personal', isAccountRoot: true },
        { id: 'acme-corp', path: WORK, label: 'Acme Corp', isAccountRoot: true },
      ],
    },
  };
}

/** Mount the rename mutation over a session-list cache holding one session. */
function setup(opts: { sessionAccount?: string; defaultAccount?: string }) {
  const transport = createMockTransport({
    // No `defaultAccount` stands for a server that reports no account block at
    // all — the hook then knows the session's account but not the active one.
    getConfig: vi
      .fn()
      .mockResolvedValue(opts.defaultAccount ? config(opts.defaultAccount) : ({} as ServerConfig)),
    updateSession: vi.fn().mockResolvedValue(undefined),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<Session[]>(sessionKeys.list(CWD), [makeSession(opts.sessionAccount)]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  // The probe is not decoration: the hook can only name the account once the
  // config read lands, so a test that mutates before then proves nothing.
  const { result } = renderHook(
    () => ({ rename: useRenameSession(CWD), accounts: useClaudeAccounts() }),
    { wrapper }
  );
  /** The title the sidebar would render for the session right now. */
  const titleInList = () => queryClient.getQueryData<Session[]>(sessionKeys.list(CWD))?.[0]?.title;
  return { result, transport, titleInList };
}

describe('useRenameSession — account honesty', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('says where the new name will appear when the session is on another account', async () => {
    const { result, transport } = setup({ sessionAccount: WORK, defaultAccount: HOME });
    // Wait for the config read, or the hook cannot know which account is active.
    await waitFor(() => expect(result.current.accounts.resolvedAccount).toBe(HOME));

    result.current.rename.mutate({ sessionId: 's1', title: 'Fix the tokenizer' });

    // The rename still goes through — it genuinely works.
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith(
        's1',
        { title: 'Fix the tokenizer' },
        CWD
      )
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Renamed on Acme Corp', {
        description: 'Your session list shows the new name once you switch to that account.',
      })
    );
  });

  it('does not flash a name it would have to take back', async () => {
    const { result, transport, titleInList } = setup({
      sessionAccount: WORK,
      defaultAccount: HOME,
    });
    await waitFor(() => expect(result.current.accounts.resolvedAccount).toBe(HOME));

    result.current.rename.mutate({ sessionId: 's1', title: 'Fix the tokenizer' });

    await waitFor(() => expect(transport.updateSession).toHaveBeenCalled());
    // The settle-time refetch returns the DERIVED title for this account, so an
    // optimistic patch would show the new name and then visibly revert it.
    expect(titleInList()).toBe('Fix the parser');
  });

  it('explains itself even when it does not know which account is active', async () => {
    // The config read has not landed, or the server reports no account block. The
    // hook cannot promise the name appears here, so it must neither patch the row
    // nor go silent — silence plus no visible change is "rename did nothing".
    const { result, transport, titleInList } = setup({ sessionAccount: WORK });
    await waitFor(() => expect(result.current.accounts.accounts).toEqual([]));

    result.current.rename.mutate({ sessionId: 's1', title: 'Fix the tokenizer' });

    await waitFor(() => expect(transport.updateSession).toHaveBeenCalled());
    expect(titleInList()).toBe('Fix the parser');
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Renamed on .claude2', {
        description: 'Your session list shows the new name while .claude2 is the account in use.',
      })
    );
  });

  it('stays quiet when the session is on the active account, and shows the name at once', async () => {
    const { result, transport, titleInList } = setup({
      sessionAccount: HOME,
      defaultAccount: HOME,
    });
    await waitFor(() => expect(result.current.accounts.resolvedAccount).toBe(HOME));

    result.current.rename.mutate({ sessionId: 's1', title: 'Fix the tokenizer' });

    await waitFor(() => expect(titleInList()).toBe('Fix the tokenizer'));
    await waitFor(() => expect(transport.updateSession).toHaveBeenCalled());
    // The name is about to appear on its own; a toast would be noise.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('stays quiet for a session with no account at all', async () => {
    const { result, transport } = setup({ defaultAccount: HOME });
    await waitFor(() => expect(result.current.accounts.resolvedAccount).toBe(HOME));

    result.current.rename.mutate({ sessionId: 's1', title: 'Fix the tokenizer' });

    await waitFor(() => expect(transport.updateSession).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('still reports a failed rename as a failure', async () => {
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue(config(HOME)),
      updateSession: vi.fn().mockRejectedValue(new Error('nope')),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<Session[]>(sessionKeys.list(CWD), [makeSession(WORK)]);
    const { result } = renderHook(() => useRenameSession(CWD), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });

    result.current.mutate({ sessionId: 's1', title: 'Fix the tokenizer' });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The shared mutation toast (`query-client.ts`, exercised via
    // `meta.errorLabel` — not through this bare test client) is the only
    // failure report now; this hook no longer shows its own.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
