/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider, configKeys } from '@/layers/shared/model';
import { useAccountIdentityGate } from '../use-account-identity-gate';

afterEach(cleanup);

function account(n: number) {
  return {
    id: `acct-${n}`,
    path: `/Users/dev/.claude-acct-${n}`,
    label: `Acct ${n}`,
    color: '#2f7be0',
    colorIsDefault: true,
    isAccountRoot: true,
  };
}

/** A transport whose config registers `count` Claude accounts. */
function transportWith(count: number, overrides: Partial<Transport> = {}): Transport {
  const base = createMockTransport();
  const config = {
    claudeCode: {
      resolvedAccount: '/Users/dev/.claude-acct-1',
      inherited: false,
      accounts: Array.from({ length: count }, (_, i) => account(i + 1)),
    },
  } as unknown as ServerConfig;
  return createMockTransport({
    getConfig: async () => config,
    getCapabilities: base.getCapabilities,
    ...overrides,
  });
}

function renderGate(runtime: string | null, transport: Transport) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useAccountIdentityGate(runtime), { wrapper });
  /** Wait until the reads have landed, so a `false` is the answer and not the loading state. */
  const settled = ({ capabilities = true }: { capabilities?: boolean } = {}) =>
    waitFor(() => {
      expect(queryClient.getQueryData(configKeys.current())).toBeDefined();
      if (capabilities) expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
    });
  return { ...hook, settled };
}

describe('useAccountIdentityGate', () => {
  it('is closed with no Claude accounts', async () => {
    const { result, settled } = renderGate('claude-code', transportWith(0));
    await settled();
    expect(result.current).toBe(false);
  });

  it('is closed with one Claude account', async () => {
    const { result, settled } = renderGate('claude-code', transportWith(1));
    await settled();
    expect(result.current).toBe(false);
  });

  it('opens with two Claude accounts on a Claude Code session', async () => {
    const { result } = renderGate('claude-code', transportWith(2));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('opens for a session with no runtime yet when the default runtime is Claude Code', async () => {
    const { result } = renderGate(null, transportWith(2));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays closed for Codex, which does not support accounts, even with two Claude accounts', async () => {
    const { result, settled } = renderGate('codex', transportWith(2));
    await settled();
    expect(result.current).toBe(false);
  });

  it('stays closed for Claude Code with two accounts when it does not declare supportsAccounts', async () => {
    const base = createMockTransport();
    const real = await base.getCapabilities();
    const transport = transportWith(2, {
      getCapabilities: async () => ({
        ...real,
        capabilities: {
          ...real.capabilities,
          'claude-code': { ...real.capabilities['claude-code']!, supportsAccounts: false },
        },
      }),
    });
    const { result, settled } = renderGate('claude-code', transport);
    await settled();
    expect(result.current).toBe(false);
  });

  it('stays closed while capabilities load', async () => {
    const transport = transportWith(2, {
      getCapabilities: () => new Promise(() => {}),
    });
    const { result, settled } = renderGate('claude-code', transport);
    await settled({ capabilities: false });
    expect(result.current).toBe(false);
  });
});
