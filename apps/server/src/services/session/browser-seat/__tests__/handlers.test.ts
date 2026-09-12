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
import type { DevtoolsActionResult } from '@dorkos/shared/schemas';
import { DevtoolsCaptureStore } from '../../devtools-capture-store.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { createBrowserSeatHandlers } from '../handlers.js';
import { NO_DRIVER_NOTE, NO_PREVIEW_NOTE, NOT_INSTRUMENTED_NOTE } from '../act-protocol.js';

/**
 * A stand-in for the calling session's stream, and a way to read what reached
 * it.
 *
 * @param reached - Whether the session has a live stream. `false` is a session
 *   nobody has a window open on.
 */
function makeSink(reached = true) {
  const emitted: RawSessionEvent[] = [];
  const emit = (event: RawSessionEvent) => {
    if (reached) emitted.push(event);
    return reached;
  };
  return { emit, emitted };
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
function pushedRequest(emitted: RawSessionEvent[]) {
  return emitted.at(-1) as unknown as {
    type: string;
    requestId: string;
    targetClientId: string;
    documentId: string;
    command: unknown;
  };
}

describe('a driving verb addresses exactly one window', () => {
  it('stamps the seat holder and its page onto the request', async () => {
    const store = storeWithDriver();
    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: true, instrumented: true },
      'client-b'
    );
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 50);

    const answer = handlers.click({ role: 'button', name: 'Pay' });
    // The request is minted synchronously; the await is only the wait for a
    // result that never comes in this case.
    const request = pushedRequest(emitted);
    expect(request.type).toBe('devtools_action_request');
    expect(request.targetClientId).toBe('client-b');
    expect(request.documentId).toBe('doc-b');
    expect(request.command).toMatchObject({
      action: 'click',
      target: { role: 'button', name: 'Pay' },
    });
    await answer;
  });

  it('addresses a named page to the window holding it, even when another holds the seat', async () => {
    const store = storeWithDriver();
    store.ingest(
      's1',
      { documentId: 'doc-b', seq: 2, console: [], network: [], active: true, instrumented: true },
      'client-b'
    );
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 50);

    const answer = handlers.readPage({ documentId: 'doc-a' });
    expect(pushedRequest(emitted).targetClientId).toBe('client-a');
    await answer;
  });

  it('reports the document it acted in on every answer', async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 1_000);

    const answer = handlers.click({ selector: '#pay' });
    const result: DevtoolsActionResult = {
      requestId: pushedRequest(emitted).requestId,
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
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.click({ selector: '#pay' });
    });

    expect(answer!.payload.note).toBe(NO_PREVIEW_NOTE);
    expect(spent).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('says no window is showing a preview, at once, when every claim was released', async () => {
    const store = storeWithDriver();
    store.ingest(
      's1',
      { documentId: 'doc-a', seq: 2, console: [], network: [], active: false },
      'client-a'
    );
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.press({ key: 'Enter' });
    });

    expect(answer!.payload.note).toBe(NO_DRIVER_NOTE);
    expect(spent).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('says a page that is open but not instrumented cannot be driven, at once', async () => {
    // The case that mattered most: today this waited out the whole timeout and
    // then said something misleading about opening a preview that IS open.
    const store = storeWithDriver('s1', 'client-a', 'doc-external', false);
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.readPage({});
    });

    expect(answer!.payload.note).toBe(NOT_INSTRUMENTED_NOTE);
    expect(answer!.payload.documentId).toBe('doc-external');
    expect(spent).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('says so at once when a page STOPPED being instrumented', async () => {
    // The half a never-instrumented page does not cover. A frame outlives its
    // page: an instrumented preview that navigates to an external site is the
    // same window and the same tab, still holding the seat, and only its
    // re-reported claim says the shim is gone. Waiting out the timeout here
    // would be the exact eight-second pause this note exists to replace.
    const store = storeWithDriver('s1', 'client-a', 'doc-a', true);
    store.ingest(
      's1',
      { documentId: 'doc-a', seq: 2, console: [], network: [], active: true, instrumented: false },
      'client-a'
    );
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    let answer: { payload: Record<string, unknown> } | undefined;
    const spent = await elapsed(async () => {
      answer = await handlers.click({ selector: '#pay' });
    });

    expect(answer!.payload.note).toBe(NOT_INSTRUMENTED_NOTE);
    expect(answer!.payload.documentId).toBe('doc-a');
    expect(spent).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('names the fix when a page id nobody holds is passed', async () => {
    const store = storeWithDriver();
    const { emit } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

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
    const { emit } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 8_000);

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
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    const answer = await handlers.click({ role: 'button', name: 'Pay', selector: '#pay' });
    expect(answer.payload.note).toContain('Name the element one way');
    expect(emitted).toHaveLength(0);
  });

  it('refuses a role with no name beside it, and says what to do', async () => {
    const store = storeWithDriver();
    const { emit } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    const answer = await handlers.click({ role: 'button' });
    expect(answer.payload.note).toContain('A role needs the name beside it');
  });

  it('refuses a click that names nothing at all', async () => {
    const store = storeWithDriver();
    const { emit } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    const answer = await handlers.click({});
    expect(answer.payload.note).toContain('Name the element one way');
  });

  it("reads browser_type's `text` as what to type, never as a way to name the field", async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 50);

    // Naming nothing means "the focused field" — and `text` must not sneak in
    // as a visible-text target, which would send a command naming an element by
    // the very string being typed into it.
    const answer = handlers.type({ text: 'hello' });
    expect(pushedRequest(emitted).command).toEqual({ action: 'type', text: 'hello' });
    await answer;
  });

  it('names the field by role and name on browser_type, and keeps the typed text out of it', async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 50);

    const answer = handlers.type({ role: 'textbox', name: 'Card number', text: '4242' });
    expect(pushedRequest(emitted).command).toEqual({
      action: 'type',
      target: { role: 'textbox', name: 'Card number' },
      text: '4242',
    });
    await answer;
  });

  it('refuses a scroll that says neither where nor how far', async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    const answer = await handlers.scroll({});
    expect(answer.payload.note).toContain('Say where to scroll');
    expect(emitted).toHaveLength(0);
  });

  it('refuses a wait that names no condition, and one that names two', async () => {
    const store = storeWithDriver();
    const { emit } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    expect((await handlers.waitFor({})).payload.note).toContain('Say what to wait for');
    expect((await handlers.waitFor({ text: 'Done', fetchIdle: true })).payload.note).toContain(
      'Say what to wait for'
    );
  });
});

