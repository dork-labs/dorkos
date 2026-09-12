/**
 * The driver seat, asserted on the server — which is the only place it can be.
 *
 * `use-devtools-bridge.ts` used to say this out loud as a known limitation: the
 * hook mounts once per open browser document, the request carried no target, so
 * with several previews open EVERY bridge forwarded it and the first ingest won
 * nondeterministically. A client test could only ever prove that one window
 * behaves, which is exactly what was already true and already insufficient — so
 * the arbiter moved to the one place there is exactly one of, and this is where
 * it is checked.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DevtoolsCaptureStore } from '../devtools-capture-store.js';
import type { DevtoolsIngest } from '@dorkos/shared/schemas';

/**
 * An ingest batch carrying a seat claim the way a client OLDER than the
 * `activation` field sends it: no field at all, on a first claim and on its
 * 15 s beat alike.
 */
function claim(documentId: string, active: boolean, instrumented = true): DevtoolsIngest {
  return { documentId, seq: 1, console: [], network: [], active, instrumented };
}

/** What this bundle sends when a person brings a page to the front. */
function activate(documentId: string, instrumented = true): DevtoolsIngest {
  return { ...claim(documentId, true, instrumented), activation: true };
}

describe('one session, two windows, one driver seat', () => {
  let store: DevtoolsCaptureStore;

  beforeEach(() => {
    store = new DevtoolsCaptureStore();
  });

  it('gives the seat to the window that claimed most recently', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');

    const seat = store.resolveDriver('s1');
    expect(seat).toMatchObject({ clientId: 'client-b', documentId: 'doc-b' });
  });

  it('addresses a named document to the window that holds it, not to the seat', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');

    // `client-b` holds the seat, and the request names `client-a`'s page.
    expect(store.resolveDriver('s1', 'doc-a')).toMatchObject({
      clientId: 'client-a',
      documentId: 'doc-a',
    });
  });

  it('moves the seat back when the holder releases it, and then empties', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');

    store.ingest('s1', claim('doc-b', false), 'client-b');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });

    store.ingest('s1', claim('doc-a', false), 'client-a');
    expect(store.resolveDriver('s1')).toBeUndefined();
    expect(store.hasDrivers('s1')).toBe(false);
  });

  it('re-claiming the same page takes the seat back without duplicating the row', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');
    // An ACTIVATION, said out loud: a window re-reporting a page it is already
    // holding is a keep-alive unless it says otherwise, which is what stops a
    // beat from taking the seat.
    store.ingest('s1', activate('doc-a'), 'client-a');

    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
    // And releasing that one row leaves exactly the other window's claim, which
    // a duplicated row would not.
    store.ingest('s1', claim('doc-a', false), 'client-a');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });
  });

  it('answers nothing for a document nobody is holding, while others are', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    expect(store.resolveDriver('s1', 'doc-gone')).toBeUndefined();
    // And the caller can tell the two apart: something IS open, just not that.
    expect(store.hasDrivers('s1')).toBe(true);
  });

  it('carries whether the page was ever instrumented, so a silent frame is not waited on', () => {
    store.ingest('s1', claim('doc-external', true, false), 'client-a');
    expect(store.resolveDriver('s1')).toMatchObject({ instrumented: false });

    // The same window's later handshake upgrades the row rather than adding one.
    store.ingest('s1', claim('doc-external', true, true), 'client-a');
    expect(store.resolveDriver('s1')).toMatchObject({ instrumented: true });
  });

  it('never lets one session see another session claims', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    expect(store.resolveDriver('s2')).toBeUndefined();
    expect(store.hasDrivers('s2')).toBe(false);
  });

  it('keeps the table bounded, evicting the oldest claim', () => {
    for (let i = 0; i < 12; i++) store.ingest('s1', claim(`doc-${i}`, true), `client-${i}`);
    // The nine oldest are gone; the eight most recent survive.
    expect(store.resolveDriver('s1', 'doc-0')).toBeUndefined();
    expect(store.resolveDriver('s1', 'doc-11')).toMatchObject({ clientId: 'client-11' });
    expect(store.resolveDriver('s1', 'doc-4')).toMatchObject({ clientId: 'client-4' });
    expect(store.resolveDriver('s1', 'doc-3')).toBeUndefined();
  });

  it('never lets a window with no client id TAKE the seat', () => {
    // The direction that matters. A caller with no `X-Client-Id` used to be
    // given a per-request UUID, and a claim under that id is the most recent
    // one — so it took the seat from the window really showing the page, and
    // every verb afterwards addressed a client that does not exist and timed
    // out. It may still ingest captures; it may not claim.
    store.ingest('s1', claim('doc-a', true), 'window-a');
    store.ingest('s1', claim('doc-b', true));

    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'window-a' });
    expect(store.resolveDriver('s1', 'doc-b')).toBeUndefined();
  });

  it('never lets a window with no client id release somebody else seat', () => {
    store.ingest('s1', claim('doc-a', true), 'window-a');
    store.ingest('s1', claim('doc-a', false));
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'window-a' });
  });

  it('still ingests the captures of a window with no client id', () => {
    store.ingest('s1', {
      documentId: 'doc-a',
      seq: 1,
      console: [{ level: 'error', text: 'boom', timestamp: 1 }],
      network: [],
    });
    expect(store.read('s1')?.console).toHaveLength(1);
  });

  it('yields a seat whose window stopped reporting, to one that did not', () => {
    // A window that is killed, suspended or loses its network sends no release.
    // Without this the seat stays in the table forever and every verb addresses
    // a window that no longer answers — for the life of the session.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
      store.ingest('s1', claim('doc-a', true), 'window-a');

      // A second window claims, then keeps reporting while the first goes quiet.
      vi.setSystemTime(new Date('2026-09-12T00:00:05Z'));
      store.ingest('s1', claim('doc-b', true), 'window-b');
      vi.setSystemTime(new Date('2026-09-12T00:01:40Z'));
      store.ingest('s1', claim('doc-b', true), 'window-b');

      // `window-a` is 100s stale — past six missed 15s refreshes, which is the
      // floor chosen so a tab hidden behind another (one timer wake per minute)
      // cannot lose a seat it is still holding.
      expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'window-b' });
      expect(store.resolveDriver('s1', 'doc-a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no driver at all once every window has gone quiet', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
      store.ingest('s1', claim('doc-a', true), 'window-a');
      expect(store.hasDrivers('s1')).toBe(true);

      // A minute in, a hidden tab's slowest possible beat has not been missed
      // six times over, so the seat is still its own.
      vi.setSystemTime(new Date('2026-09-12T00:01:00Z'));
      expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'window-a' });

      vi.setSystemTime(new Date('2026-09-12T00:02:00Z'));
      expect(store.resolveDriver('s1')).toBeUndefined();
      // And `hasDrivers` agrees, so the tool says "nothing is open" rather than
      // "no window has THAT page" — two different things to do next.
      expect(store.hasDrivers('s1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a seat alive as long as its window keeps reporting', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
      store.ingest('s1', claim('doc-a', true), 'window-a');
      for (let beat = 1; beat <= 10; beat++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 8, 12, 0, 0, beat * 15)));
        store.ingest('s1', claim('doc-a', true), 'window-a');
        expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'window-a' });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the whole table across a first-turn canonical rekey', () => {
    store.ingest('trigger-uuid', claim('doc-a', true), 'client-a');
    store.rekeySession('trigger-uuid', 'canonical-sdk-id');

    expect(store.resolveDriver('canonical-sdk-id')).toMatchObject({ clientId: 'client-a' });
    expect(store.hasDrivers('trigger-uuid')).toBe(false);
  });
});

