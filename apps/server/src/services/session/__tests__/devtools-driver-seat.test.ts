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

/** An ingest batch that carries only a seat claim. */
function claim(documentId: string, active: boolean, instrumented = true): DevtoolsIngest {
  return { documentId, seq: 1, console: [], network: [], active, instrumented };
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
    store.ingest('s1', claim('doc-a', true), 'client-a');

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

  it('ignores a claim from a window that sent no client id', () => {
    // The route mints a per-request UUID for a client that sends no header, so
    // such a claim is real but belongs to nobody — it can never be addressed
    // twice, which is the point. Here the store is called the way a caller with
    // nothing to pass would call it.
    store.ingest('s1', claim('doc-a', true));
    expect(store.hasDrivers('s1')).toBe(false);
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
