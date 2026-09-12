/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import type { DevtoolsIngest } from '@dorkos/shared/schemas';
import { WORKBENCH_SANDBOX_ISOLATED } from '../lib/browser-url';

const ingestDevtoolsCapture = vi.fn(async () => {});

/**
 * ONE transport object for the life of the suite, deliberately.
 *
 * The real `useTransport` is a context read: it returns the same object across
 * renders, so the bridge's listener effect (keyed on `[transport, iframeRef]`)
 * mounts once and its pending flush timer survives every re-render. A mock
 * returning a fresh object per render re-ran that effect on each render, which
 * tore the listener down and cleared the timer with it — so no test could ever
 * observe what happens to a batch that is still coalescing when something
 * changes. The flush-window session bleed lived in that blind spot.
 */
const postDevtoolsAction = vi.fn(async () => {});
const uploadDevtoolsRecording = vi.fn(async () => {});
const transport = {
  ingestDevtoolsCapture,
  postDevtoolsAction,
  uploadDevtoolsRecording,
  clientId: 'web-this-window',
};

/**
 * The CAPTURE relays only — the seat claims filtered out.
 *
 * The bridge posts two different things down one route: console/network
 * captures, and the claim that says which page this window is showing (spec
 * `canvas-agent-seat` §2.2). A claim carries `active` and never carries an
 * entry, so the two are trivially separable — and every assertion in this file
 * is about one or the other, never about the raw call count, which would now
 * mean "captures plus however many times the window claimed".
 */
function relayedBatches(): [string, DevtoolsIngest][] {
  return (ingestDevtoolsCapture as Mock).mock.calls as unknown as [string, DevtoolsIngest][];
}

/** The capture relays only. */
function captureCalls(): [string, DevtoolsIngest][] {
  return relayedBatches().filter(([, batch]) => batch.active === undefined);
}

/** The seat claims only — the mirror image of {@link captureCalls}. */
function claimCalls(): [string, DevtoolsIngest][] {
  return relayedBatches().filter(([, batch]) => batch.active !== undefined);
}

/**
 * The routed cockpit's `?session=`.
 *
 * The REAL `useSessionId` runs in these tests, and `useSafeSearch` is the one
 * thing stubbed for it — the platform flag and the app store are the genuine
 * articles. That split is deliberate: the bug this file now guards (DOR-1305)
 * was the bridge reading the store field, which only the Obsidian embed ever
 * writes, so a test that stubbed the session hook itself would have agreed with
 * the broken code.
 */
let searchSession: string | undefined;

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
  useSafeSearch: () => (searchSession === undefined ? {} : { session: searchSession }),
}));

// Controllable stream-manager tap: tests emit session events by invoking the
// registered listeners directly (the real manager gates to the attached session).
const sessionEventListeners = new Set<(sessionId: string, event: unknown) => void>();
vi.mock('@/layers/shared/lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/transport')>()),
  streamManager: {
    subscribeSessionEvent: (handler: (sessionId: string, event: unknown) => void) => {
      sessionEventListeners.add(handler);
      return () => sessionEventListeners.delete(handler);
    },
  },
}));

// Rasterizer-source loader stub — also proves lazy-import-only (never called
// until a capture request actually arrives).
const loadRasterizerSource = vi.fn(async () => 'RASTERIZER_SRC');
vi.mock('../lib/load-rasterizer', () => ({
  loadRasterizerSource: () => loadRasterizerSource(),
}));

// The encoder is stubbed because jsdom has no canvas and never decodes an
// image, so the real `drawFrames` cannot run here at all. What these tests are
// about is the ROUTING — which frames reach the buffer, which never reach the
// server, and what is uploaded — and the encoder itself is proved against its
// own output in `lib/__tests__/encode-recording.test.ts`.
type EncodeOutcome = { ok: true; bytes: Uint8Array } | { ok: false; error: string };
const OK_GIF: EncodeOutcome = { ok: true, bytes: new Uint8Array([0x47, 0x49, 0x46]) };
const drawFrames = vi.fn(async (dataUrls: readonly string[], _longEdgePx: number) =>
  dataUrls.map(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }))
);
/**
 * What the next `encodeGif` calls answer, in order.
 *
 * A QUEUE rather than one value, because the retry at half the long edge (spec
 * §3.3) is a second call whose answer has to differ from the first's — a single
 * value cannot tell "it fitted on the retry" from "it never fitted".
 */
let encodeResults: EncodeOutcome[] = [OK_GIF];
const encodeGif = vi.fn(async () => encodeResults.shift() ?? OK_GIF);
vi.mock('../lib/encode-recording', () => ({
  drawFrames: (dataUrls: readonly string[], longEdgePx: number) => drawFrames(dataUrls, longEdgePx),
  encodeGif: () => encodeGif(),
}));

import { setPlatformAdapter } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useDevtoolsBridge } from '../model/use-devtools-bridge';

/** Attach a session the way the browser and desktop app do: in the URL. */
function attachInUrl(id: string): void {
  searchSession = id;
}

/**
 * Attach a session the way the Obsidian embed does: in the store, with no URL
 * to read. Flips the platform for the rest of the test; `beforeEach` puts it
 * back.
 */
