// @vitest-environment jsdom
/**
 * `useChatQueue` — the QueuePanel ↔ server-queue boundary.
 *
 * The card callbacks address a queue item by its stable id, never by position:
 * the server dispatches the head while the panel is on screen, and a second
 * window can reorder or remove a row under it, so an index captured at render
 * time can point at the neighbouring message by the time the click lands. These
 * tests pin the id contract and the draft bookkeeping that rides on it, driven
 * against a fake that plays the server's part (`fake-server-queue`).
 *
 * Migrated from the local-FIFO era (task 2.6). What went with the FIFO: the
 * `sendBlockedReason` cases — the server dispatches, so "why can Send-now not
 * happen" collapsed into "this message is already next", which the panel answers
 * by not drawing the control at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCallback, useRef, type ReactNode } from 'react';
import { useChatQueue } from '../model/use-chat-queue';
import { useFakeServerQueue } from './fake-server-queue';
import {
  useSessionChatState,
  useSessionChatStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import type { ComposerInputHandle } from '@/layers/features/composer';

const SESSION_ID = 'session-1';

/** The transport the tree renders under; assigned by {@link mount} before each render. */
let sharedTransport: Transport | null = null;

function wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={sharedTransport!}>{children}</TransportProvider>;
}

type Server = ReturnType<typeof useFakeServerQueue>;

/**
 * Render a harness over a fake server queue.
 *
 * The fake is built in its own render pass so its transport exists before the
 * provider that has to hand it down; `sync` re-renders both passes after the
 * server changed underneath them, standing in for the `queue_update` that
 * re-renders the real cockpit.
 */
function mount<P extends object, T>(
  useBody: (server: Server, props: P) => T,
  initialProps: P,
  sessionIdOf: (props: P) => string = () => SESSION_ID
) {
  const probe = renderHook(
    ({ props }: { props: P }) => useFakeServerQueue('window-a', sessionIdOf(props)),
    {
      initialProps: { props: initialProps },
    }
  );
  sharedTransport = probe.result.current.transport;
  const view = renderHook(({ props }: { props: P }) => useBody(probe.result.current, props), {
    wrapper,
    initialProps: { props: initialProps },
  });
  const sync = () => {
    probe.rerender({ props: lastProps });
    view.rerender({ props: lastProps });
  };
  let lastProps = initialProps;
  const rerender = (props: P) => {
    lastProps = props;
    probe.rerender({ props });
    view.rerender({ props });
  };
  return { server: probe.result, result: view.result, rerender, sync };
}

/**
 * Drives the hook against the default session — the common case, on the same
 * store-backed composer everything else uses.
 */
function useHarness(server: Server) {
  return useStoreBackedHarness(server, { sessionId: SESSION_ID });
}

/**
 * Drives the hook with STORE-BACKED composer state — the shape that actually
 * ships. `input` is per-session state in the chat store, which is the whole
 * reason a session switch mid-edit could leave one session's composer holding
 * another value than the operator left there, and the reason the composer's
 * clear settles against the store rather than against a local setter.
 */
function useStoreBackedHarness(
  server: Server,
  { sessionId, selectedCwd = '/dir' }: { sessionId: string; selectedCwd?: string }
) {
  const { input } = useSessionChatState(sessionId);
  const setInput = useCallback(
    (value: string) => useSessionChatStore.getState().updateSession(sessionId, { input: value }),
    [sessionId]
  );
  const chatInputRef = useRef<ComposerInputHandle | null>(null);
  const queue = useChatQueue({
    input,
    setInput,
    sessionId,
    selectedCwd,
    waiting: server.waiting,
    onEnqueue: server.enqueue,
    tryNativeCommand: () => ({ handled: false }),
    chatInputRef,
  });
  return { input, setInput, ...queue };
}

/** The queued contents of a session, read out of the projection the server drives. */
function queuedIn(sessionId: string): string[] {
  return useSessionStreamStore
    .getState()
    .getSession(sessionId)
    .queuedMessages.map((m) => m.content);
}

/** Settle every round trip the last action started, then re-render both passes. */
async function settle(view: { sync: () => void }) {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  view.sync();
}

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

/** Type `text` and press the queue key, waiting for the server to take it. */
async function queueText(
  view: {
    result: { current: { setInput: (v: string) => void; handleQueue: () => void } };
    sync: () => void;
  },
  text: string
) {
  act(() => view.result.current.setInput(text));
  act(() => view.result.current.handleQueue());
  await settle(view);
}

