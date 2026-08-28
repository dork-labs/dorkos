// @vitest-environment jsdom
/**
 * The reconcile's half of the receipt seam, driven through the real hook.
 *
 * Asserting on the merge helpers alone cannot see the thing most likely to
 * break here: WHEN the settling turn's answers are read. The capture has to
 * happen before the history request is awaited, because a new turn starting
 * while that request is in flight replaces `inProgressTurn` and takes the
 * previous turn's answers with it. Moving the capture into the `.then()` reads
 * exactly the same way and loses every receipt on a busy session.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { useSessionStreamStore, type SessionStreamState } from '@/layers/entities/session';
import { useTurnEndReconcile } from '../model/use-turn-end-reconcile';

const SESSION_ID = 'reconcile-hook-session';
const ASKED_AT = 1_700_000_000_000;

/** The settled turn: a tool asked permission and was allowed. */
const SETTLED_TURN: SessionEvent[] = [
  { seq: 1, type: 'turn_start' },
  {
    seq: 2,
    type: 'tool_call',
    toolCallId: 'tc-1',
    toolName: 'Bash',
    input: JSON.stringify({ command: 'npm test' }),
    status: 'pending',
  },
  {
    seq: 3,
    type: 'interaction_resolved',
    id: 'tc-1',
    kind: 'approval',
    resolution: 'approved',
    at: ASKED_AT + 5_000,
    startedAt: ASKED_AT,
  },
];

/** Canonical history as the runtime returns it: the tool, never the ask. */
const CANONICAL_HISTORY: HistoryMessage[] = [
  {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    parts: [
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        input: JSON.stringify({ command: 'npm test' }),
        status: 'complete',
        result: 'ok',
      },
    ],
    timestamp: '2026-07-31T14:32:05.000Z',
  },
];

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  useSessionStreamStore.getState().removeSession(SESSION_ID);
});

/** The store state the hook reads its lifecycle edge from. */
function streamStateWith(lifecycle: 'streaming' | 'idle'): SessionStreamState {
  const held = useSessionStreamStore.getState().getSession(SESSION_ID);
  return { ...held, status: { ...(held.status ?? {}), lifecycle } as SessionStreamState['status'] };
}

describe('useTurnEndReconcile — carrying receipts', () => {
  it('keeps the settled turn’s answer even when a new turn starts mid-reload', async () => {
    // Purpose: pins the capture to BEFORE the await. The reload is held open
    // while a new turn replaces `inProgressTurn`; a capture taken inside the
    // `.then()` would find the new turn's events and carry nothing.
    const store = useSessionStreamStore.getState();
    store.ensureSession(SESSION_ID);
    for (const event of SETTLED_TURN) store.applyEvent(SESSION_ID, event);

    let releaseHistory!: (messages: HistoryMessage[]) => void;
    const historyPromise = new Promise<{ messages: HistoryMessage[] }>((resolve) => {
      releaseHistory = (messages) => resolve({ messages });
    });
    const transport = {
      getMessages: vi.fn().mockReturnValue(historyPromise),
    } as unknown as Transport;

    const { rerender } = renderHook(
      ({ lifecycle }: { lifecycle: 'streaming' | 'idle' }) =>
        useTurnEndReconcile({
          sessionId: SESSION_ID,
          transport,
          sessionCwd: { cwd: null, resolved: true },
          streamState: streamStateWith(lifecycle),
          queryClient: new QueryClient(),
        }),
      { wrapper, initialProps: { lifecycle: 'streaming' as 'streaming' | 'idle' } }
    );

    // Settle the turn — the reload fires and hangs on `historyPromise`.
    rerender({ lifecycle: 'idle' });
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalled());

    // A new turn arrives while the reload is still in flight. `turn_start`
    // REPLACES inProgressTurn, so the settled turn's resolution is gone.
    act(() => {
      useSessionStreamStore
        .getState()
        .applyEvent(SESSION_ID, { seq: 4, type: 'turn_start' } as SessionEvent);
    });
    expect(
      useSessionStreamStore
        .getState()
        .getSession(SESSION_ID)
        .inProgressTurn.some((e) => e.type === 'interaction_resolved')
    ).toBe(false);

    await act(async () => {
      releaseHistory(CANONICAL_HISTORY);
      await historyPromise;
    });

    await waitFor(() => {
      const parts = useSessionStreamStore.getState().getSession(SESSION_ID).messages[0]?.parts;
      expect(parts?.[0]).toMatchObject({
        toolCallId: 'tc-1',
        interactiveType: 'approval',
        approvalOutcome: 'allowed',
        approvalStartedAt: ASKED_AT,
      });
    });
  });

  it('carries receipts an earlier reconcile already merged into history', async () => {
    // Purpose: history reloads once per turn. Reading only the settling turn
    // would keep each receipt for exactly one turn and then drop it.
    const store = useSessionStreamStore.getState();
    store.ensureSession(SESSION_ID);
    // History already carries a receipt from a previous turn's reconcile.
    store.setHistoryMessages(
      SESSION_ID,
      [
        {
          ...CANONICAL_HISTORY[0],
          parts: [
            {
              ...CANONICAL_HISTORY[0].parts![0],
              interactiveType: 'approval',
              approvalOutcome: 'allowed',
              approvalResolvedAt: ASKED_AT + 5_000,
              approvalStartedAt: ASKED_AT,
            },
          ],
        } as HistoryMessage,
      ],
      {}
    );
    // This turn answered nothing.
    store.applyEvent(SESSION_ID, { seq: 10, type: 'turn_start' } as SessionEvent);

    const transport = {
      getMessages: vi.fn().mockResolvedValue({ messages: CANONICAL_HISTORY }),
    } as unknown as Transport;

    const { rerender } = renderHook(
      ({ lifecycle }: { lifecycle: 'streaming' | 'idle' }) =>
        useTurnEndReconcile({
          sessionId: SESSION_ID,
          transport,
          sessionCwd: { cwd: null, resolved: true },
          streamState: streamStateWith(lifecycle),
          queryClient: new QueryClient(),
        }),
      { wrapper, initialProps: { lifecycle: 'streaming' as 'streaming' | 'idle' } }
    );
    rerender({ lifecycle: 'idle' });

    await waitFor(() => {
      const parts = useSessionStreamStore.getState().getSession(SESSION_ID).messages[0]?.parts;
      expect(parts?.[0]).toMatchObject({ approvalOutcome: 'allowed' });
    });
  });
});
