/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
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
const transport = { ingestDevtoolsCapture };

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
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
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
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
  });

  it('ignores a batch from the top window', () => {
    mount();
    postFrom(window, { __dorkosDevtools: 'batch', seq: 1, console: [consoleEntry], network: [] });
    vi.advanceTimersByTime(500);
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
  });

  it('ignores a non-DevTools message from our own frame', () => {
    mount();
    postFrom(iframe.contentWindow, { some: 'other-app-message' });
    vi.advanceTimersByTime(500);
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
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
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
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
    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
  });

  it('still rejects a different real origin while a preview origin is allowed', () => {
    mount('http://localhost:4390');
    postFrom(
      iframe.contentWindow,
      { __dorkosDevtools: 'batch', seq: 1, console: [consoleEntry], network: [] },
      'http://localhost:4391'
    );
    vi.advanceTimersByTime(500);
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    const [sid, batch] = (ingestDevtoolsCapture as Mock).mock.calls[0];
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
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    const [, batch] = (ingestDevtoolsCapture as Mock).mock.calls[0];
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    expect((ingestDevtoolsCapture as Mock).mock.calls[0][0]).toBe('session-from-url');
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    expect((ingestDevtoolsCapture as Mock).mock.calls[0][0]).toBe('session-from-url');
  });

  it('still relays in the Obsidian embed, where it lives in the store', () => {
    searchSession = undefined; // no URL to read in the embed
    attachInStore('session-from-store');
    mount();
    sendOneBatch();

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    expect((ingestDevtoolsCapture as Mock).mock.calls[0][0]).toBe('session-from-store');
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    const [sid, batch] = (ingestDevtoolsCapture as Mock).mock.calls[0];
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(2);
    const [firstSid, firstBatch] = (ingestDevtoolsCapture as Mock).mock.calls[0];
    expect(firstSid).toBe('session-a');
    expect(firstBatch.console.map((e: { text: string }) => e.text)).toEqual(['captured-under-a']);
    const [secondSid, secondBatch] = (ingestDevtoolsCapture as Mock).mock.calls[1];
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

    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
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
    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    const [sid, batch] = (ingestDevtoolsCapture as Mock).mock.calls[0];
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

    expect(ingestDevtoolsCapture).toHaveBeenCalledTimes(1);
    const [, batch] = (ingestDevtoolsCapture as Mock).mock.calls[0];
    expect(batch.screenshot).toEqual({ requestId: 'r1', error: 'CSP blocked the rasterizer' });
  });

  it('ignores a capture-result from a foreign frame (anti-spoofing)', () => {
    mount();
    postFrom(foreignFrame.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
  });

  it('drops a capture-result when no session is attached', () => {
    detachSession();
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
  });
});