describe('awaiting one driving round trip', () => {
  let store: DevtoolsCaptureStore;

  beforeEach(() => {
    store = new DevtoolsCaptureStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the result the addressed window posted', async () => {
    const pending = store.awaitAction('req-1', 1_000);
    store.resolveAction({ requestId: 'req-1', ok: true, did: 'Clicked button "Pay".' });
    await expect(pending).resolves.toMatchObject({ ok: true, did: 'Clicked button "Pay".' });
  });

  it('resolves undefined at the timeout rather than hanging', async () => {
    vi.useFakeTimers();
    const pending = store.awaitAction('req-2', 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it('still resolves when the session was rekeyed between the request and the answer', async () => {
    store.ingest('trigger-uuid', claim('doc-a', true), 'client-a');
    const pending = store.awaitAction('req-3', 1_000);
    store.rekeySession('trigger-uuid', 'canonical-sdk-id');
    // Keyed by requestId ALONE, so the move cannot strand the awaiting tool.
    store.resolveAction({ requestId: 'req-3', ok: true, did: 'Read the page outline.' });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('drops a result nobody is awaiting instead of throwing', () => {
    expect(() => store.resolveAction({ requestId: 'nobody-waits', ok: true })).not.toThrow();
  });

  it('delivers a result to exactly one waiter and then forgets it', async () => {
    const pending = store.awaitAction('req-4', 1_000);
    store.resolveAction({ requestId: 'req-4', ok: true, did: 'first' });
    await expect(pending).resolves.toMatchObject({ did: 'first' });
    // A second result under the same id has nothing to deliver to.
    expect(() =>
      store.resolveAction({ requestId: 'req-4', ok: true, did: 'second' })
    ).not.toThrow();
  });
});

describe('a keep-alive is not a claim', () => {
  let store: DevtoolsCaptureStore;

  beforeEach(() => {
    store = new DevtoolsCaptureStore();
  });

  /** The 15 s beat: same window, same page, nothing changed. */
  function beat(documentId: string): DevtoolsIngest {
    return {
      documentId,
      seq: 1,
      console: [],
      network: [],
      active: true,
      activation: false,
      instrumented: true,
    };
  }

  it('leaves the seat where it is however long two windows both beat', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });

    // THE defect this closes. Every mounted preview re-reports every 15 s, so
    // with the app open in two windows the seat used to alternate on every beat
    // — and a recording pinned to one window missed every action dispatched to
    // the other while still answering `ok`. Six beats is a minute and a half of
    // two windows sitting there, which is the ordinary case, not an edge one.
    for (let round = 0; round < 6; round += 1) {
      store.ingest('s1', beat('doc-a'), 'client-a');
      expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });
      store.ingest('s1', beat('doc-b'), 'client-b');
      expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });
    }
  });

  it('still moves the seat when the other window really activates a page', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');
    store.ingest('s1', beat('doc-a'), 'client-a');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });

    // A person brought window A's preview to the front: focus, a tab click, a
    // page that just handshook. That is what the seat is FOR.
    store.ingest('s1', activate('doc-a'), 'client-a');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
  });

  it('hands the seat over when its holder releases, even with beats in between', () => {
    store.ingest('s1', claim('doc-a', true), 'client-a');
    store.ingest('s1', claim('doc-b', true), 'client-b');
    store.ingest('s1', beat('doc-a'), 'client-a');

    store.ingest('s1', claim('doc-b', false), 'client-b');

    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
  });

  it('hands the seat over when its holder goes stale, even while the other beats', () => {
    vi.useFakeTimers();
    try {
      store.ingest('s1', claim('doc-a', true), 'client-a');
      store.ingest('s1', claim('doc-b', true), 'client-b');

      // B holds the seat and then stops answering; A keeps beating. Past the
      // stale floor the seat has to fall to A, or every verb addresses a window
      // that is gone for the life of the session.
      for (let round = 0; round < 7; round += 1) {
        vi.advanceTimersByTime(15_000);
        store.ingest('s1', beat('doc-a'), 'client-a');
      }

      expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a FIRST claim with no `activation` field as an activation', () => {
    // A client that predates the field is still heard the first time it speaks:
    // a window nobody has heard from takes the seat whether or not it can name
    // what it is doing, which is what every claim meant before the field.
    store.ingest('s1', claim('doc-a', true), 'client-a');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
    store.ingest('s1', claim('doc-b', true), 'client-b');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });
  });

  it('leaves the seat with the window a person activated while an old tab beats', () => {
    // A tab open across the upgrade sends the pre-field body every 15 s, so its
    // beat is indistinguishable from its activation. Reading absent as "a person
    // put this in front" gave the seat to the window nobody is looking at, on
    // every beat, for as long as that tab stayed open: the person drives one
    // window and the actions land in the other.
    store.ingest('s1', claim('doc-old', true), 'client-old');
    store.ingest('s1', activate('doc-new'), 'client-new');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-new' });

    for (let round = 0; round < 4; round += 1) {
      store.ingest('s1', claim('doc-old', true), 'client-old');
      expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-new' });
    }
  });

  it('answers a NAMED page from the seat, not from the end of the table', () => {
    // Canvas documents are session-wide, so two windows can be showing the same
    // page. `browser_record_start` pins to the seat and hands that `documentId`
    // back for every later action — so if naming it resolved positionally, the
    // recording would be in one window and the actions in the other.
    store.ingest('s1', activate('doc-a'), 'client-a');
    // The second window's first word is a beat: its mount claim was dropped, or
    // the server restarted under it. It is reachable, and it has announced
    // nothing worth taking a live seat for.
    store.ingest('s1', beat('doc-a'), 'client-b');

    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
    expect(store.resolveDriver('s1', 'doc-a')).toMatchObject({ clientId: 'client-a' });
  });

  it('keeps a named page addressed to one window across beats', () => {
    // The shape the defect actually had: a page that is NOT the seat's, held by
    // two windows at once. Nothing but claim order arbitrates it, so a beat that
    // reordered the table sent alternate actions to alternate windows — and the
    // seat pointer, which the assertions above read, never noticed.
    store.ingest('s1', activate('doc-a'), 'client-a');
    store.ingest('s1', activate('doc-a'), 'client-b');
    // Window B moves on to another page and keeps the seat there.
    store.ingest('s1', activate('doc-b'), 'client-b');
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-b' });
    expect(store.resolveDriver('s1', 'doc-a')).toMatchObject({ clientId: 'client-b' });

    for (let round = 0; round < 4; round += 1) {
      store.ingest('s1', beat('doc-a'), 'client-a');
      expect(store.resolveDriver('s1', 'doc-a')).toMatchObject({ clientId: 'client-b' });
      store.ingest('s1', beat('doc-a'), 'client-b');
      store.ingest('s1', beat('doc-b'), 'client-b');
      expect(store.resolveDriver('s1', 'doc-a')).toMatchObject({ clientId: 'client-b' });
    }
  });

  it('makes a window reachable even if its first word is a keep-alive', () => {
    // Nothing holds the seat, so a beat from a window nobody has heard from is
    // still an answer to "which window is showing a preview" — "nothing is
    // open" would be false about a window that plainly is.
    store.ingest('s1', beat('doc-a'), 'client-a');

    expect(store.hasDrivers('s1')).toBe(true);
    expect(store.resolveDriver('s1')).toMatchObject({ clientId: 'client-a' });
  });
});