function attachInStore(id: string): void {
  setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
  useAppStore.getState().setSessionId(id);
}

/** No conversation open at all — neither address carries one. */
function detachSession(): void {
  searchSession = undefined;
  useAppStore.getState().setSessionId(null);
}

let iframe: HTMLIFrameElement;

/** A window that is NOT our iframe's contentWindow, standing in for a foreign frame. */
let foreignFrame: HTMLIFrameElement;

function mount(previewOrigin: string | null = null): { current: HTMLIFrameElement | null } {
  const { result } = renderHook(() => {
    const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
    useDevtoolsBridge({
      iframeRef: ref,
      documentId: 'doc',
      logicalUrl: 'preview.html',
      reloadNonce: 0,
      previewOrigin,
    });
    return ref;
  });
  return result.current;
}

/** Dispatch a message as though it came from `source`. */
/**
 * Dispatch a message as though it came from `source`.
 *
 * The default origin is `"null"` because that is what every frame carrying the
 * shim reports: the shim is injected only into what DorkOS serves or proxies,
 * and those render in an opaque-origin sandbox. Pass an origin explicitly to
 * stand in for a frame that is NOT one of ours.
 */
function postFrom(source: Window | null, data: unknown, origin = 'null'): void {
  window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
}

/** The bridge's seat-refresh beat, mirrored so a reload test can advance past one. */
const SEAT_REFRESH_BEAT_MS = 15_000;

const consoleEntry = { level: 'error' as const, text: 'boom', timestamp: 1 };
const networkEntry = {
  method: 'GET',
  url: '/x',
  status: 200,
  ok: true,
  durationMs: 1,
  timestamp: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  // The default surface is the standalone browser app, where the conversation
  // lives in the URL. The embed is the exception each of its tests declares.
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
  useAppStore.getState().setSessionId(null);
  attachInUrl('session-1');
  ingestDevtoolsCapture.mockClear();
  postDevtoolsAction.mockClear();
  uploadDevtoolsRecording.mockClear();
  drawFrames.mockClear();
  encodeGif.mockClear();
  encodeResults = [OK_GIF];
  loadRasterizerSource.mockClear();
  sessionEventListeners.clear();
  iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  foreignFrame = document.createElement('iframe');
  document.body.appendChild(foreignFrame);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('useDevtoolsBridge — source-identity guard (anti-spoofing)', () => {
  it('ignores a batch from a foreign/nested frame (source is not our contentWindow)', () => {
    mount();
    postFrom(foreignFrame.contentWindow, {
      __dorkosDevtools: 'batch',
      seq: 1,
      console: [consoleEntry],
      network: [],
    });
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(0);
  });

  it('ignores a batch from the top window', () => {
    mount();
    postFrom(window, { __dorkosDevtools: 'batch', seq: 1, console: [consoleEntry], network: [] });
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(0);
  });

  it('ignores a non-DevTools message from our own frame', () => {
    mount();
    postFrom(iframe.contentWindow, { some: 'other-app-message' });
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(0);
  });

  it('ignores a frame with a real origin — only our own opaque frames carry the shim', () => {
    // A directly framed dev server IS `iframeRef.current.contentWindow`, so
    // source identity alone lets its own page code speak as if it were the shim.
    // Nothing injects a shim there, so anything arriving from a real origin is
    // the page impersonating one.
    mount();
    postFrom(
      iframe.contentWindow,
      { __dorkosDevtools: 'batch', seq: 1, console: [consoleEntry], network: [] },
      'http://localhost:5173'
    );
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(0);
  });

  it('never acks a hello from a frame with a real origin', () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' }, 'http://localhost:5173');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('accepts the preview origin this document was minted on', () => {
    // A dev server on a DorkOS preview listener has a REAL origin and does carry
    // the shim, so its exact origin — and only that one — is allowed through.
    mount('http://localhost:4390');
    postFrom(
      iframe.contentWindow,
      { __dorkosDevtools: 'batch', seq: 1, console: [consoleEntry], network: [] },
      'http://localhost:4390'
    );
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(1);
  });

  it('still rejects a different real origin while a preview origin is allowed', () => {
    mount('http://localhost:4390');
    postFrom(
      iframe.contentWindow,
      { __dorkosDevtools: 'batch', seq: 1, console: [consoleEntry], network: [] },
      'http://localhost:4391'
    );
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(0);
  });
});