describe('useChatQueue', () => {
  it('queues the composer text and clears the composer', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'follow-up');

    expect(view.result.current.queue.map((item) => item.content)).toEqual(['follow-up']);
    expect(view.result.current.input).toBe('');
  });

  it('keeps the words in the composer when the server refuses them (DOR-480)', async () => {
    // The whole of "nothing typed is ever lost" now: the composer is not
    // emptied until the server confirms it has the message, so a refusal needs
    // no undo — there is nothing to put back.
    const view = mount(useHarness, {});
    act(() => view.server.current.failNextEnqueue());

    await queueText(view, 'do not lose me');

    expect(view.result.current.input).toBe('do not lose me');
    expect(queuedIn(SESSION_ID)).toEqual([]);
  });

  it('a second Enter during the round trip does not queue the same words twice', async () => {
    // The composer holds the text until the server confirms (DOR-480), so for
    // one round trip an impatient second Enter still finds the message in the
    // box. The old local queue cleared synchronously and could not do this; the
    // server-backed one has to say no itself.
    const view = mount(useHarness, {});

    act(() => view.result.current.setInput('only once please'));
    act(() => {
      view.result.current.handleQueue();
      view.result.current.handleQueue();
    });
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['only once please']);
    expect(view.result.current.input).toBe('');
  });

  it('still queues a DIFFERENT message typed while the first is in flight', async () => {
    // The guard is keyed by the words in flight, not by "an enqueue is open" —
    // typing the next message straight after the last is the normal way to line
    // three of them up, and refusing that would be worse than the bug.
    const view = mount(useHarness, {});

    act(() => view.result.current.setInput('first message'));
    act(() => view.result.current.handleQueue());
    act(() => view.result.current.setInput('second message'));
    act(() => view.result.current.handleQueue());
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['first message', 'second message']);
  });

  it('lets the same words be queued again once the first has landed', async () => {
    // The latch is for one round trip, not forever: "ok" twice in a row is a
    // thing people type.
    const view = mount(useHarness, {});

    await queueText(view, 'ok');
    await queueText(view, 'ok');

    expect(queuedIn(SESSION_ID)).toEqual(['ok', 'ok']);
  });

  it('editing by id loads the item and parks the draft; cancelling restores it', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'queued text');
    act(() => view.result.current.setInput('half-written thought'));

    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    expect(view.result.current.input).toBe('queued text');
    expect(view.result.current.editingIndex).toBe(0);

    act(() => view.result.current.handleQueueCancelEdit());
    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
  });

  it('saving an edit writes the item and restores the draft', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'queued text');
    act(() => view.result.current.setInput('half-written thought'));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    act(() => view.result.current.setInput('revised text'));

    act(() => view.result.current.handleQueueSaveEdit());
    await settle(view);

    expect(view.result.current.queue.map((item) => item.content)).toEqual(['revised text']);
    expect(view.result.current.input).toBe('half-written thought');
  });

  it('editing an id that is no longer queued leaves the composer untouched', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'queued text');
    act(() => view.result.current.setInput('half-written thought'));

    // The item dispatched between render and click.
    act(() => view.result.current.handleQueueEdit('already-dispatched'));

    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
  });

  it('removing the item under edit restores the draft; removing another does not', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'first');
    await queueText(view, 'second');
    act(() => view.result.current.setInput('half-written thought'));

    const [first, second] = view.result.current.queue;
    act(() => view.result.current.handleQueueEdit(second!.id));
    expect(view.result.current.input).toBe('second');

    // Removing a different card must not disturb the edit in progress.
    act(() => view.result.current.handleQueueRemove(first!.id));
    await settle(view);
    expect(view.result.current.input).toBe('second');
    expect(view.result.current.editingIndex).toBe(0);

    // Removing the card being edited hands the draft back.
    act(() => view.result.current.handleQueueRemove(second!.id));
    await settle(view);
    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
    expect(view.result.current.queue).toHaveLength(0);
  });

  it('arrow navigation walks the queue by position and hands the draft back at the end', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'first');
    await queueText(view, 'second');
    act(() => view.result.current.setInput('half-written thought'));

    act(() => view.result.current.handleQueueNavigateUp());
    expect(view.result.current.input).toBe('second');

    act(() => view.result.current.handleQueueNavigateUp());
    expect(view.result.current.input).toBe('first');

    act(() => view.result.current.handleQueueNavigateDown());
    expect(view.result.current.input).toBe('second');

    act(() => view.result.current.handleQueueNavigateDown());
    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
  });

  it('arrow navigation on an empty queue is inert', () => {
    const view = mount(useHarness, {});

    act(() => view.result.current.setInput('half-written thought'));
    act(() => view.result.current.handleQueueNavigateUp());

    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
  });
});

