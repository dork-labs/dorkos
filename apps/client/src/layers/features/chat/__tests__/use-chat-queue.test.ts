// @vitest-environment jsdom
/**
 * `useChatQueue` — the QueuePanel ↔ queue-store boundary.
 *
 * The card callbacks address a queue item by its stable id, never by position:
 * the auto-flush dequeues the head while the panel is on screen, so an index
 * captured at render time can point at the neighbouring message by the time the
 * click lands. These tests pin the id contract and the draft bookkeeping that
 * rides on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { useChatQueue } from '../model/use-chat-queue';
import type { ChatStatus } from '../model/chat-types';
import {
  useSessionChatState,
  useSessionChatStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import type { ComposerInputHandle } from '@/layers/features/composer';

const SESSION_ID = 'session-1';

/** Drives the hook with real composer state, the way ChatInputContainer does. */
function useHarness(status: ChatStatus = 'streaming', onFlush = vi.fn()) {
  const [input, setInput] = useState('');
  const chatInputRef = useRef<ComposerInputHandle | null>(null);
  const queue = useChatQueue({
    input,
    setInput,
    status,
    sessionBusy: false,
    sessionId: SESSION_ID,
    selectedCwd: '/dir',
    onFlush,
    tryNativeCommand: () => ({ handled: false }),
    chatInputRef,
  });
  return { input, setInput, ...queue };
}

/**
 * Drives the hook with STORE-BACKED composer state — the shape that actually
 * ships. `input` is per-session state in the chat store, which is the whole
 * reason a session switch mid-edit could leave one session's composer holding
 * another value than the operator left there.
 */
function useStoreBackedHarness(sessionId: string, selectedCwd = '/dir') {
  const { input } = useSessionChatState(sessionId);
  const setInput = useCallback(
    (value: string) => useSessionChatStore.getState().updateSession(sessionId, { input: value }),
    [sessionId]
  );
  const chatInputRef = useRef<ComposerInputHandle | null>(null);
  const queue = useChatQueue({
    input,
    setInput,
    status: 'streaming',
    sessionBusy: false,
    sessionId,
    selectedCwd,
    onFlush: vi.fn(),
    tryNativeCommand: () => ({ handled: false }),
    chatInputRef,
  });
  return { input, setInput, ...queue };
}