describe('useDevtoolsBridge — resource errors the canvas can show', () => {
  /** Mount the bridge and keep hold of what it returns, plus a way to re-render it. */
  function mountCounting() {
    return renderHook(
      (props: { logicalUrl: string; reloadNonce: number }) => {
        const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
        return useDevtoolsBridge({
          iframeRef: ref,
          documentId: 'doc',
          previewOrigin: null,
          ...props,
        });
      },
      { initialProps: { logicalUrl: 'http://localhost:5173/', reloadNonce: 0 } }
    );
  }

  it('counts each failed resource the shim reports for our own frame', () => {
    const { result } = mountCounting();
    expect(result.current.resourceErrorCount).toBe(0);

    act(() => {
      postFrom(iframe.contentWindow, { __dorkosDevtools: 'resource-error', url: '/main.js' });
      postFrom(iframe.contentWindow, { __dorkosDevtools: 'resource-error', url: '/style.css' });
    });
    expect(result.current.resourceErrorCount).toBe(2);
  });

  it('counts them with no session attached — the banner is for the person watching', () => {
    // Relaying captures to a session is gated on attach; telling the user their
    // page is broken is not.
    detachSession();
    const { result } = mountCounting();
    act(() => {
      postFrom(iframe.contentWindow, { __dorkosDevtools: 'resource-error', url: '/main.js' });
    });
    expect(result.current.resourceErrorCount).toBe(1);
  });

  it('ignores a resource error from a foreign frame', () => {
    const { result } = mountCounting();
    act(() => {
      postFrom(foreignFrame.contentWindow, { __dorkosDevtools: 'resource-error', url: '/main.js' });
    });
    expect(result.current.resourceErrorCount).toBe(0);
  });

  it('ignores one from a real origin, so a direct frame cannot fake the banner', () => {
    const { result } = mountCounting();
    act(() => {
      postFrom(
        iframe.contentWindow,
        { __dorkosDevtools: 'resource-error', url: '/main.js' },
        'http://localhost:5173'
      );
    });
    expect(result.current.resourceErrorCount).toBe(0);
  });

  it('starts over on navigation and on reload — the count belongs to one document', () => {
    const { result, rerender } = mountCounting();
    act(() => {
      postFrom(iframe.contentWindow, { __dorkosDevtools: 'resource-error', url: '/main.js' });
    });
    expect(result.current.resourceErrorCount).toBe(1);

    rerender({ logicalUrl: 'http://localhost:5173/other', reloadNonce: 0 });
    expect(result.current.resourceErrorCount).toBe(0);

    act(() => {
      postFrom(iframe.contentWindow, { __dorkosDevtools: 'resource-error', url: '/main.js' });
    });
    expect(result.current.resourceErrorCount).toBe(1);

    rerender({ logicalUrl: 'http://localhost:5173/other', reloadNonce: 1 });
    expect(result.current.resourceErrorCount).toBe(0);
  });
});

describe('useDevtoolsBridge — handshake', () => {
  it('acks a hello from our own frame', () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    expect(postSpy).toHaveBeenCalledWith({ __dorkosDevtools: 'ack' }, '*');
  });

  it('acks a hello even before a session is attached (the shim stops retrying)', () => {
    // A preview can finish loading before session attach; the shim gives up
    // after ~15 hello retries, so a gated ack would leave that page load
    // permanently un-instrumented. The ack carries no captured data — the
    // attached-session gate applies to CAPTURES only.
    detachSession();
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    expect(postSpy).toHaveBeenCalledWith({ __dorkosDevtools: 'ack' }, '*');
  });

  it('never acks a hello from a foreign frame, attached or not', () => {
    detachSession();
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    postFrom(foreignFrame.contentWindow, { __dorkosDevtools: 'hello' });
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('useDevtoolsBridge — relay', () => {
  it('coalesces batches and relays once for the attached session', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'batch',
      seq: 1,
      console: [consoleEntry],
      network: [networkEntry],
    });
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'batch',
      seq: 2,
      console: [{ ...consoleEntry, text: 'second' }],
      network: [],
    });
    vi.advanceTimersByTime(300);

    expect(captureCalls()).toHaveLength(1);
    const [sid, batch] = captureCalls()[0];
    expect(sid).toBe('session-1');
    expect(batch.console).toHaveLength(2);
    expect(batch.network).toHaveLength(1);
    expect(batch.seq).toBe(2); // latest shim seq
    expect(batch.documentId).toBe('doc');
    expect(batch.logicalUrl).toBe('preview.html');
    expect(batch.reset).toBeUndefined();
  });

  it('does not relay when no session is attached', () => {
    detachSession();
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'batch',
      seq: 1,
      console: [consoleEntry],
      network: [],
    });
    vi.advanceTimersByTime(500);
    expect(captureCalls()).toHaveLength(0);
  });

  it('relays a reset (and clears stale captures) on a navigation boundary', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'batch',
      seq: 1,
      console: [consoleEntry],
      network: [],
    });
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'navigated' });
    vi.advanceTimersByTime(300);

    expect(captureCalls()).toHaveLength(1);
    const [, batch] = captureCalls()[0];
    expect(batch.reset).toBe(true);
    expect(batch.console).toHaveLength(0); // pre-navigation captures dropped
  });
});

