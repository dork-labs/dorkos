/**
 * What a driving verb does before, during and after the one round trip it gets.
 *
 * The three cases that never mint a request are the interesting half: nothing
 * open, a named page nobody holds, and a page that is open but carries no shim.
 * Each is answered in a sentence that tells the agent what to do next, and each
 * is answered AT ONCE — asserted on the clock, not on the text, because a
 * sentence that arrives eight seconds late is the behaviour this replaced.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { DevtoolsActionResult } from '@dorkos/shared/schemas';
import { DevtoolsCaptureStore } from '../../devtools-capture-store.js';
import { createBrowserSeatHandlers } from '../handlers.js';
import { NO_DRIVER_NOTE, NO_PREVIEW_NOTE, NOT_INSTRUMENTED_NOTE } from '../act-protocol.js';

/** The live session's event queue, and a way to read what was pushed. */
function makeSession() {
  const eventQueue: StreamEvent[] = [];
  const notify = vi.fn();
  return { session: { eventQueue, eventQueueNotify: notify }, eventQueue, notify };
}

/** A store with one window holding one instrumented page. */
function storeWithDriver(
  sessionId = 's1',
  clientId = 'client-a',
  documentId = 'doc-a',
  instrumented = true
): DevtoolsCaptureStore {
  const store = new DevtoolsCaptureStore();
  store.ingest(
    sessionId,
    { documentId, seq: 1, console: [], network: [], active: true, instrumented },
    clientId
  );
  return store;
}

/** The action request the handlers pushed, typed for reading. */
function pushedRequest(eventQueue: StreamEvent[]) {
  const event = eventQueue.at(-1) as unknown as {
    type: string;
    data: { requestId: string; targetClientId: string; documentId: string; command: unknown };
  };
  return event;
}

describe('a driving verb addresses exactly one window', () => {
  it('stamps the seat holder and its page onto the request', async () => {
    const store = storeWithDriver();
    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: true, instrumented: true },
      'client-b'
    );
    const { session, eventQueue, notify } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      50
    );

    const answer = handlers.click({ role: 'button', name: 'Pay' });
    // The request is minted synchronously; the await is only the wait for a
    // result that never comes in this case.
    const request = pushedRequest(eventQueue);
    expect(request.type).toBe('devtools_action_request');
    expect(request.data.targetClientId).toBe('client-b');
    expect(request.data.documentId).toBe('doc-b');
    expect(request.data.command).toMatchObject({
      action: 'click',
      target: { role: 'button', name: 'Pay' },
    });
    expect(notify).toHaveBeenCalled();
    await answer;
  });

  it('addresses a named page to the window holding it, even when another holds the seat', async () => {
    const store = storeWithDriver();
    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: true, instrumented: true },
      'client-b'
    );
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      50
    );

    const answer = handlers.readPage({ documentId: 'doc-a' });
    expect(pushedRequest(eventQueue).data.targetClientId).toBe('client-a');
    await answer;
  });

  it('reports the document it acted in on every answer', async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      1_000
    );

    const answer = handlers.click({ selector: '#pay' });
    const result: DevtoolsActionResult = {
      requestId: pushedRequest(eventQueue).data.requestId,
      ok: true,
      did: 'Clicked button "Pay $42.00".',
      matched: 1,
      page: { title: 'Checkout', url: 'https://preview/checkout', focused: 'button "Pay $42.00"' },
    };
    store.resolveAction(result);

    expect((await answer).payload).toMatchObject({
      ok: true,
      documentId: 'doc-a',
      did: 'Clicked button "Pay $42.00".',
      matched: 1,
      page: { title: 'Checkout' },
    });
  });
});

describe('the three answers that never mint a request', () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run a handler and report how much fake time it actually spent. */
  async function elapsed(run: () => Promise<unknown>): Promise<number> {
    const started = Date.now();
    // Let every pending timer fire, so a handler that WAS waiting on one shows
    // its whole wait rather than appearing instant because nothing advanced.
    const finished = run();
    await vi.runAllTimersAsync();
    await finished;
    now = Date.now() - started;
    return now;
  }

  it('says nothing is open, at once, when no preview ever captured', async () => {
    const store = new DevtoolsCaptureStore();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.click({ selector: '#pay' });
    });

    expect(answer!.payload.note).toBe(NO_PREVIEW_NOTE);
    expect(spent).toBe(0);
    expect(eventQueue).toHaveLength(0);
  });

  it('says no window is showing a preview, at once, when every claim was released', async () => {
    const store = storeWithDriver();
    store.ingest(
      's1',
      { documentId: 'doc-a', seq: 2, console: [], network: [], active: false },
      'client-a'
    );
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.press({ key: 'Enter' });
    });

    expect(answer!.payload.note).toBe(NO_DRIVER_NOTE);
    expect(spent).toBe(0);
    expect(eventQueue).toHaveLength(0);
  });

  it('says a page that is open but not instrumented cannot be driven, at once', async () => {
    // The case that mattered most: today this waited out the whole timeout and
    // then said something misleading about opening a preview that IS open.
    const store = storeWithDriver('s1', 'client-a', 'doc-external', false);
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.readPage({});
    });

    expect(answer!.payload.note).toBe(NOT_INSTRUMENTED_NOTE);
    expect(answer!.payload.documentId).toBe('doc-external');
    expect(spent).toBe(0);
    expect(eventQueue).toHaveLength(0);
  });

  it('names the fix when a page id nobody holds is passed', async () => {
    const store = storeWithDriver();
    const { session } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.click({ selector: '#pay', documentId: 'doc-closed' });
    });

    expect(answer!.payload.note).toContain('No window has that page open any more');
    expect(spent).toBe(0);
  });

  it('waits out the timeout only when the page was genuinely asked', async () => {
    // The contrast that makes the three assertions above mean something: the
    // clock DOES move when a request was minted and nothing answered.
    const store = storeWithDriver();
    const { session } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      8_000
    );

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.click({ selector: '#pay' });
    });

    expect(spent).toBe(8_000);
    expect(answer!.payload.note).toContain('browser_click waited 8s');
  });
});

