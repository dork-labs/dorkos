// @vitest-environment jsdom
/**
 * The wake-up seam driven through the REAL store, not through props.
 *
 * A prop-driven suite can express "the hook saw this lifecycle, then that one",
 * which is enough to pin the settle rules and not enough to pin anything about
 * ORDER OF ARRIVAL — the earlier version of this file drove props and reported
 * both failures below as passing. Two of them only exist in arrival order:
 *
 * - The reply rendering twice, because the reload lands while a wake-up window
 *   is open and the preserved turn still holds the finished window's deltas.
 * - The chime never firing, because `turn_end` and the wake-up's `turn_start`
 *   arrive in ONE React commit — guaranteed on a `Last-Event-ID` reconnect,
 *   where the whole gap replays as a batch — so the streaming→settled edge the
 *   hook watches for never exists.
 *
 * Both are driven here by feeding real `SessionEvent`s into the real store.
 *
 * @module features/chat/__tests__/wakeup-reconcile-store
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { useSessionStreamStore } from '@/layers/entities/session';
import { useTurnEndReconcile } from '../model/use-turn-end-reconcile';
import { projectInProgressTurn } from '../model/stream/project-session-turn';

const SESSION_ID = 'wakeup-store-session';
const REPLY = 'the answer you asked for';
const CONTINUATION = 'and the background task just landed';

/** Canonical history as the runtime returns it once the first window persisted. */
const HISTORY: HistoryMessage[] = [
  {
    id: 'assistant-1',
    role: 'assistant',
    content: REPLY,
    parts: [{ type: 'text', text: REPLY }],
    timestamp: '2026-08-09T00:00:00.000Z',
  },
];

function snapshot(): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
    },
    pendingInteractions: [],
    queuedMessages: [],
    cursor: 0,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  useSessionStreamStore.getState().removeSession(SESSION_ID);
});

/**
 * Mount the reconcile over the LIVE store entry, so every rerender reads
 * whatever the store holds at that moment rather than a fixture.
 */
function mountOverStore(transport: Transport, onStreamingDone: () => void) {
  return renderHook(
    () =>
      useTurnEndReconcile({
        sessionId: SESSION_ID,
        transport,
        sessionCwd: { cwd: null, resolved: true },
        streamState: useSessionStreamStore((s) => s.sessions[SESSION_ID])!,
        queryClient: new QueryClient(),
        onStreamingDone,
      }),
    { wrapper }
  );
}

/** Every text a reader would see: canonical history plus the live turn. */
function renderedTexts(): string[] {
  const session = useSessionStreamStore.getState().getSession(SESSION_ID);
  const fromHistory = session.messages.flatMap((m) =>
    (m.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : []))
  );
  const fromTurn = projectInProgressTurn(session.inProgressTurn).flatMap((p) =>
    p.type === 'text' ? [p.text] : []
  );
  return [...fromHistory, ...fromTurn];
}

/** Apply events to the store inside one React commit. */
function applyBatch(events: SessionEvent[]): void {
  act(() => {
    for (const event of events) useSessionStreamStore.getState().applyEvent(SESSION_ID, event);
  });
}