describe('useChatQueue — leaving an edit keeps the rewrite (DOR-480)', () => {
  /** Queues two messages, parks a draft, then opens the second one for editing. */
  async function editSecondOfTwo() {
    const view = mount(useHarness, {});

    await queueText(view, 'first');
    await queueText(view, 'second');
    act(() => view.result.current.setInput('half-written thought'));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[1]!.id));
    expect(view.result.current.input).toBe('second');

    // The operator rewrites it but does not press Enter.
    act(() => view.result.current.setInput('second, revised'));
    return view;
  }

  it('keeps the rewrite when ArrowUp moves to the row above', async () => {
    const view = await editSecondOfTwo();

    act(() => view.result.current.handleQueueNavigateUp());
    await settle(view);

    // The rewrite landed in the queue; the composer now shows the row above.
    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second, revised']);
    expect(view.result.current.input).toBe('first');
  });

  it('keeps the rewrite when ArrowDown leaves the queue past the end', async () => {
    const view = await editSecondOfTwo();

    act(() => view.result.current.handleQueueNavigateDown());
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second, revised']);
    // …and the parked draft comes back, exactly as before.
    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
  });

  it('keeps the rewrite when another row is clicked', async () => {
    const view = await editSecondOfTwo();

    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second, revised']);
    expect(view.result.current.input).toBe('first');
  });

  it('re-clicking the row under edit does not overwrite the rewrite', async () => {
    const view = await editSecondOfTwo();

    act(() => view.result.current.handleQueueEdit(view.result.current.queue[1]!.id));

    // Reloading the stored text here would silently discard what was typed.
    expect(view.result.current.input).toBe('second, revised');
    expect(view.result.current.editingIndex).toBe(1);
  });

  it('an emptied composer is not a delete — the item keeps its content', async () => {
    const view = await editSecondOfTwo();

    act(() => view.result.current.setInput(''));
    act(() => view.result.current.handleQueueNavigateUp());
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second']);
  });

  it('Escape still discards the edit (deliberate — that is what Escape is for)', async () => {
    const view = await editSecondOfTwo();

    act(() => view.result.current.handleQueueCancelEdit());
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['first', 'second']);
    expect(view.result.current.input).toBe('half-written thought');
  });
});

describe('useChatQueue — send next', () => {
  it('sends the row under edit as the REWRITE, and hands the draft back', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'first');
    await queueText(view, 'run the migration');
    act(() => view.result.current.setInput('half-written thought'));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[1]!.id));
    act(() => view.result.current.setInput('run the migration on staging first'));

    act(() => view.result.current.handleQueueSend(view.result.current.queue[1]!.id));
    await settle(view);

    // The rewrite went in front, rewritten — not the text the row used to hold.
    expect(queuedIn(SESSION_ID)).toEqual(['run the migration on staging first', 'first']);
    expect(view.result.current.input).toBe('half-written thought');
    expect(view.result.current.editingIndex).toBeNull();
  });

  it('moving a row earlier reorders the line without touching the composer', async () => {
    const view = mount(useHarness, {});

    await queueText(view, 'a');
    await queueText(view, 'b');
    await queueText(view, 'c');

    act(() => view.result.current.handleQueueMoveUp(view.result.current.queue[2]!.id));
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['a', 'c', 'b']);
    expect(view.result.current.input).toBe('');
  });
});

