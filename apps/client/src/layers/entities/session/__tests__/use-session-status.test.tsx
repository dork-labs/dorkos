/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';

import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { toast } from 'sonner';
import { useSessionStatus } from '../model/settings/use-session-status';
import { useSessionSettingsOverridesStore } from '../model/settings/session-settings-overrides';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { warning: vi.fn() }) }));

// Mock app store (selectedCwd).
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: vi.fn((selector?: (s: { selectedCwd: string | null }) => unknown) => {
    const state = { selectedCwd: '/test/cwd' };
    return selector ? selector(state) : state;
  }),
}));

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useSessionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Optimism is a module-level store now (so every reader of a session agrees);
    // reset it so one test's pending change cannot bleed into the next.
    useSessionSettingsOverridesStore.setState({ bySession: {} });
  });

  // Unmount between tests: the overrides store is module-level, so a hook left mounted from an
  // earlier test would keep running its convergence effect against a different test's query
  // cache.
  afterEach(cleanup);

  it('shows a second reader of the same session the optimistic change immediately', async () => {
    // The reason the overrides are shared rather than per-instance: the status line's permission
    // item and the strip above it are two `useSessionStatus` instances, and they used to disagree
    // for a whole PATCH round-trip.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({ id: 's1', model: 'a', permissionMode: 'default' }),
      updateSession: vi.fn().mockResolvedValue({ permissionMode: 'plan' }),
    });
    const wrapper = createWrapper(transport);

    const writer = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const reader = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    await waitFor(() => expect(reader.result.current.permissionMode).toBe('default'));

    await act(async () => {
      writer.result.current.updateSession({ permissionMode: 'plan' });
    });

    expect(reader.result.current.permissionMode).toBe('plan');
  });

  it('holds optimistic model until server confirms via query cache', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockResolvedValue({
        model: 'claude-haiku-4-5-20251001',
      }),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });

    // Wait for initial session query
    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });

    // Trigger model change
    await act(async () => {
      result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    // Optimistic: should immediately show haiku
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');

    // After PATCH resolves and convergence effect fires, should still show haiku
    await waitFor(() => {
      expect(result.current.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  it('says a Wi-Fi refusal calmly, and reverts the mode (DOR-3037)', async () => {
    const refusal = Object.assign(new Error('Raising permissions works only at this computer.'), {
      status: 403,
      code: 'not_from_wifi',
    });
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'server', permissionMode: 'default' }),
      updateSession: vi.fn().mockRejectedValue(refusal),
    });
    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));

    await act(async () => {
      await result.current.updateSession({ permissionMode: 'bypassPermissions' });
    });

    expect(toast).toHaveBeenCalledWith('Raising permissions works only at this computer.');
    await waitFor(() => expect(result.current.permissionMode).toBe('default'));
  });

  it('a failed PATCH does not revert a later writer’s pending value', async () => {
    // Two surfaces now share one optimism store, so a rollback has to be value-scoped.
    let rejectA: (err: Error) => void = () => {};
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'server', permissionMode: 'default' }),
      updateSession: vi
        .fn()
        // A: never settles until we say so.
        .mockImplementationOnce(() => new Promise((_, reject) => (rejectA = reject)))
        // B: also in flight, and still in flight when A fails.
        .mockImplementationOnce(() => new Promise(() => {})),
    });
    const wrapper = createWrapper(transport);

    const a = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const b = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    await waitFor(() => expect(b.result.current.model).toBe('server'));

    await act(async () => {
      void a.result.current.updateSession({ model: 'X' });
    });
    expect(b.result.current.model).toBe('X');

    await act(async () => {
      void b.result.current.updateSession({ model: 'Y' });
    });
    expect(a.result.current.model).toBe('Y');

    // A now fails. Its own value is long gone — the key belongs to B.
    await act(async () => {
      rejectA(new Error('Network error'));
      await Promise.resolve();
    });

    expect(a.result.current.model).toBe('Y');
    expect(b.result.current.model).toBe('Y');
  });
});

/** A stricter setting the running reply never got told about (DOR-1435). */
describe('useSessionStatus and a permission change that has not taken yet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionSettingsOverridesStore.setState({ bySession: {} });
  });
  afterEach(cleanup);

  /** A wrapper whose query client the test can inspect afterwards. */
  function wrapperWithClient(transport: Transport) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return { wrapper, queryClient };
  }

  function transportAnswering(pending: boolean) {
    return createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'a', permissionMode: 'bypassPermissions' }),
      updateSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'a',
        permissionMode: 'default',
        ...(pending ? { permissionModePendingUntilNextTurn: true } : {}),
      }),
    });
  }

  it('tells the person the stricter setting starts on their next message', async () => {
    const transport = transportAnswering(true);
    const { wrapper } = wrapperWithClient(transport);
    const { result } = renderHook(() => useSessionStatus('s1', null, true), { wrapper });

    await act(async () => {
      await result.current.updateSession({ permissionMode: 'default' });
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [title, options] = vi.mocked(toast.warning).mock.calls[0]!;
    expect(String(title)).toMatch(/next message/i);
    expect((options as { description?: string })?.description).toMatch(/current reply/i);
  });

  it('never writes the pending flag into the session cache', async () => {
    // It is a fact about one write, not about the session.
    const transport = transportAnswering(true);
    const { wrapper, queryClient } = wrapperWithClient(transport);
    const written: unknown[] = [];
    const setQueryData = queryClient.setQueryData.bind(queryClient);
    vi.spyOn(queryClient, 'setQueryData').mockImplementation(((key: unknown, updater: unknown) => {
      const result = setQueryData(key as never, updater as never);
      if (JSON.stringify(key).includes('s1')) written.push(result);
      return result;
    }) as typeof queryClient.setQueryData);

    const { result } = renderHook(() => useSessionStatus('s1', null, true), { wrapper });
    await act(async () => {
      await result.current.updateSession({ permissionMode: 'default' });
    });

    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(value).not.toHaveProperty('permissionModePendingUntilNextTurn');
    }
  });
});
