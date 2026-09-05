/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { toast } from 'sonner';
import { useSessionStatus } from '../model/settings/use-session-status';
import { useSessionSettingsOverridesStore } from '../model/settings/session-settings-overrides';

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }));

// Mock app store (selectedCwd). A resolved directory, because a session query
// correctly refuses to fire without one (DOR-495) — `null` is the app's
// pre-startup state, not a state any session request is made in.
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: vi.fn((selector: (s: { selectedCwd: string | null }) => unknown) =>
    selector({ selectedCwd: '/test/cwd' })
  ),
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

  // Unmount between tests: the overrides store is module-level, so a hook left
  // mounted from an earlier test would keep running its convergence effect
  // against a different test's query cache.
  afterEach(cleanup);

  it('shows a second reader of the same session the optimistic change immediately', async () => {
    // The reason the overrides are shared rather than per-instance: the status
    // line's permission item and the strip above it are two `useSessionStatus`
    // instances, and they used to disagree for a whole PATCH round-trip.
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

  it("keeps one session's optimism out of another session", async () => {
    const transport = createMockTransport({
      getSession: vi.fn(
        async (id: string) => ({ id, model: 'a', permissionMode: 'default' }) as never
      ),
      updateSession: vi.fn().mockResolvedValue({ permissionMode: 'plan' }),
    });
    const wrapper = createWrapper(transport);

    const first = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const other = renderHook(() => useSessionStatus('s2', null, false), { wrapper });
    await waitFor(() => expect(other.result.current.permissionMode).toBe('default'));

    await act(async () => {
      first.result.current.updateSession({ permissionMode: 'plan' });
    });

    expect(first.result.current.permissionMode).toBe('plan');
    expect(other.result.current.permissionMode).toBe('default');
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

  it('reverts optimistic model on PATCH failure', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });

    // Trigger model change — PATCH will fail
    await act(async () => {
      result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    // After PATCH fails: reverts to sonnet (catch path clears optimistic state)
    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });
  });

  it('hands a failure to the caller, after the rollback and without throwing', async () => {
    // The Trust Dial needs this: a Full-autonomy write the server refuses is a
    // question to re-ask, not a fault to report. It sees the refusal only if the
    // hook offers it one — and only after the optimistic mode is already back to
    // what the server says, so whatever it draws is drawn over settled state.
    const refusal = Object.assign(new Error('needs consent'), {
      code: 'AUTONOMY_ACK_REQUIRED',
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

    const onError = vi.fn();
    await act(async () => {
      await result.current.updateSession({ permissionMode: 'bypassPermissions' }, { onError });
    });

    expect(onError).toHaveBeenCalledWith(refusal);
    expect(result.current.permissionMode).toBe('default');
  });

  it('swallows a failure when the caller asked for nothing', async () => {
    // The default stays fire-and-forget. Rethrowing would turn every dropped
    // connection on a fire-and-forget write into an unhandled rejection.
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'server', permissionMode: 'default' }),
      updateSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.model).toBe('server'));

    await expect(result.current.updateSession({ model: 'other' })).resolves.toBeUndefined();
  });

  it("a failed PATCH does not revert a later writer's pending value", async () => {
    // Two surfaces now share one optimism store, so a rollback has to be
    // value-scoped. Key-scoped, this sequence snapped every reader back to the
    // server's model while B's request was still in flight: A sets X, B sets Y, A
    // rejects, A's catch drops the `model` key — including B's value.
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

  it('still reverts its own value when nothing newer is pending', async () => {
    const transport = createMockTransport({
      getSession: vi
        .fn()
        .mockResolvedValue({ id: 's1', model: 'server', permissionMode: 'default' }),
      updateSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    const wrapper = createWrapper(transport);

    const a = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    const b = renderHook(() => useSessionStatus('s1', null, false), { wrapper });
    await waitFor(() => expect(b.result.current.model).toBe('server'));

    await act(async () => {
      await a.result.current.updateSession({ model: 'X' });
    });

    // Both readers roll back together — the point of sharing the store.
    expect(a.result.current.model).toBe('server');
    expect(b.result.current.model).toBe('server');
  });

  it('applies convergence to permissionMode consistently', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockResolvedValue({
        permissionMode: 'plan',
      }),
    });

    const { result } = renderHook(() => useSessionStatus('s1', null, false), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.permissionMode).toBe('default');
    });

    // Trigger permissionMode change
    await act(async () => {
      result.current.updateSession({ permissionMode: 'plan' });
    });

    // Optimistic: should immediately show 'plan'
    expect(result.current.permissionMode).toBe('plan');

    // After convergence, should still show 'plan'
    await waitFor(() => {
      expect(result.current.permissionMode).toBe('plan');
    });
  });

  it('does not use streamingStatus.model when isStreaming is false', async () => {
    // Purpose: Regression for Bug #3 — after a stream, the stale streamingStatus.model
    // must not override session.model, so model changes via PATCH are reflected immediately.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-haiku-4-5-20251001',
        permissionMode: 'default',
      }),
    });

    const streamingStatus = { model: 'claude-sonnet-4-6' } as SessionStatusEvent;

    const { result } = renderHook(() => useSessionStatus('s1', streamingStatus, false), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      // session?.model should win; streamingStatus.model must NOT override it
      expect(result.current.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  it('uses streamingStatus.model while isStreaming is true', async () => {
    // Purpose: Verify the fix does not break live-streaming display of model name.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
    });

    const streamingStatus = { model: 'claude-opus-4-6' } as SessionStatusEvent;

    const { result } = renderHook(() => useSessionStatus('s1', streamingStatus, true), {
      wrapper: createWrapper(transport),
    });

    // streamingStatus.model should be used during streaming (synchronous — no await needed)
    expect(result.current.model).toBe('claude-opus-4-6');
  });

  it('updateSession is a no-op when sessionId is null', async () => {
    // Purpose: Verify Bug A guard — when no session exists (null sessionId), updateSession
    // must silently return without calling transport.updateSession.
    const transport = createMockTransport({
      updateSession: vi.fn(),
    });

    const { result } = renderHook(() => useSessionStatus(null, null, false), {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      await result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    expect(transport.updateSession).not.toHaveBeenCalled();
  });
});

