/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
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

  it('draws the default account in the color the server resolved (DOR-2492)', async () => {
    // The server says the default stands alone in teal, even though the
    // inherited folder string-matches a registered row. The client must not
    // second-guess it with its own alias or positional rule.
    const { result } = renderAccounts({
      resolvedAccount: WORK.path,
      inherited: true,
      defaultAccountColor: '#0d9488',
      defaultAccountResolvedColor: '#0d9488',
    });
    await waitFor(() => expect(result.current.accounts).toHaveLength(2));
    expect(result.current.colorFor('default')).toBe('#0d9488');
    expect(result.current.defaultAccountColor).toBe('#0d9488');
    expect(result.current.defaultAccountResolvedColor).toBe('#0d9488');
  });

  it('answers null for default when the server did not resolve a color', async () => {
    const { result } = renderAccounts({ defaultAccountColor: '#0d9488' });
    await waitFor(() => expect(result.current.accounts).toHaveLength(2));
    expect(result.current.colorFor('default')).toBeNull();
  });
});
