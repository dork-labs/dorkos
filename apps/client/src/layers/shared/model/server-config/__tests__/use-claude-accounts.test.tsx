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

function renderAccounts() {
  const config = {
    claudeCode: { resolvedAccount: PERSONAL.path, inherited: false, accounts: [PERSONAL, WORK] },
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
});