/** The queued contents of a session, read straight from the store. */
function queuedIn(sessionId: string): string[] {
  return useSessionStreamStore
    .getState()
    .getSession(sessionId)
    .queuedMessages.map((m) => m.content);
}

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('useChatQueue', () => {
  it('queues the composer text and clears the composer', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('follow-up'));
    act(() => result.current.handleQueue());

    expect(result.current.queue.map((item) => item.content)).toEqual(['follow-up']);
    expect(result.current.input).toBe('');
  });

  it('editing by id loads the item and parks the draft; cancelling restores it', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('queued text'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    expect(result.current.input).toBe('queued text');
    expect(result.current.editingIndex).toBe(0);

    act(() => result.current.handleQueueCancelEdit());
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('saving an edit writes the item and restores the draft', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('queued text'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('revised text'));

    act(() => result.current.handleQueueSaveEdit());

    expect(result.current.queue.map((item) => item.content)).toEqual(['revised text']);
    expect(result.current.input).toBe('half-written thought');
  });

  it('editing an id that is no longer queued leaves the composer untouched', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('queued text'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    // The item flushed between render and click.
    act(() => result.current.handleQueueEdit('already-flushed'));

    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('removing the item under edit restores the draft; removing another does not', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('first'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('second'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    const [first, second] = result.current.queue;
    act(() => result.current.handleQueueEdit(second.id));
    expect(result.current.input).toBe('second');

    // Removing a different card must not disturb the edit in progress.
    act(() => result.current.handleQueueRemove(first.id));
    expect(result.current.input).toBe('second');
    expect(result.current.editingIndex).toBe(0);

    // Removing the card being edited hands the draft back.
    act(() => result.current.handleQueueRemove(second.id));
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
    expect(result.current.queue).toHaveLength(0);
  });

  it('arrow navigation walks the queue by position and hands the draft back at the end', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('first'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('second'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    act(() => result.current.handleQueueNavigateUp());
    expect(result.current.input).toBe('second');

    act(() => result.current.handleQueueNavigateUp());
    expect(result.current.input).toBe('first');

    act(() => result.current.handleQueueNavigateDown());
    expect(result.current.input).toBe('second');

    act(() => result.current.handleQueueNavigateDown());
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('arrow navigation on an empty queue is inert', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueNavigateUp());

    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });
});

describe('useChatQueue — leaving an edit keeps the rewrite (DOR-480)', () => {
  /** Queues two messages, parks a draft, then opens the second one for editing. */
  function editSecondOfTwo() {
    const harness = renderHook(() => useHarness());
    const { result } = harness;

    act(() => result.current.setInput('first'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('second'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueEdit(result.current.queue[1].id));
    expect(result.current.input).toBe('second');

    // The operator rewrites it but does not press Enter.
    act(() => result.current.setInput('second, revised'));
    return harness;
  }

  it('keeps the rewrite when ArrowUp moves to the row above', () => {
    const { result } = editSecondOfTwo();

    act(() => result.current.handleQueueNavigateUp());

    // The rewrite landed in the queue; the composer now shows the row above.
    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second, revised']);
    expect(result.current.input).toBe('first');
  });

  it('keeps the rewrite when ArrowDown leaves the queue past the end', () => {
    const { result } = editSecondOfTwo();

    act(() => result.current.handleQueueNavigateDown());

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second, revised']);
    // …and the parked draft comes back, exactly as before.
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('keeps the rewrite when another row is clicked', () => {
    const { result } = editSecondOfTwo();

    act(() => result.current.handleQueueEdit(result.current.queue[0].id));

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second, revised']);
    expect(result.current.input).toBe('first');
  });

  it('re-clicking the row under edit does not overwrite the rewrite', () => {
    const { result } = editSecondOfTwo();

    act(() => result.current.handleQueueEdit(result.current.queue[1].id));

    // Reloading the stored text here would silently discard what was typed.
    expect(result.current.input).toBe('second, revised');
    expect(result.current.editingIndex).toBe(1);
  });

  it('an emptied composer is not a delete — the item keeps its content', () => {
    const { result } = editSecondOfTwo();

    act(() => result.current.setInput(''));
    act(() => result.current.handleQueueNavigateUp());

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second']);
  });

  it('Escape still discards the edit (deliberate — that is what Escape is for)', () => {
    const { result } = editSecondOfTwo();

    act(() => result.current.handleQueueCancelEdit());

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second']);
    expect(result.current.input).toBe('half-written thought');
  });
});

describe('useChatQueue — send now (BUG 4 recovery)', () => {
  it('sends the row under edit as the REWRITE, and hands the draft back', () => {
    const onFlush = vi.fn();
    // `error` is the stranded state: the auto-flush pump never fires again.
    const { result } = renderHook(() => useHarness('error', onFlush));

    act(() => result.current.setInput('run the migration'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('run the migration on staging first'));

    act(() => result.current.handleQueueSend(result.current.queue[0].id));

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith('run the migration on staging first', SESSION_ID, {
      queued: true,
      restore: expect.any(Function),
    });
    expect(queuedIn(SESSION_ID)).toEqual([]);
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('reports the reason Send-now is unavailable mid-reply', () => {
    const { result } = renderHook(() => useHarness('streaming'));
    expect(result.current.sendBlockedReason).toBe('Waiting for the reply to finish');
  });

  it('offers Send-now on a session whose turn failed', () => {
    const { result } = renderHook(() => useHarness('error'));
    expect(result.current.sendBlockedReason).toBeNull();
  });
});

describe('useChatQueue — switching sessions mid-edit (DOR-480 duplicate send)', () => {
  /**
   * The bug: the editing cursor is component state, the composer text is
   * per-session store state. Switching away reset the cursor but left the
   * queued item's body sitting in the outgoing session's composer, where it
   * looked like an ordinary draft — so coming back and pressing Enter sent a
   * duplicate of a message that was still queued and would flush again.
   */
  function openSessionAWithEditInFlight() {
    const harness = renderHook(({ sessionId }) => useStoreBackedHarness(sessionId), {
      initialProps: { sessionId: 'A' },
    });
    const { result } = harness;

    act(() => result.current.setInput('deploy to staging'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('wait, also '));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    expect(result.current.input).toBe('deploy to staging');

    return harness;
  }

  it("leaves A's composer holding A's draft, not A's queued message", () => {
    const { result, rerender } = openSessionAWithEditInFlight();

    rerender({ sessionId: 'B' });
    rerender({ sessionId: 'A' });

    // The queued message is STILL queued (it will flush on A's next edge)…
    expect(queuedIn('A')).toEqual(['deploy to staging']);
    // …so the composer must not also hold it, or Enter sends it twice.
    expect(result.current.input).toBe('wait, also ');
    expect(result.current.editingIndex).toBeNull();
  });

  it("commits an in-flight rewrite into A's queue on the way out", () => {
    const { result, rerender } = openSessionAWithEditInFlight();

    act(() => result.current.setInput('deploy to production instead'));
    rerender({ sessionId: 'B' });

    expect(queuedIn('A')).toEqual(['deploy to production instead']);
    // B's own composer is untouched by A's handoff.
    expect(result.current.input).toBe('');
    expect(queuedIn('B')).toEqual([]);

    rerender({ sessionId: 'A' });
    expect(result.current.input).toBe('wait, also ');
    expect(queuedIn('A')).toEqual(['deploy to production instead']);
  });

  it('a cwd-only change gets the same handoff — the cursor resets on that too', () => {
    // `useMessageQueue` scopes the editing cursor to (sessionId, cwd). Keying the
    // handoff on sessionId alone left the identical duplicate-send shape behind a
    // cwd change: cursor gone, item still queued, its body still in the composer.
    // `switch-agent-cwd.ts` sets cwd and then navigates, one un-batched render
    // apart, so this is a render ordering away from live.
    const { result, rerender } = renderHook(
      ({ sessionId, selectedCwd }) => useStoreBackedHarness(sessionId, selectedCwd),
      { initialProps: { sessionId: 'A', selectedCwd: '/one' } }
    );

    act(() => result.current.setInput('deploy to staging'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('wait, also '));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    expect(result.current.input).toBe('deploy to staging');

    rerender({ sessionId: 'A', selectedCwd: '/two' });

    expect(result.current.editingIndex).toBeNull();
    expect(queuedIn('A')).toEqual(['deploy to staging']);
    expect(result.current.input).toBe('wait, also ');
  });
});

describe('useChatQueue — a refused send leaves the edit exactly as it was (DOR-480)', () => {
  it('does not swap the composer when Send-now is blocked', () => {
    const onFlush = vi.fn();
    // Streaming blocks a hand-send; the row's control is `aria-disabled`, but the
    // handler must hold the line on its own — the keyboard path can still fire it.
    const { result } = renderHook(() => useHarness('streaming', onFlush));

    act(() => result.current.setInput('run the migration'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('run the migration on staging first'));

    act(() => result.current.handleQueueSend(result.current.queue[0].id));

    expect(onFlush).not.toHaveBeenCalled();
    // The rewrite is still on screen and still the item's content. Swapping in
    // the parked draft here would leave the cursor pointing at this row, and the
    // next Enter routes to onSaveEdit — writing the draft over the rewrite.
    expect(result.current.input).toBe('run the migration on staging first');
    expect(result.current.editingIndex).toBe(0);
    expect(queuedIn(SESSION_ID)).toEqual(['run the migration on staging first']);
  });

  it('does not swap the composer when the row has already left the queue', () => {
    // The unguarded branch: `sendNow` bails on `index === -1`, which no `disabled`
    // attribute covers — the auto-flush can dequeue between render and click.
    const onFlush = vi.fn();
    const { result } = renderHook(() => useHarness('error', onFlush));

    act(() => result.current.setInput('run the migration'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    const rowId = result.current.queue[0].id;
    act(() => result.current.handleQueueEdit(rowId));
    act(() => result.current.setInput('run the migration on staging first'));

    // It flushes out from under the click.
    act(() => {
      useSessionStreamStore.getState().removeQueuedMessage(SESSION_ID, rowId);
    });
    act(() => result.current.handleQueueSend(rowId));

    expect(onFlush).not.toHaveBeenCalled();
    expect(result.current.input).toBe('run the migration on staging first');
  });
});

describe('useChatQueue — a native command cannot reach the queue by the edit door', () => {
  let ranWith: string[] = [];
  beforeEach(() => {
    ranWith = [];
  });

  /**
   * A harness whose native funnel claims anything slash-shaped and records it —
   * standing in for the real `tryRun`, which recognizes both client-native
   * commands and every canonical intent (including the runtime-fulfilled
   * `/compact` that `parseNativeCommand` skips).
   */
  function useCommandHarness(ran = true) {
    const [input, setInput] = useState('');
    const chatInputRef = useRef<ComposerInputHandle | null>(null);
    const queue = useChatQueue({
      input,
      setInput,
      status: 'streaming',
      sessionBusy: false,
      sessionId: SESSION_ID,
      selectedCwd: '/dir',
      onFlush: vi.fn(),
      tryNativeCommand: (content: string) => {
        if (!content.startsWith('/')) return { handled: false };
        ranWith.push(content);
        return { handled: true, ran };
      },
      chatInputRef,
    });
    return { input, setInput, ...queue };
  }

  it('RUNS a command typed into the edit box instead of queueing it', () => {
    // `handleQueue` runs the funnel at enqueue time; the edit paths did not, so a
    // rewrite could put one in the queue — where it flushes without starting a
    // turn and the pump never re-arms. Refusing was the first fix and was a dead
    // end (Escape lost the text, every correction was refused again), so an edit
    // that becomes a command now means what typing it fresh means.
    const { result } = renderHook(() => useCommandHarness(true));

    act(() => result.current.setInput('run the tests'));
    act(() => result.current.handleQueue());
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('/rename my session'));

    act(() => result.current.handleQueueSaveEdit());

    expect(ranWith).toContain('/rename my session');
    // The row keeps what it had — a command is not a message — and the edit ends.
    expect(queuedIn(SESSION_ID)).toEqual(['run the tests']);
    expect(result.current.editingIndex).toBeNull();
    expect(result.current.input).toBe('');
  });

  it('keeps a REJECTED command in the composer so it can be fixed in place', () => {
    // The recovery that did not exist under the refuse-based guard: the text
    // stays, the cursor stays, and a corrected form runs on the next Enter.
    const { result } = renderHook(() => useCommandHarness(false));

    act(() => result.current.setInput('run the tests'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('/rename'));

    act(() => result.current.handleQueueSaveEdit());

    expect(result.current.input).toBe('/rename');
    expect(result.current.editingIndex).toBe(0);
    expect(queuedIn(SESSION_ID)).toEqual(['run the tests']);
  });

  it('still saves an edit the funnel does not claim', () => {
    const { result } = renderHook(() => useCommandHarness());

    act(() => result.current.setInput('run the tests'));
    act(() => result.current.handleQueue());
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('explain what /rename does'));

    act(() => result.current.handleQueueSaveEdit());

    expect(queuedIn(SESSION_ID)).toEqual(['explain what /rename does']);
  });

  it('routes /compact to the funnel — the intent the client-native parser skips', () => {
    // THE bug in the first guard: it gated on `parseNativeCommand`, which
    // deliberately does not match the runtime-fulfilled compact intent, so
    // `/compact` (and every alias) saved straight to the head of the queue,
    // dispatched at flush, started no turn, and stranded everything behind it.
    const { result } = renderHook(() => useCommandHarness(true));

    act(() => result.current.setInput('run the tests'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('second'));
    act(() => result.current.handleQueue());
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('/compact'));

    act(() => result.current.handleQueueSaveEdit());

    expect(ranWith).toContain('/compact');
    expect(queuedIn(SESSION_ID)).toEqual(['run the tests', 'second']);
  });

  /**
   * A store-backed composer plus a funnel whose command settles ASYNCHRONOUSLY
   * — the shape of the runtime-fulfilled `/compact` intent, which is a
   * trigger-only 202 that can still come back `SESSION_LOCKED`.
   */
  function useAsyncCommandHarness(confirmed: Promise<boolean>) {
    const { input } = useSessionChatState(SESSION_ID);
    const setInput = useCallback(
      (value: string) => useSessionChatStore.getState().updateSession(SESSION_ID, { input: value }),
      []
    );
    const chatInputRef = useRef<ComposerInputHandle | null>(null);
    const queue = useChatQueue({
      input,
      setInput,
      status: 'streaming',
      sessionBusy: false,
      sessionId: SESSION_ID,
      selectedCwd: '/dir',
      onFlush: vi.fn(),
      tryNativeCommand: (content: string) =>
        content.startsWith('/') ? { handled: true, ran: true, confirmed } : { handled: false },
      chatInputRef,
    });
    return { input, setInput, ...queue };
  }

  describe('a command whose dispatch has not landed yet', () => {
    it('keeps the /compact instructions when the trigger is refused', async () => {
      // `ran: true` only means the dispatch started. Clearing on that alone
      // deleted `/compact focus on the API changes` and then toasted "the agent
      // is busy — try compacting again in a moment", with nothing to try.
      const { result } = renderHook(() => useAsyncCommandHarness(Promise.resolve(false)));

      act(() => result.current.setInput('/compact focus on the API changes'));
      act(() => result.current.handleQueue());
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.input).toBe('/compact focus on the API changes');
      expect(queuedIn(SESSION_ID)).toEqual([]);
    });

    it('clears the composer once the dispatch is confirmed', async () => {
      const { result } = renderHook(() => useAsyncCommandHarness(Promise.resolve(true)));

      act(() => result.current.setInput('/compact focus on the API changes'));
      act(() => result.current.handleQueue());
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.input).toBe('');
    });

    it('does not wipe something typed while the dispatch was still in flight', async () => {
      let settle: (accepted: boolean) => void = () => {};
      const confirmed = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const { result } = renderHook(() => useAsyncCommandHarness(confirmed));

      act(() => result.current.setInput('/compact'));
      act(() => result.current.handleQueue());
      act(() => result.current.setInput('a whole new thought'));

      await act(async () => {
        settle(true);
        await confirmed;
      });

      expect(result.current.input).toBe('a whole new thought');
    });
  });
});