describe('bounds every driving verb carries', () => {
  it('caps a wait at ten seconds however long the caller asked for', async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    const answer = handlers.waitFor({ text: 'Done', timeoutMs: 60_000 });
    expect(pushedRequest(emitted).command).toMatchObject({ timeoutMs: 10_000 });
    store.resolveAction({
      requestId: pushedRequest(emitted).requestId,
      ok: true,
      waitedMs: 12,
    });
    await answer;
  });

  it('gives a wait more server-side patience than the wait it asked for', async () => {
    // A server timeout at or below the page's own wait would report a failure
    // while the page was still doing exactly what it was told.
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });
    vi.useFakeTimers();

    let answer: { payload: Record<string, unknown> } | undefined;
    const running = handlers.waitFor({ text: 'Done', timeoutMs: 10_000 }).then((value) => {
      answer = value;
    });
    expect(pushedRequest(emitted).command).toMatchObject({ timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_500);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await running;
    expect(answer!.payload.note).toContain('browser_wait_for waited 12s');
    vi.useRealTimers();
  });

  it('answers at once when the session has no live stream to reach', async () => {
    // A window claimed the seat and then the session stopped streaming. The
    // request has nowhere to go, so saying so beats waiting out the round-trip
    // timeout and then blaming the page.
    const store = storeWithDriver();
    const { emit } = makeSink(false);
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit });

    const answer = await handlers.click({ selector: '#pay' });
    expect(answer.payload.ok).toBe(false);
    expect(answer.payload.note).toBe(NO_DRIVER_NOTE);
  });

  it('names the tab on a REFUSAL too, which is where an agent learns the id', async () => {
    // In a one-on-one session this is the only place a tab id comes from:
    // `get_ui_state` returns `{ open, contentType }` with no list, and
    // `control_ui` answers `{ success, action }` because the client mints the id
    // there and the server never learns it. The notes that used to send an agent
    // to `get_ui_state` now send it here, so the id has to actually be here —
    // including when the answer is a refusal, which is exactly the moment an
    // agent is deciding what to pass next time.
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 1_000);

    const answer = handlers.click({ text: 'Delete' });
    store.resolveAction({
      requestId: pushedRequest(emitted).requestId,
      ok: false,
      matched: 4,
      error: '4 things matched the text "Delete". Pass nth to pick one, or name it more exactly.',
    });

    expect((await answer).payload.documentId).toBe('doc-a');
  });

  it('names the tab on every one of the six verbs, not just the ones with a target', async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 1_000);

    const calls: [string, Promise<{ payload: Record<string, unknown> }>][] = [
      ['browser_click', handlers.click({ selector: '#a' })],
      ['browser_type', handlers.type({ selector: '#a', text: 'x' })],
      ['browser_press', handlers.press({ key: 'Enter' })],
      ['browser_scroll', handlers.scroll({ by: 10 })],
      ['browser_wait_for', handlers.waitFor({ text: 'done' })],
      ['browser_read_page', handlers.readPage({})],
    ];
    // Answer each minted request in the order they were pushed.
    for (const event of emitted) {
      const request = event as unknown as { requestId: string };
      store.resolveAction({ requestId: request.requestId, ok: true, did: 'did it.' });
    }
    for (const [verb, pending] of calls) {
      expect((await pending).payload.documentId, `${verb} did not name the tab`).toBe('doc-a');
    }
  });

  it('passes a page failure through as the page worded it, with what it matched', async () => {
    const store = storeWithDriver();
    const { emit, emitted } = makeSink();
    const handlers = createBrowserSeatHandlers({ sessionId: 's1', store, emit }, 1_000);

    const answer = handlers.click({ text: 'Delete' });
    store.resolveAction({
      requestId: pushedRequest(emitted).requestId,
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
