// @vitest-environment jsdom
/**
 * The reconcile's behaviour across a runtime-opened turn window (DOR-1100).
 *
 * A background task finishing wakes the agent milliseconds after its turn
 * closed, and that continuation settles as a second window. The reconcile fires
 * on every settle edge, so without a guard one message earns the person two
 * turn-finished notifications. The history reload deliberately still runs for
 * both — the second one is what folds the continuation into canonical history.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { useSessionStreamStore, type SessionStreamState } from '@/layers/entities/session';
import { useTurnEndReconcile } from '../model/use-turn-end-reconcile';

const SESSION_ID = 'reconcile-wakeup-session';
const HISTORY: HistoryMessage[] = [
  { id: 'assistant-1', role: 'assistant', content: 'done', timestamp: '2026-08-09T00:00:00.000Z' },
];

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  useSessionStreamStore.getState().removeSession(SESSION_ID);
});

/** The store state the hook reads its settle edge from. */
function streamStateWith(
  lifecycle: 'streaming' | 'idle',
  turnOrigin: 'user' | 'runtime'
): SessionStreamState {
  const held = useSessionStreamStore.getState().getSession(SESSION_ID);
  return {
    ...held,
    turnOrigin,
    status: { ...(held.status ?? {}), lifecycle } as SessionStreamState['status'],
  };
}

/** Mount the hook over a driveable lifecycle + origin pair. */
function mount(transport: Transport, onStreamingDone: () => void) {
  return renderHook(
    ({
      lifecycle,
      turnOrigin,
    }: {
      lifecycle: 'streaming' | 'idle';
      turnOrigin: 'user' | 'runtime';
    }) =>
      useTurnEndReconcile({
        sessionId: SESSION_ID,
        transport,
        selectedCwd: null,
        streamState: streamStateWith(lifecycle, turnOrigin),
        queryClient: new QueryClient(),
        onStreamingDone,
      }),
    {
      wrapper,
      initialProps: {
        lifecycle: 'streaming' as 'streaming' | 'idle',
        turnOrigin: 'user' as 'user' | 'runtime',
      },
    }
  );
}

/** A transport whose history request always resolves. */
function makeTransport(): Transport {
  return { getMessages: vi.fn().mockResolvedValue({ messages: HISTORY }) } as unknown as Transport;
}

describe('useTurnEndReconcile — runtime-opened windows', () => {
  it('sounds the turn-finished notification once across a wake-up', async () => {
    const onDone = vi.fn();
    const transport = makeTransport();
    useSessionStreamStore.getState().ensureSession(SESSION_ID);

    const { rerender } = mount(transport, onDone);

    // The turn the person sent settles: one notification.
    rerender({ lifecycle: 'idle', turnOrigin: 'user' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    // A background task finishes, the agent wakes, works, and settles again.
    rerender({ lifecycle: 'streaming', turnOrigin: 'runtime' });
    rerender({ lifecycle: 'idle', turnOrigin: 'runtime' });

    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(2));
    // …and the person is not pinged a second time for one message.
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('still reloads history for the window nobody asked for', async () => {
    // The continuation is persisted as its own turn server-side, so the reload
    // is what brings it into the transcript. Skipping it with the sound would
    // leave the wake-up's work out of history until the next refresh.
    const transport = makeTransport();
    useSessionStreamStore.getState().ensureSession(SESSION_ID);

    const { rerender } = mount(transport, vi.fn());
    rerender({ lifecycle: 'idle', turnOrigin: 'user' });
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(1));

    rerender({ lifecycle: 'streaming', turnOrigin: 'runtime' });
    rerender({ lifecycle: 'idle', turnOrigin: 'runtime' });
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(2));
  });

  it('sounds it again for the next turn a person actually sends', async () => {
    const onDone = vi.fn();
    const transport = makeTransport();
    useSessionStreamStore.getState().ensureSession(SESSION_ID);

    const { rerender } = mount(transport, onDone);
    rerender({ lifecycle: 'idle', turnOrigin: 'user' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    rerender({ lifecycle: 'streaming', turnOrigin: 'runtime' });
    rerender({ lifecycle: 'idle', turnOrigin: 'runtime' });
    expect(onDone).toHaveBeenCalledTimes(1);

    rerender({ lifecycle: 'streaming', turnOrigin: 'user' });
    rerender({ lifecycle: 'idle', turnOrigin: 'user' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
  });
});
