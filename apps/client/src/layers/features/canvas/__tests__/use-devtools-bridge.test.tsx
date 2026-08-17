/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useRef, type RefObject } from 'react';
import { WORKBENCH_SANDBOX_ISOLATED } from '../lib/browser-url';

// Controllable store + transport, mirroring CanvasBrowserContent.test.tsx.
const mockState = { sessionId: 'session-1' as string | null };
const ingestDevtoolsCapture = vi.fn(async () => {});

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  return {
    useAppStore,
    useTransport: () => ({ ingestDevtoolsCapture }),
  };
});

// Controllable stream-manager tap: tests emit session events by invoking the
// registered listeners directly (the real manager gates to the attached session).
const sessionEventListeners = new Set<(sessionId: string, event: unknown) => void>();
vi.mock('@/layers/shared/lib', () => ({
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

import { useDevtoolsBridge } from '../model/use-devtools-bridge';

let iframe: HTMLIFrameElement;

/** A window that is NOT our iframe's contentWindow, standing in for a foreign frame. */
let foreignFrame: HTMLIFrameElement;

function mount(): { current: HTMLIFrameElement | null } {
  const { result } = renderHook(() => {
    const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
    useDevtoolsBridge({
      iframeRef: ref,
      documentId: 'doc',
      logicalUrl: 'preview.html',
      reloadNonce: 0,
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
  mockState.sessionId = 'session-1';
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
});

describe('useDevtoolsBridge — resource errors the canvas can show', () => {
  /** Mount the bridge and keep hold of what it returns, plus a way to re-render it. */
  function mountCounting() {
    return renderHook(
      (props: { logicalUrl: string; reloadNonce: number }) => {
        const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
        return useDevtoolsBridge({ iframeRef: ref, documentId: 'doc', ...props });
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
    mockState.sessionId = null;
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
    mockState.sessionId = null;
    const postSpy = vi.spyOn(iframe.contentWindow as Window, 'postMessage');
    mount();
    postFrom(iframe.contentWindow, { __dorkosDevtools: 'hello' });
    expect(postSpy).toHaveBeenCalledWith({ __dorkosDevtools: 'ack' }, '*');
  });

  it('never acks a hello from a foreign frame, attached or not', () => {
    mockState.sessionId = null;
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
    mockState.sessionId = null;
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
    mockState.sessionId = null;
    mount();
    postFrom(iframe.contentWindow, {
      __dorkosDevtools: 'capture-result',
      requestId: 'r1',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(ingestDevtoolsCapture).not.toHaveBeenCalled();
  });
});
