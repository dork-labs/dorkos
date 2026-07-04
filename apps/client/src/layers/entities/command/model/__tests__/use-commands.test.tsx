/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useCommands } from '../use-commands';
import type { CommandRegistry } from '@dorkos/shared/types';

const claudeRegistry: CommandRegistry = {
  commands: [{ fullCommand: '/compact', description: 'Compact conversation history' }],
  lastScanned: '2024-01-01T00:00:00.000Z',
};

describe('useCommands', () => {
  it('returns the command registry from transport', async () => {
    const transport = createMockTransport({
      getCommands: vi.fn().mockResolvedValue(claudeRegistry),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useCommands('/repo'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual(claudeRegistry);
    });

    expect(transport.getCommands).toHaveBeenCalledOnce();
  });

  it('keys the cache by runtime so each runtime fetches its own commands', async () => {
    const codexRegistry: CommandRegistry = {
      commands: [{ fullCommand: '/codex-skill', description: 'Codex project skill' }],
      lastScanned: '2024-01-01T00:00:00.000Z',
    };
    const getCommands = vi.fn(
      (_refresh?: boolean, _cwd?: string, opts?: { sessionId?: string; runtime?: string }) =>
        Promise.resolve(opts?.runtime === 'codex' ? codexRegistry : claudeRegistry)
    );
    const transport = createMockTransport({ getCommands });
    // One shared client across both hooks: distinct query keys must not dedupe.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }

    const claude = renderHook(() => useCommands('/repo', undefined, 'claude-code'), {
      wrapper: Wrapper,
    });
    const codex = renderHook(() => useCommands('/repo', undefined, 'codex'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(claude.result.current.data).toEqual(claudeRegistry);
      expect(codex.result.current.data).toEqual(codexRegistry);
    });

    // Each runtime resolved independently — no stale cross-runtime cache hit.
    expect(getCommands).toHaveBeenCalledWith(false, '/repo', {
      sessionId: undefined,
      runtime: 'claude-code',
    });
    expect(getCommands).toHaveBeenCalledWith(false, '/repo', {
      sessionId: undefined,
      runtime: 'codex',
    });
    expect(getCommands).toHaveBeenCalledTimes(2);
  });
});