describe('useDevtoolsBridge — which session is the attached one (DOR-1305)', () => {
  /** Post one console batch from the frame and let the debounce fire. */
  function sendOneBatch(): void {
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'batch',
      seq: 1,
      console: [consoleEntry],
      network: [],
    });
    vi.advanceTimersByTime(500);
  }

  it('relays in the browser app, where the conversation lives in the URL', () => {
    // The regression: the bridge used to read `app-store.sessionId`, which the
    // routed cockpit never writes, so this count was zero on every surface but
    // Obsidian and an agent's `browser_read_console` came back empty.
    attachInUrl('session-from-url');
    useAppStore.getState().setSessionId(null); // the store is empty here, as it really is
    mount();
    sendOneBatch();

    expect(captureCalls()).toHaveLength(1);
    expect(captureCalls()[0][0]).toBe('session-from-url');
  });

  it('relays a screenshot result in the browser app too', () => {
    attachInUrl('session-from-url');
    useAppStore.getState().setSessionId(null);
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });

    expect(captureCalls()).toHaveLength(1);
    expect(captureCalls()[0][0]).toBe('session-from-url');
  });

  it('still relays in the Obsidian embed, where it lives in the store', () => {
    searchSession = undefined; // no URL to read in the embed
    attachInStore('session-from-store');
    mount();
    sendOneBatch();

    expect(captureCalls()).toHaveLength(1);
    expect(captureCalls()[0][0]).toBe('session-from-store');
  });

  /**
   * Mount the bridge so the test can re-render it after moving the address —
   * which is how the attached session changes for a mounted preview.
   */
  function mountSwitchable() {
    return renderHook(() => {
      const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
      useDevtoolsBridge({
        iframeRef: ref,
        documentId: 'doc',
        logicalUrl: 'preview.html',
        reloadNonce: 0,
        previewOrigin: null,
      });
      return ref;
    });
  }

  /** Post a console batch carrying `text`, without letting the debounce fire. */
  function sendBatch(text: string, seq: number): void {
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'batch',
      seq,
      console: [{ ...consoleEntry, text }],
      network: [],
    });
  }

  it('relays a batch to the session it was captured under, not the one open when it flushes', () => {
    // The coalescing window is 300ms, which is plenty of time to switch
    // conversations. Reading the CURRENT session at flush time put this preview's
    // console into whichever conversation happened to be open by then.
    attachInUrl('session-a');
    const { rerender } = mountSwitchable();
    sendBatch('captured-under-a', 1);

    attachInUrl('session-b');
    act(() => rerender()); // the address moved; the bridge re-renders under B
    act(() => void vi.advanceTimersByTime(500));

    expect(captureCalls()).toHaveLength(1);
    const [sid, batch] = captureCalls()[0];
    expect(sid).toBe('session-a');
    expect(batch.console[0].text).toBe('captured-under-a');
  });

  it('closes the pending group on a switch, so neither session gets the other’s captures', () => {
    // The reciprocal leak: with only the send-time binding fixed, a batch
    // arriving under B during A's still-open window would have joined A's group
    // and gone out under A's id.
    attachInUrl('session-a');
    const { rerender } = mountSwitchable();
    sendBatch('captured-under-a', 1);

    attachInUrl('session-b');
    act(() => rerender());
    sendBatch('captured-under-b', 2);
    act(() => void vi.advanceTimersByTime(500));

    expect(captureCalls()).toHaveLength(2);
    const [firstSid, firstBatch] = captureCalls()[0];
    expect(firstSid).toBe('session-a');
    expect(firstBatch.console.map((e: { text: string }) => e.text)).toEqual(['captured-under-a']);
    const [secondSid, secondBatch] = captureCalls()[1];
    expect(secondSid).toBe('session-b');
    expect(secondBatch.console.map((e: { text: string }) => e.text)).toEqual(['captured-under-b']);
  });

  it('never relays to a session the embed left behind in the store', () => {
    // Standalone reads the URL and nothing else: a store id left over from an
    // earlier surface must not decide where a browser preview's captures go.
    detachSession();
    useAppStore.getState().setSessionId('stale-store-session');
    mount();
    sendOneBatch();

    expect(captureCalls()).toHaveLength(0);
  });
});

describe('workbench sandbox regression (DOR-213 must not weaken DOR-216)', () => {
  it('keeps the isolated sandbox string byte-for-byte (no allow-same-origin)', () => {
    expect(WORKBENCH_SANDBOX_ISOLATED).toBe('allow-scripts allow-forms allow-popups allow-modals');
  });
});

describe('useDevtoolsBridge — screenshot round-trip (DOR-213 Phase 3)', () => {
  function emitCaptureRequest(requestId: string): void {
    for (const handler of sessionEventListeners) {
      handler('session-1', { type: 'devtools_capture_request', requestId, seq: 1 });
    }
  }

  /** Flush the loader promise chain under fake timers. */
  async function flushAsync(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it('forwards a capture request into the frame with the rasterizer source', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    emitCaptureRequest('r1');
    await flushAsync();

    expect(postSpy).toHaveBeenCalledWith(
      { __dorkosDevtools: 'capture-request', requestId: 'r1', lib: 'RASTERIZER_SRC' },
      '*'
    );
  });

  it('loads the rasterizer source lazily — never before the first request', async () => {
    mount();
    expect(loadRasterizerSource).not.toHaveBeenCalled();
    emitCaptureRequest('r1');
    await flushAsync();
    expect(loadRasterizerSource).toHaveBeenCalledTimes(1);
  });

  it('still forwards the request when the rasterizer source fails to load', async () => {
    // The shim then fails fast with an error result instead of the tool
    // waiting out its full timeout.
    loadRasterizerSource.mockRejectedValueOnce(new Error('chunk failed'));
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    emitCaptureRequest('r1');
    await flushAsync();

    expect(postSpy).toHaveBeenCalledWith(
      { __dorkosDevtools: 'capture-request', requestId: 'r1', lib: undefined },
      '*'
    );
  });

  it('ignores other session events', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    for (const handler of sessionEventListeners) {
      handler('session-1', { type: 'turn_start', seq: 1 });
    }
    await flushAsync();
    expect(postSpy).not.toHaveBeenCalled();
    expect(loadRasterizerSource).not.toHaveBeenCalled();
  });

  it('ingests a capture-result immediately (no debounce), tagged with its requestId', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });

    // Immediate — the awaiting tool must not eat the 300ms batch debounce.
    expect(captureCalls()).toHaveLength(1);
    const [sid, batch] = captureCalls()[0];
    expect(sid).toBe('session-1');
    expect(batch.screenshot).toEqual({
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(batch.console).toHaveLength(0);
    expect(batch.network).toHaveLength(0);
  });

  it('relays a shim-side rasterization error result', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      error: 'CSP blocked the rasterizer',
    });

    expect(captureCalls()).toHaveLength(1);
    const [, batch] = captureCalls()[0];
    expect(batch.screenshot).toEqual({ requestId: 'r1', error: 'CSP blocked the rasterizer' });
  });

  it('ignores a capture-result from a foreign frame (anti-spoofing)', () => {
    mount();
    postFrom(foreignFrame.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(captureCalls()).toHaveLength(0);
  });

  it('drops a capture-result when no session is attached', () => {
    detachSession();
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(captureCalls()).toHaveLength(0);
  });
});