/**
 * A stricter setting the running reply never got told about (DOR-1435).
 *
 * The dial moves — the choice IS saved — so the only dishonest version of this
 * screen is the silent one, where the person reads the new mode and believes
 * the reply in front of them is running under it.
 */
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
    expect((options as { description?: string })?.description).toMatch(/already running/i);
  });

  it('says nothing when the change did reach the running reply', async () => {
    const transport = transportAnswering(false);
    const { wrapper } = wrapperWithClient(transport);
    const { result } = renderHook(() => useSessionStatus('s1', null, true), { wrapper });

    await act(async () => {
      await result.current.updateSession({ permissionMode: 'default' });
    });

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('never writes the pending flag into the session cache', async () => {
    // It is a fact about one write, not about the session. Cached, it would go
    // on claiming "starts on your next message" long after that message.
    //
    // The WRITE is what is asserted, not the cache a moment later: the session
    // query refetches on its own and would wash the flag out regardless, so
    // reading the cache after the fact passes whether or not the write was
    // clean.
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

  it('never writes the guessed-runtime flag into the session cache either', async () => {
    // DOR-1693. Same rule, harder consequence: this cache genuinely does not
    // wash the flag out. `syncSessionDetailCache` merges list rows over the
    // entry and re-stamps its freshness, and a list row has no such field — so a
    // cached `true` would outlive the binding that made it false and be renewed
    // on every list refresh, calling a settled runtime a guess forever.
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({ id: 's1', model: 'a', runtime: 'claude-code' }),
      updateSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'a',
        runtime: 'claude-code',
        runtimeUnbound: true,
      }),
    });
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
      await result.current.updateSession({ model: 'b' });
    });

    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(value).not.toHaveProperty('runtimeUnbound');
    }
  });
});
