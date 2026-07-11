/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
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

import { useDevtoolsBridge } from '../model/use-devtools-bridge';

let iframe: HTMLIFrameElement;

/** A window that is NOT our iframe's contentWindow, standing in for a foreign frame. */
let foreignFrame: HTMLIFrameElement;

function mount(): { current: HTMLIFrameElement | null } {
  const { result } = renderHook(() => {
    const ref = useRef<HTMLIFrameElement | null>(iframe) as RefObject<HTMLIFrameElement | null>;
    useDevtoolsBridge({ iframeRef: ref, documentId: 'doc', logicalUrl: 'preview.html' });
    return ref;
  });
  return result.current;
}

/** Dispatch a message as though it came from `source`. */
function postFrom(source: Window | null, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
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