describe('useChatQueue — switching sessions mid-edit (DOR-480 duplicate send)', () => {
  /**
   * The bug: the editing cursor is component state, the composer text is
   * per-session store state. Switching away reset the cursor but left the
   * queued item's body sitting in the outgoing session's composer, where it
   * looked like an ordinary draft — so coming back and pressing Enter sent a
   * duplicate of a message that was still queued and would run anyway.
   */
  async function openSessionAWithEditInFlight() {
    const view = mount(useStoreBackedHarness, { sessionId: 'A' }, (p) => p.sessionId);

    await queueText(view, 'deploy to staging');
    act(() => view.result.current.setInput('wait, also '));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    expect(view.result.current.input).toBe('deploy to staging');

    return view;
  }

  it("leaves A's composer holding A's draft, not A's queued message", async () => {
    const view = await openSessionAWithEditInFlight();

    view.rerender({ sessionId: 'B' });
    await settle(view);
    view.rerender({ sessionId: 'A' });

    // The queued message is STILL queued (the server will run it)…
    expect(queuedIn('A')).toEqual(['deploy to staging']);
    // …so the composer must not also hold it, or Enter sends it twice.
    expect(view.result.current.input).toBe('wait, also ');
    expect(view.result.current.editingIndex).toBeNull();
  });

  it("commits an in-flight rewrite into A's queue on the way out", async () => {
    const view = await openSessionAWithEditInFlight();

    act(() => view.result.current.setInput('deploy to production instead'));
    view.rerender({ sessionId: 'B' });
    await settle(view);

    expect(queuedIn('A')).toEqual(['deploy to production instead']);
    // B's own composer is untouched by A's handoff.
    expect(view.result.current.input).toBe('');

    view.rerender({ sessionId: 'A' });
    expect(view.result.current.input).toBe('wait, also ');
    expect(queuedIn('A')).toEqual(['deploy to production instead']);
  });

  it('a cwd-only change gets the same handoff — the cursor resets on that too', async () => {
    // The editing cursor is scoped to (sessionId, cwd). Keying the handoff on
    // sessionId alone left the identical duplicate-send shape behind a cwd
    // change: cursor gone, item still queued, its body still in the composer.
    const view = mount(
      useStoreBackedHarness,
      { sessionId: 'A', selectedCwd: '/one' },
      (p) => p.sessionId
    );

    await queueText(view, 'deploy to staging');
    act(() => view.result.current.setInput('wait, also '));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    expect(view.result.current.input).toBe('deploy to staging');

    view.rerender({ sessionId: 'A', selectedCwd: '/two' });
    await settle(view);

    expect(view.result.current.editingIndex).toBeNull();
    expect(queuedIn('A')).toEqual(['deploy to staging']);
    expect(view.result.current.input).toBe('wait, also ');
  });
});