describe('useDevtoolsBridge — the driver seat (spec `canvas-agent-seat` §2.2)', () => {
  /** Push one addressed request onto the stream, the way the server does. */
  function emitActionRequest(
    requestId: string,
    addressing: { targetClientId?: string; documentId?: string } = {}
  ): void {
    for (const handler of sessionEventListeners) {
      handler('session-1', {
        type: 'devtools_action_request',
        requestId,
        targetClientId: 'web-this-window',
        documentId: 'doc',
        command: { action: 'click', target: { selector: '#pay' } },
        seq: 1,
        ...addressing,
      });
    }
  }

  /** Mount, and let the chained claim actually go out. */
  async function mountAndSettle(): Promise<void> {
    mount();
    await vi.advanceTimersByTimeAsync(0);
  }

  it('claims the seat for its page on mount, before any handshake', async () => {
    await mountAndSettle();
    const claims = claimCalls();
    expect(claims).toHaveLength(1);
    expect(claims[0][0]).toBe('session-1');
    expect(claims[0][1]).toMatchObject({ active: true, instrumented: false });
  });

  it('upgrades the claim to instrumented once the shim says hello', async () => {
    await mountAndSettle();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    const claims = claimCalls();
    expect(claims).toHaveLength(2);
    expect(claims[1][1]).toMatchObject({ active: true, instrumented: true });
  });

  it('releases the seat when the page goes away', async () => {
    await mountAndSettle();
    cleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ active: false });
  });

  it('releases the seat on pagehide, with a request that can outlive the page', async () => {
    // The one release a window that is being closed can still send. Without it,
    // a killed tab leaves a seat nobody is sitting in and every verb addresses a
    // window that no longer answers. `keepalive` is what lets the request leave
    // at all; the server's staleness rule is what makes it not have to.
    await mountAndSettle();
    ingestDevtoolsCapture.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);

    const release = claimCalls().at(-1);
    expect(release![1]).toMatchObject({ active: false });
    expect((ingestDevtoolsCapture as Mock).mock.calls.at(-1)![2]).toEqual({ keepalive: true });
  });

  it('keeps reporting that it is still showing the page', async () => {
    // A window that goes quiet loses its seat after three missed beats, so a
    // window that is genuinely still there has to say so. Asserted on the beat,
    // because a claim posted only at mount would expire under a person who left
    // the preview open and went to lunch.
    await mountAndSettle();
    ingestDevtoolsCapture.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(claimCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(claimCalls()).toHaveLength(3);
    for (const [, batch] of claimCalls()) expect(batch.active).toBe(true);
  });

  it('re-reports the moment the tab becomes visible again', async () => {
    // A tab hidden for more than five minutes has its timers aligned to one wake
    // per minute (Chrome), so the 15s beat that should have reported is late and
    // the seat may already have yielded. Coming back has to take it straight
    // back rather than waiting for the next beat.
    //
    // The THROTTLING itself is not reproducible here, and not in Playwright
    // either — the browser is launched with `--disable-background-timer-throttling`,
    // which is what makes the rest of the suite deterministic. What is asserted
    // is the half this code owns: the event fires, the claim goes out.
    await mountAndSettle();
    ingestDevtoolsCapture.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(claimCalls()).toHaveLength(1);
    expect(claimCalls()[0][1]).toMatchObject({ active: true });
  });

  it('does not re-report when the tab is going AWAY, only when it comes back', async () => {
    await mountAndSettle();
    ingestDevtoolsCapture.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    // Hiding a tab is not closing it: the preview is still there, and claiming
    // on the way out would be a claim about nothing while `pagehide` already
    // covers the real departure.
    expect(claimCalls()).toHaveLength(0);
  });

  it('re-reports when the page is restored from the back/forward cache', async () => {
    // A restored page ran no timers at all while it was away, so the beat did
    // not merely run late — it never happened.
    await mountAndSettle();
    ingestDevtoolsCapture.mockClear();
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls()).toHaveLength(1);
    expect(claimCalls()[0][1]).toMatchObject({ active: true });
  });

  it('stops claiming for a session it is no longer attached to', async () => {
    // The frame OUTLIVES the conversation: the session goes away while the
    // preview stays mounted, so the claim effect tears down and the message
    // listener — keyed on the transport and the ref, not the session — does not.
    // A `hello` arriving after that must not re-claim a seat under the id the
    // torn-down closure captured, because that is not the session on screen.
    //
    // Unmounting instead would prove nothing: it takes the listener with it, so
    // the `hello` would reach nothing whether or not the claim was nulled.
    const { rerender } = renderHook(() => {
      const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
      useDevtoolsBridge({
        iframeRef: ref,
        documentId: 'doc',
        logicalUrl: 'preview.html',
        reloadNonce: 0,
        previewOrigin: null,
      });
      return ref;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls()).toHaveLength(1);

    detachSession();
    rerender();
    await vi.advanceTimersByTimeAsync(0);
    ingestDevtoolsCapture.mockClear();

    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls()).toHaveLength(0);
  });

  it('stops reporting a page as instrumented once it navigates away', async () => {
    // A frame outlives its page. Before this, `instrumented` was a plain boolean
    // set once by `hello` and never reset — so after a same-tab navigation from
    // an instrumented preview to a page carrying no shim (an external site, a
    // directly framed dev server), the seat still said the page could be driven.
    // Every driving verb then minted a real request and waited out the whole
    // timeout instead of refusing in a sentence.
    await mountAndSettle();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ active: true, instrumented: true });

    ingestDevtoolsCapture.mockClear();
    // The shim's own last word before its document is replaced.
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'navigated' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ active: true, instrumented: false });

    // And the new page says hello, so it is drivable again.
    ingestDevtoolsCapture.mockClear();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ instrumented: true });
  });

  it('reports the new page honestly when the address changes before the shim says so', async () => {
    // The other order the two signals can arrive in: the parent re-points the
    // frame and the old page's `navigated` is still in flight, or never comes at
    // all. Keying the handshake to the document rather than resetting a flag is
    // what covers this — the old answer simply stops matching.
    const { rerender } = renderHook(
      ({ url }: { url: string }) => {
        const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
        useDevtoolsBridge({
          iframeRef: ref,
          documentId: 'doc',
          logicalUrl: url,
          reloadNonce: 0,
          previewOrigin: null,
        });
        return ref;
      },
      { initialProps: { url: 'preview.html' } }
    );
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ instrumented: true });

    ingestDevtoolsCapture.mockClear();
    rerender({ url: 'https://example.com/' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ instrumented: false });
  });

  it('treats a reload of the same address as a new page it has not heard from', async () => {
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) => {
        const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
        useDevtoolsBridge({
          iframeRef: ref,
          documentId: 'doc',
          logicalUrl: 'preview.html',
          reloadNonce: nonce,
          previewOrigin: null,
        });
        return ref;
      },
      { initialProps: { nonce: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().at(-1)![1]).toMatchObject({ instrumented: true });

    // A reload leaves the URL alone, so only the nonce says the document
    // changed. The next claim — the refresh beat — must report the truth.
    ingestDevtoolsCapture.mockClear();
    rerender({ nonce: 1 });
    await vi.advanceTimersByTimeAsync(SEAT_REFRESH_BEAT_MS);
    expect(claimCalls().at(-1)![1]).toMatchObject({ instrumented: false });
  });

  it('holds a release until the claim before it has actually gone out', async () => {
    // Two fire-and-forget POSTs can arrive either way round. On an in-preview
    // navigation the pair is a release then a claim, and arriving swapped the
    // release lands last — dropping a seat the window is still holding.
    //
    // The assertion is that the second POST has not been MADE yet while the
    // first is still in flight. Asserting only on the final order would pass
    // with no chain at all, because both calls land either way.
    let letFirstFinish: (() => void) | undefined;
    ingestDevtoolsCapture.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          letFirstFinish = resolve;
        })
    );
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);

    cleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      ingestDevtoolsCapture,
      'the release was posted while the claim before it was still in flight'
    ).toHaveBeenCalledTimes(1);

    letFirstFinish!();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimCalls().map(([, batch]) => batch.active)).toEqual([true, false]);
  });

  it('forwards a request addressed to this window and this page', () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    emitActionRequest('a1');

    expect(postSpy).toHaveBeenCalledWith(
      {
        __dorkosDevtools: 'act-request',
        requestId: 'a1',
        documentId: 'doc',
        command: { action: 'click', target: { selector: '#pay' } },
      },
      '*'
    );
  });

  it('ignores a request addressed to another window, however active this one is', () => {
    // The bug this closes, in its new place: re-deriving "am I the active one"
    // locally gives two windows on one session the same answer.
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    emitActionRequest('a2', { targetClientId: 'web-the-other-window' });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('ignores a request for a page this window is not holding', () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    emitActionRequest('a3', { documentId: 'some-other-doc' });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('applies the same addressing to a screenshot request', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    for (const handler of sessionEventListeners) {
      handler('session-1', {
        type: 'devtools_capture_request',
        requestId: 'c1',
        targetClientId: 'web-the-other-window',
        documentId: 'doc',
        seq: 1,
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('still forwards a request that names nobody, the way an older server sends it', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    for (const handler of sessionEventListeners) {
      handler('session-1', { type: 'devtools_capture_request', requestId: 'c2', seq: 1 });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(postSpy).toHaveBeenCalledWith(
      { __dorkosDevtools: 'capture-request', requestId: 'c2', lib: 'RASTERIZER_SRC' },
      '*'
    );
  });

  it('relays an act-result immediately, with no debounce', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: true,
      did: 'Clicked button "Pay $42.00".',
      matched: 1,
      documentId: 'doc',
      page: { title: 'Checkout', url: 'https://preview/checkout', focused: null },
    });

    // Not a capture batch, and not waiting out the 300ms flush window: a tool
    // call is awaiting this requestId server-side.
    expect(postDevtoolsAction).toHaveBeenCalledTimes(1);
    expect((postDevtoolsAction as Mock).mock.calls[0]).toEqual([
      'session-1',
      {
        requestId: 'a1',
        ok: true,
        did: 'Clicked button "Pay $42.00".',
        matched: 1,
        documentId: 'doc',
        page: { title: 'Checkout', url: 'https://preview/checkout', focused: null },
      },
    ]);
  });

  it('relays a page-side failure as a failure, keeping its sentence', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: false,
      matched: 4,
      error: '4 things matched that. Pass nth to pick one, or name it more exactly.',
    });

    expect((postDevtoolsAction as Mock).mock.calls[0][1]).toMatchObject({
      ok: false,
      matched: 4,
      error: '4 things matched that. Pass nth to pick one, or name it more exactly.',
    });
  });

  it('drops a malformed page summary rather than posting a body the route rejects', () => {
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: true,
      page: { title: 42, url: null },
    });

    expect((postDevtoolsAction as Mock).mock.calls[0][1]).not.toHaveProperty('page');
  });

  it('ignores an act-result from a foreign frame (anti-spoofing)', () => {
    mount();
    postFrom(foreignFrame.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: true,
      did: 'Clicked something nobody asked for.',
    });
    expect(postDevtoolsAction).not.toHaveBeenCalled();
  });

  it('drops an act-result when no session is attached', () => {
    detachSession();
    mount();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'act-result', requestId: 'a1', ok: true });
    expect(postDevtoolsAction).not.toHaveBeenCalled();
  });
});