describe('the wake-up seam over the real store', () => {
  it('renders the finished reply exactly once while the wake-up window runs', async () => {
    // The realistic timing: the reload is still in flight when the CLI drains its
    // queued notification, so the agent is already talking again by the time
    // history lands. The preserve rule keeps the live turn — and the live turn
    // now holds the FIRST window's deltas too, which history has just supplied.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SESSION_ID, snapshot());

    let releaseHistory!: (messages: HistoryMessage[]) => void;
    const historyPromise = new Promise<{ messages: HistoryMessage[] }>((resolve) => {
      releaseHistory = (messages) => resolve({ messages });
    });
    const transport = {
      getMessages: vi.fn().mockReturnValue(historyPromise),
    } as unknown as Transport;

    mountOverStore(transport, vi.fn());

    // The turn the person sent, and its close.
    applyBatch([
      { type: 'turn_start', seq: 1, userMessage: 'do the thing' },
      { type: 'text_delta', seq: 2, text: REPLY },
    ]);
    applyBatch([{ type: 'turn_end', seq: 3 }]);
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(1));

    // The wake-up beats the HTTP round trip.
    applyBatch([
      { type: 'turn_start', seq: 4, origin: 'runtime' },
      { type: 'text_delta', seq: 5, text: CONTINUATION },
    ]);

    await act(async () => {
      releaseHistory(HISTORY);
      await historyPromise;
    });

    await waitFor(() => {
      expect(useSessionStreamStore.getState().getSession(SESSION_ID).messages).toHaveLength(1);
    });

    const texts = renderedTexts();
    expect(texts.filter((t) => t === REPLY)).toHaveLength(1);
    // …and the continuation is still on screen, streaming, where it belongs.
    expect(texts).toContain(CONTINUATION);
  });

  it('keeps the wake-up window intact when the reload lands', async () => {
    // The other half of the same rule: trimming must take the finished window's
    // prefix and nothing else. A trim that ate the live window would blank the
    // continuation, which is the failure this whole change exists to fix.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SESSION_ID, snapshot());
    const transport = {
      getMessages: vi.fn().mockResolvedValue({ messages: HISTORY }),
    } as unknown as Transport;

    mountOverStore(transport, vi.fn());

    applyBatch([
      { type: 'turn_start', seq: 1, userMessage: 'do the thing' },
      { type: 'text_delta', seq: 2, text: REPLY },
    ]);
    applyBatch([{ type: 'turn_end', seq: 3 }]);
    applyBatch([
      { type: 'turn_start', seq: 4, origin: 'runtime' },
      { type: 'text_delta', seq: 5, text: CONTINUATION },
      {
        type: 'tool_call',
        seq: 6,
        toolCallId: 'tc-1',
        toolName: 'Bash',
        status: 'running',
      },
    ]);

    await waitFor(() => {
      const held = useSessionStreamStore.getState().getSession(SESSION_ID);
      expect(held.messages).toHaveLength(1);
      expect(held.inProgressTurn.map((e) => e.type)).toEqual([
        'turn_start',
        'text_delta',
        'tool_call',
      ]);
    });
  });

  it('chimes once when turn_end and the wake-up arrive in one commit', async () => {
    // A `Last-Event-ID` reconnect replays the whole gap as a batch, so the
    // streaming→settled edge is never observed: the hook sees `streaming` before
    // and `streaming` after. Keying the chime off the settling window's origin
    // meant nobody was ever told the turn they sent had finished.
    const onDone = vi.fn();
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SESSION_ID, snapshot());
    const transport = {
      getMessages: vi.fn().mockResolvedValue({ messages: HISTORY }),
    } as unknown as Transport;

    mountOverStore(transport, onDone);

    applyBatch([
      { type: 'turn_start', seq: 1, userMessage: 'do the thing' },
      { type: 'text_delta', seq: 2, text: REPLY },
    ]);
    // One commit: the close AND the wake-up.
    applyBatch([
      { type: 'turn_end', seq: 3 },
      { type: 'turn_start', seq: 4, origin: 'runtime' },
      { type: 'text_delta', seq: 5, text: CONTINUATION },
    ]);
    applyBatch([{ type: 'turn_end', seq: 6 }]);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // Give any second chime a chance to land before declaring it did not.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('chimes once per message across an unbatched wake-up too', async () => {
    const onDone = vi.fn();
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SESSION_ID, snapshot());
    const transport = {
      getMessages: vi.fn().mockResolvedValue({ messages: HISTORY }),
    } as unknown as Transport;

    mountOverStore(transport, onDone);

    applyBatch([{ type: 'turn_start', seq: 1, userMessage: 'go' }]);
    applyBatch([{ type: 'turn_end', seq: 2 }]);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    applyBatch([{ type: 'turn_start', seq: 3, origin: 'runtime' }]);
    applyBatch([{ type: 'turn_end', seq: 4 }]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDone).toHaveBeenCalledTimes(1);

    // The next message the person sends earns its own.
    applyBatch([{ type: 'turn_start', seq: 5, userMessage: 'again' }]);
    applyBatch([{ type: 'turn_end', seq: 6 }]);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
  });

  it('still reloads history for the window nobody asked for', async () => {
    // Only the CHIME is spent once. The continuation is persisted as its own
    // turn server-side, so its reload is what brings it into the transcript;
    // skipping it alongside the chime would leave the wake-up's work out of
    // history until the next refresh.
    const transport = {
      getMessages: vi.fn().mockResolvedValue({ messages: HISTORY }),
    } as unknown as Transport;
    useSessionStreamStore.getState().applySnapshot(SESSION_ID, snapshot());

    mountOverStore(transport, vi.fn());

    applyBatch([{ type: 'turn_start', seq: 1, userMessage: 'go' }]);
    applyBatch([{ type: 'turn_end', seq: 2 }]);
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(1));

    applyBatch([{ type: 'turn_start', seq: 3, origin: 'runtime' }]);
    applyBatch([{ type: 'turn_end', seq: 4 }]);
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(2));
  });
});