describe('refusals decided before anything is minted', () => {
  it('refuses two ways of naming the same element', async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    const answer = await handlers.click({ role: 'button', name: 'Pay', selector: '#pay' });
    expect(answer.payload.note).toContain('Name the element one way');
    expect(eventQueue).toHaveLength(0);
  });

  it('refuses a role with no name beside it, and says what to do', async () => {
    const store = storeWithDriver();
    const { session } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    const answer = await handlers.click({ role: 'button' });
    expect(answer.payload.note).toContain('A role needs the name beside it');
  });

  it('refuses a click that names nothing at all', async () => {
    const store = storeWithDriver();
    const { session } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    const answer = await handlers.click({});
    expect(answer.payload.note).toContain('Name the element one way');
  });

  it("reads browser_type's `text` as what to type, never as a way to name the field", async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      50
    );

    // Naming nothing means "the focused field" — and `text` must not sneak in
    // as a visible-text target, which would send a command naming an element by
    // the very string being typed into it.
    const answer = handlers.type({ text: 'hello' });
    expect(pushedRequest(eventQueue).data.command).toEqual({ action: 'type', text: 'hello' });
    await answer;
  });

  it('names the field by role and name on browser_type, and keeps the typed text out of it', async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      50
    );

    const answer = handlers.type({ role: 'textbox', name: 'Card number', text: '4242' });
    expect(pushedRequest(eventQueue).data.command).toEqual({
      action: 'type',
      target: { role: 'textbox', name: 'Card number' },
      text: '4242',
    });
    await answer;
  });

  it('refuses a scroll that says neither where nor how far', async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    const answer = await handlers.scroll({});
    expect(answer.payload.note).toContain('Say where to scroll');
    expect(eventQueue).toHaveLength(0);
  });

  it('refuses a wait that names no condition, and one that names two', async () => {
    const store = storeWithDriver();
    const { session } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    expect((await handlers.waitFor({})).payload.note).toContain('Say what to wait for');
    expect((await handlers.waitFor({ text: 'Done', fetchIdle: true })).payload.note).toContain(
      'Say what to wait for'
    );
  });
});

describe('bounds every driving verb carries', () => {
  it('caps a wait at ten seconds however long the caller asked for', async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });

    const answer = handlers.waitFor({ text: 'Done', timeoutMs: 60_000 });
    expect(pushedRequest(eventQueue).data.command).toMatchObject({ timeoutMs: 10_000 });
    store.resolveAction({
      requestId: pushedRequest(eventQueue).data.requestId,
      ok: true,
      waitedMs: 12,
    });
    await answer;
  });

  it('gives a wait more server-side patience than the wait it asked for', async () => {
    // A server timeout at or below the page's own wait would report a failure
    // while the page was still doing exactly what it was told.
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers({ resolveSessionId: () => 's1', store, session });
    vi.useFakeTimers();

    let answer: { payload: Record<string, unknown> } | undefined;
    const running = handlers.waitFor({ text: 'Done', timeoutMs: 10_000 }).then((value) => {
      answer = value;
    });
    expect(pushedRequest(eventQueue).data.command).toMatchObject({ timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_500);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await running;
    expect(answer!.payload.note).toContain('browser_wait_for waited 12s');
    vi.useRealTimers();
  });

  it('answers a session-less surface with an error rather than a fake success', async () => {
    const store = storeWithDriver();
    const { session } = makeSession();
    const handlers = createBrowserSeatHandlers({
      resolveSessionId: () => undefined,
      store,
      session,
    });

    const answer = await handlers.click({ selector: '#pay' });
    expect(answer.isError).toBe(true);
    expect(answer.payload.error).toContain('attached interactive session');
  });

  it('passes a page failure through as the page worded it, with what it matched', async () => {
    const store = storeWithDriver();
    const { session, eventQueue } = makeSession();
    const handlers = createBrowserSeatHandlers(
      { resolveSessionId: () => 's1', store, session },
      1_000
    );

    const answer = handlers.click({ text: 'Delete' });
    store.resolveAction({
      requestId: pushedRequest(eventQueue).data.requestId,
      ok: false,
      matched: 4,
      error: '4 things matched the text "Delete". Pass nth to pick one, or name it more exactly.',
    });

    expect((await answer).payload).toMatchObject({
      ok: false,
      matched: 4,
      documentId: 'doc-a',
      note: '4 things matched the text "Delete". Pass nth to pick one, or name it more exactly.',
    });
  });
});
