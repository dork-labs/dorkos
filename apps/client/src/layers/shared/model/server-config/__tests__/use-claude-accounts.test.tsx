/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_ACCOUNT_COLORS } from '@dorkos/shared/account-usage';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '../../TransportContext';
import { useClaudeAccounts } from '../use-claude-accounts';

afterEach(cleanup);

const PERSONAL = {
  id: 'personal',
  path: '/Users/dev/.claude',
  label: 'Personal',
  color: '#2f7be0',
  colorIsDefault: true,
  isAccountRoot: true,
};
const WORK = {
  id: 'work',
  path: '/Users/dev/.claude2',
  label: 'Work',
  color: '#d6336c',
  colorIsDefault: false,
  isAccountRoot: true,
};

function renderAccounts(claudeCode: Record<string, unknown> = {}) {
  const config = {
    claudeCode: {
      resolvedAccount: PERSONAL.path,
      inherited: false,
      accounts: [PERSONAL, WORK],
      ...claudeCode,
    },
  } as unknown as ServerConfig;
  const transport = createMockTransport({ getConfig: async () => config });
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useClaudeAccounts(), { wrapper });
}

describe('useClaudeAccounts', () => {
  it('carries each account’s color and whether it is the default', async () => {
    const { result } = renderAccounts();
    await waitFor(() => expect(result.current.accounts).toHaveLength(2));
    expect(result.current.accounts[1]).toMatchObject({ color: '#d6336c', colorIsDefault: false });
    expect(result.current.accounts[0]).toMatchObject({ color: '#2f7be0', colorIsDefault: true });
  });

  it('finds an account’s color by id, then by path, and answers null for an unknown one', async () => {
    const { result } = renderAccounts();
    await waitFor(() => expect(result.current.accounts).toHaveLength(2));
    expect(result.current.colorFor('work')).toBe('#d6336c');
    expect(result.current.colorFor('/Users/dev/.claude')).toBe('#2f7be0');
    expect(result.current.colorFor('/Users/dev/.claude9')).toBeNull();
  });

  it('colors the default account as the server does (DOR-2492)', async () => {
    // Standalone (nobody registered the default folder): the chosen color…
    const chosen = renderAccounts({
      resolvedAccount: '/Users/dev/.claude-main',
      inherited: true,
      defaultAccountColor: '#0d9488',
    });
    await waitFor(() => expect(chosen.result.current.accounts).toHaveLength(2));
    expect(chosen.result.current.defaultAccountColor).toBe('#0d9488');
    expect(chosen.result.current.colorFor('default')).toBe('#0d9488');
    cleanup();

    // …else the default for the position after the two registered rows.
    const positional = renderAccounts({
      resolvedAccount: '/Users/dev/.claude-main',
      inherited: false,
      defaultAccountColor: null,
    });
    await waitFor(() => expect(positional.result.current.accounts).toHaveLength(2));
    expect(positional.result.current.colorFor('default')).toBe(DEFAULT_ACCOUNT_COLORS[2]);
    expect(positional.result.current.colorFor('/Users/dev/.claude-main')).toBe(
      DEFAULT_ACCOUNT_COLORS[2]
    );
    cleanup();

    // An alias: a registered row has the default folder, so ITS color wins.
    const alias = renderAccounts({ defaultAccountColor: '#0d9488' });
    await waitFor(() => expect(alias.result.current.accounts).toHaveLength(2));
    expect(alias.result.current.colorFor('default')).toBe(PERSONAL.color);
  });
});