describe('useDevtoolsBridge — recording a run', () => {
  /** Deliver one server→client event to every mounted bridge. */
  function emit(event: unknown): void {
    for (const handler of sessionEventListeners) handler('session-1', event);
  }

  /** The start/stop event the server sends, with this window's address on it. */
  function recordingEvent(action: 'start' | 'stop', requestId: string) {
    return {
      type: 'devtools_recording_request',
      seq: 1,
      requestId,
      targetClientId: 'web-this-window',
      documentId: 'doc',
      action,
      recordingId: 'rec-1',
      bounds: { longEdgePx: 800, frameMs: 500, maxBytes: 8 * 1024 * 1024 },
    };
  }

  /** The id of the keyframe round trip this window just asked the page for. */
  function lastFrameRequestId(postSpy: Mock): string {
    const calls = postSpy.mock.calls.filter(
      ([message]) =>
        (message as { __dorkosDevtools?: string }).__dorkosDevtools === 'capture-request'
    );
    return (calls.at(-1)?.[0] as { requestId: string }).requestId;
  }

  it('asks the page for a frame on start, and keeps it out of the screenshot slot', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as Mock;
    mount();

    emit(recordingEvent('start', 'r1'));
    await vi.advanceTimersByTimeAsync(0);
    const frameId = lastFrameRequestId(postSpy);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: frameId,
      dataUrl: 'data:image/png;base64,AAAA',
    });
    await vi.advanceTimersByTimeAsync(500);

    // A recording frame is NOT a `browser_screenshot` answer: relaying it would
    // overwrite the screenshot slot an agent may be about to read.
    expect(captureCalls()).toHaveLength(0);
  });

  it('sends the rasterizer with a capturing action, and nothing extra without one', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as Mock;
    mount();

    emit({
      type: 'devtools_action_request',
      seq: 1,
      requestId: 'a1',
      targetClientId: 'web-this-window',
      documentId: 'doc',
      command: { action: 'click', target: { text: 'Pay' } },
      capture: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        __dorkosDevtools: 'act-request',
        requestId: 'a1',
        capture: true,
        lib: 'RASTERIZER_SRC',
      }),
      '*'
    );

    postSpy.mockClear();
    loadRasterizerSource.mockClear();
    emit({
      type: 'devtools_action_request',
      seq: 2,
      requestId: 'a2',
      targetClientId: 'web-this-window',
      documentId: 'doc',
      command: { action: 'click', target: { text: 'Pay' } },
    });
    await vi.advanceTimersByTimeAsync(0);
    // No recording, no rasterizer chunk: an ordinary click costs no download.
    expect(loadRasterizerSource).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledWith(expect.not.objectContaining({ capture: true }), '*');
  });

  it('keeps an action frame here and tells the server only that it kept one', async () => {
    mount();
    emit(recordingEvent('start', 'r1'));
    await vi.advanceTimersByTimeAsync(0);

    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: true,
      did: 'Clicked Pay.',
      dataUrl: 'data:image/png;base64,FRAME',
    });

    const relayed = (postDevtoolsAction as Mock).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(relayed.captured).toBe(true);
    // The picture itself never crosses the wire.
    expect(relayed).not.toHaveProperty('dataUrl');
  });

  it('does not claim a frame it was never given', () => {
    mount();
    emit(recordingEvent('start', 'r1'));

    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: true,
      did: 'Clicked Pay.',
    });

    const relayed = (postDevtoolsAction as Mock).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(relayed.captured).toBeUndefined();
  });

  it('encodes and uploads the run on stop, with the last frame beside it', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as Mock;
    mount();
    emit(recordingEvent('start', 'r1'));
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: lastFrameRequestId(postSpy),
      dataUrl: 'data:image/png;base64,AAAA',
    });
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'act-result',
      requestId: 'a1',
      ok: true,
      dataUrl: 'data:image/png;base64,BBBB',
    });

    emit(recordingEvent('stop', 'r2'));
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: lastFrameRequestId(postSpy),
      dataUrl: 'data:image/png;base64,CCCC',
    });
    await vi.advanceTimersByTimeAsync(0);

    // Three frames: the one on start, the one the action produced, the one on stop.
    expect(drawFrames).toHaveBeenCalledWith(
      ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB', 'data:image/png;base64,CCCC'],
      800
    );
    const [sid, upload] = (uploadDevtoolsRecording as Mock).mock.calls.at(-1) as [
      string,
      Record<string, { name: string; type: string }> & { requestId: string; frames: number },
    ];
    expect(sid).toBe('session-1');
    expect(upload.requestId).toBe('r2');
    expect(upload.frames).toBe(3);
    expect(upload.recording.type).toBe('image/gif');
    expect(upload.keyframe.type).toBe('image/png');
  });

  it('redraws once at half the size before giving up, and says which happened', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as Mock;
    mount();
    emit(recordingEvent('start', 'r1'));
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: lastFrameRequestId(postSpy),
      dataUrl: 'data:image/png;base64,AAAA',
    });
    await vi.advanceTimersByTimeAsync(0);
    // Over the cap at full size, under it at half — the case the spec's one
    // retry exists for, and the one that used to lose the run outright.
    encodeResults = [{ ok: false, error: 'The recording came out bigger than 8 MB.' }, OK_GIF];

    emit(recordingEvent('stop', 'r2'));
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: lastFrameRequestId(postSpy),
      dataUrl: 'data:image/png;base64,CCCC',
    });
    await vi.advanceTimersByTimeAsync(0);

    // Drawn twice: once at the recording size the server set, once at half it.
    const sizes = drawFrames.mock.calls.map(([, longEdgePx]) => longEdgePx);
    expect(sizes).toEqual([800, 400]);
    // And the file really went, rather than the run being lost with a sentence.
    const upload = (uploadDevtoolsRecording as Mock).mock.calls.at(-1)?.[1] as {
      requestId: string;
      error?: string;
    };
    expect(upload.requestId).toBe('r2');
    expect(upload.error).toBeUndefined();
  });

  it('reports the encoder`s refusal instead of leaving the tool to time out', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as Mock;
    mount();
    emit(recordingEvent('start', 'r1'));
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: lastFrameRequestId(postSpy),
      dataUrl: 'data:image/png;base64,AAAA',
    });
    await vi.advanceTimersByTimeAsync(0);
    const tooBig = { ok: false as const, error: 'The recording came out bigger than 8 MB.' };
    encodeResults = [tooBig, tooBig];

    emit(recordingEvent('stop', 'r2'));
    await vi.advanceTimersByTimeAsync(0);
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: lastFrameRequestId(postSpy),
      dataUrl: 'data:image/png;base64,CCCC',
    });
    await vi.advanceTimersByTimeAsync(0);

    // The sentence names what was actually tried. Saying "it was not saved"
    // without the redraw would describe a retry that had not happened; saying it
    // here would describe one that had not, before the retry existed.
    expect((uploadDevtoolsRecording as Mock).mock.calls.at(-1)?.[1]).toEqual({
      requestId: 'r2',
      error:
        'The recording came out bigger than 8 MB. It was redrawn at half the size and was ' +
        'still too big, so it was not saved.',
    });
  });

  it('reports a stop for a recording this window is not holding', async () => {
    mount();

    emit(recordingEvent('stop', 'r2'));
    await vi.advanceTimersByTimeAsync(0);

    const upload = (uploadDevtoolsRecording as Mock).mock.calls.at(-1)?.[1] as {
      requestId: string;
      error: string;
    };
    expect(upload.requestId).toBe('r2');
    expect(upload.error).toContain('stopped recording');
  });

  it('ignores a recording request addressed to another window', async () => {
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage') as unknown as Mock;
    mount();

    emit({ ...recordingEvent('start', 'r1'), targetClientId: 'some-other-window' });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      postSpy.mock.calls.filter(
        ([message]) =>
          (message as { __dorkosDevtools?: string }).__dorkosDevtools === 'capture-request'
      )
    ).toHaveLength(0);
  });
});