describe('useChatQueue — a refused send leaves the edit exactly as it was (DOR-480)', () => {
  it('does not swap the composer when the row is already next', async () => {
    // The head cannot go any further forward, so its Send-next is a no-op —
    // and a no-op must not swap the composer. Swapping in the parked draft here
    // would leave the cursor pointing at this row, and the next Enter routes to
    // onSaveEdit, writing the draft over the rewrite.
    const view = mount(useHarness, {});

    await queueText(view, 'run the migration');
    act(() => view.result.current.setInput('half-written thought'));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    act(() => view.result.current.setInput('run the migration on staging first'));

    act(() => view.result.current.handleQueueSend(view.result.current.queue[0]!.id));
    await settle(view);

    expect(view.result.current.input).toBe('run the migration on staging first');
    expect(view.result.current.editingIndex).toBe(0);
    expect(queuedIn(SESSION_ID)).toEqual(['run the migration on staging first']);
  });

  it('does not swap the composer when the row has already left the queue', async () => {
    // `sendNow` bails on a row it cannot find, which no disabled attribute
    // covers — the server can dispatch it between render and click.
    const view = mount(useHarness, {});

    await queueText(view, 'first');
    await queueText(view, 'run the migration');
    act(() => view.result.current.setInput('half-written thought'));
    const rowId = view.result.current.queue[1]!.id;
    act(() => view.result.current.handleQueueEdit(rowId));
    act(() => view.result.current.setInput('run the migration on staging first'));

    // It dispatches out from under the click — and takes the row with it.
    act(() => {
      view.server.current.dispatchHead();
      view.server.current.dispatchHead();
    });
    view.sync();
    act(() => view.result.current.handleQueueSend(rowId));
    await settle(view);

    expect(view.result.current.input).toBe('run the migration on staging first');
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
  function useCommandHarness(server: Server, { ran = true }: { ran?: boolean }) {
    const { input } = useSessionChatState(SESSION_ID);
    const setInput = useCallback(
      (value: string) => useSessionChatStore.getState().updateSession(SESSION_ID, { input: value }),
      []
    );
    const chatInputRef = useRef<ComposerInputHandle | null>(null);
    const queue = useChatQueue({
      input,
      setInput,
      sessionId: SESSION_ID,
      selectedCwd: '/dir',
      waiting: server.waiting,
      onEnqueue: server.enqueue,
      tryNativeCommand: (content: string) => {
        if (!content.startsWith('/')) return { handled: false };
        ranWith.push(content);
        return { handled: true, ran };
      },
      chatInputRef,
    });
    return { input, setInput, ...queue };
  }

  it('RUNS a command typed into the edit box instead of queueing it', async () => {
    // `handleQueue` runs the funnel at enqueue time; the edit paths did not, so
    // a rewrite could put one in the queue — where it would be dispatched as a
    // turn and mean something nobody asked for. Refusing was the first fix and
    // was a dead end (Escape lost the text, every correction was refused
    // again), so an edit that becomes a command now means what typing it fresh
    // means.
    const view = mount(useCommandHarness, { ran: true });

    await queueText(view, 'run the tests');
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    act(() => view.result.current.setInput('/rename my session'));

    act(() => view.result.current.handleQueueSaveEdit());
    await settle(view);

    expect(ranWith).toContain('/rename my session');
    // The row keeps what it had — a command is not a message — and the edit ends.
    expect(queuedIn(SESSION_ID)).toEqual(['run the tests']);
    expect(view.result.current.editingIndex).toBeNull();
    expect(view.result.current.input).toBe('');
  });

  it('keeps a REJECTED command in the composer so it can be fixed in place', async () => {
    // The recovery that did not exist under the refuse-based guard: the text
    // stays, the cursor stays, and a corrected form runs on the next Enter.
    const view = mount(useCommandHarness, { ran: false });

    await queueText(view, 'run the tests');
    act(() => view.result.current.setInput('half-written thought'));
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    act(() => view.result.current.setInput('/rename'));

    act(() => view.result.current.handleQueueSaveEdit());
    await settle(view);

    expect(view.result.current.input).toBe('/rename');
    expect(view.result.current.editingIndex).toBe(0);
    expect(queuedIn(SESSION_ID)).toEqual(['run the tests']);
  });

  it('still saves an edit the funnel does not claim', async () => {
    const view = mount(useCommandHarness, {});

    await queueText(view, 'run the tests');
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    act(() => view.result.current.setInput('explain what /rename does'));

    act(() => view.result.current.handleQueueSaveEdit());
    await settle(view);

    expect(queuedIn(SESSION_ID)).toEqual(['explain what /rename does']);
  });

  it('routes /compact to the funnel — the intent the client-native parser skips', async () => {
    // THE bug in the first guard: it gated on `parseNativeCommand`, which
    // deliberately does not match the runtime-fulfilled compact intent, so
    // `/compact` (and every alias) saved straight into the queue and was later
    // dispatched as a turn of its own.
    const view = mount(useCommandHarness, { ran: true });

    await queueText(view, 'run the tests');
    await queueText(view, 'second');
    act(() => view.result.current.handleQueueEdit(view.result.current.queue[0]!.id));
    act(() => view.result.current.setInput('/compact'));

    act(() => view.result.current.handleQueueSaveEdit());
    await settle(view);

    expect(ranWith).toContain('/compact');
    expect(queuedIn(SESSION_ID)).toEqual(['run the tests', 'second']);
  });

  /**
   * A store-backed composer plus a funnel whose command settles ASYNCHRONOUSLY
   * — the shape of the runtime-fulfilled `/compact` intent, which is a
   * trigger-only 202 that can still come back refused.
   */
  function useAsyncCommandHarness(server: Server, { confirmed }: { confirmed: Promise<boolean> }) {
    const { input } = useSessionChatState(SESSION_ID);
    const setInput = useCallback(
      (value: string) => useSessionChatStore.getState().updateSession(SESSION_ID, { input: value }),
      []
    );
    const chatInputRef = useRef<ComposerInputHandle | null>(null);
    const queue = useChatQueue({
      input,
      setInput,
      sessionId: SESSION_ID,
      selectedCwd: '/dir',
      waiting: server.waiting,
      onEnqueue: server.enqueue,
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
      const view = mount(useAsyncCommandHarness, { confirmed: Promise.resolve(false) });

      act(() => view.result.current.setInput('/compact focus on the API changes'));
      act(() => view.result.current.handleQueue());
      await settle(view);

      expect(view.result.current.input).toBe('/compact focus on the API changes');
      expect(queuedIn(SESSION_ID)).toEqual([]);
    });

    it('clears the composer once the dispatch is confirmed', async () => {
      const view = mount(useAsyncCommandHarness, { confirmed: Promise.resolve(true) });

      act(() => view.result.current.setInput('/compact focus on the API changes'));
      act(() => view.result.current.handleQueue());
      await settle(view);

      expect(view.result.current.input).toBe('');
    });

    it('does not wipe something typed while the dispatch was still in flight', async () => {
      let settleConfirmed: (accepted: boolean) => void = () => {};
      const confirmed = new Promise<boolean>((resolve) => {
        settleConfirmed = resolve;
      });
      const view = mount(useAsyncCommandHarness, { confirmed });

      act(() => view.result.current.setInput('/compact'));
      act(() => view.result.current.handleQueue());
      act(() => view.result.current.setInput('a whole new thought'));

      await act(async () => {
        settleConfirmed(true);
        await confirmed;
      });

      expect(view.result.current.input).toBe('a whole new thought');
    });
  });
});
