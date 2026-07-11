/**
 * The parent side of the DevTools capture bridge (DOR-213).
 *
 * The injected in-page shim (server-side `devtools-shim.ts`) posts its captures
 * to `window.parent` — never to `/api/*`, because it runs in an opaque-origin
 * sandbox (ADR 260708-185519). This hook, mounted by `CanvasBrowserContent`, is
 * that parent: it acks the shim's handshake, coalesces its batches, and forwards
 * them to `POST /sessions/:id/devtools/ingest` through the transport — the only
 * same-origin, authenticated party allowed to reach the API.
 *
 * Two guarantees are load-bearing:
 * - **Source identity.** A capture message is accepted only when
 *   `event.source === iframe.contentWindow`. The opaque frame's `event.origin` is
 *   the literal string `"null"`, so origin tells us nothing — identity is the
 *   check, and it rejects a nested frame or any foreign window.
 * - **Attached session only.** Captures relay to the attached session
 *   (`app-store.sessionId`) and no other, so one session's preview can never feed
 *   another session's buffer.
 *
 * It also drives the `browser_screenshot` round-trip (DOR-213 Phase 3): a
 * `devtools_capture_request` on the attached session's event stream is
 * forwarded into the frame (with the lazy-loaded rasterizer source riding
 * along), and the shim's `capture-result` is ingested immediately, tagged with
 * its `requestId`, resolving the awaiting tool call server-side.
 *
 * Idle-cheap: one window listener, and no timer runs until a batch actually
 * arrives; the rasterizer chunk downloads only on the first capture request.
 *
 * @module features/canvas/model/use-devtools-bridge
 */
import { useEffect, useRef, type RefObject } from 'react';
import type {
  DevtoolsConsoleEntry,
  DevtoolsIngest,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import { DEVTOOLS_CONSOLE_BATCH_MAX, DEVTOOLS_NETWORK_BATCH_MAX } from '@dorkos/shared/schemas';
import { streamManager } from '@/layers/shared/lib';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { loadRasterizerSource } from '../lib/load-rasterizer';

/** How long to coalesce shim batches before one ingest POST. */
const FLUSH_DEBOUNCE_MS = 300;

/** A message the shim posts to the parent. */
interface DevtoolsMessage {
  __dorkosDevtools?: 'hello' | 'batch' | 'navigated' | 'capture-result';
  seq?: number;
  console?: DevtoolsConsoleEntry[];
  network?: DevtoolsNetworkEntry[];
  /** `capture-result`: the round-trip id echoed from the capture request. */
  requestId?: unknown;
  /** `capture-result`: the rendered PNG data URL on success. */
  dataUrl?: unknown;
  /** `capture-result`: the shim's failure reason when rasterization failed. */
  error?: unknown;
}

/** Inputs to {@link useDevtoolsBridge}. */
export interface UseDevtoolsBridgeParams {
  /** Ref to the preview iframe whose `contentWindow` is the trusted source. */
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** The canvas document id of this preview (tags the ingest batch). */
  documentId: string;
  /** The logical URL currently loaded (never the signed token URL). */
  logicalUrl: string;
}

/** Drop the oldest entries in place so `arr` holds at most `cap`. */
function cap<T>(arr: T[], max: number): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/**
 * Relay the embedded preview's console/network captures to the server's
 * per-session buffer. See the module doc for the security guarantees.
 *
 * @param params - The preview iframe ref plus the document id and logical URL.
 */
export function useDevtoolsBridge({
  iframeRef,
  documentId,
  logicalUrl,
}: UseDevtoolsBridgeParams): void {
  const transport = useTransport();
  const sessionId = useAppStore((s) => s.sessionId);

  // Refs so the single, long-lived window listener always reads current values
  // without being torn down and re-added on every render.
  const sessionIdRef = useRef(sessionId);
  const documentIdRef = useRef(documentId);
  const logicalUrlRef = useRef(logicalUrl);
  // Keep the refs current for the long-lived listener without re-adding it. Synced
  // in an effect (not during render) so a stale batch never posts under old ids.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    documentIdRef.current = documentId;
    logicalUrlRef.current = logicalUrl;
  });

  const pendingConsole = useRef<DevtoolsConsoleEntry[]>([]);
  const pendingNetwork = useRef<DevtoolsNetworkEntry[]>([]);
  const pendingReset = useRef(false);
  const lastSeq = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function flush(): void {
      flushTimer.current = null;
      const sid = sessionIdRef.current;
      if (!sid) {
        pendingConsole.current = [];
        pendingNetwork.current = [];
        pendingReset.current = false;
        return;
      }
      if (
        !pendingReset.current &&
        pendingConsole.current.length === 0 &&
        pendingNetwork.current.length === 0
      ) {
        return;
      }
      const batch: DevtoolsIngest = {
        documentId: documentIdRef.current,
        logicalUrl: logicalUrlRef.current,
        seq: lastSeq.current,
        reset: pendingReset.current || undefined,
        console: pendingConsole.current,
        network: pendingNetwork.current,
      };
      pendingConsole.current = [];
      pendingNetwork.current = [];
      pendingReset.current = false;
      void transport.ingestDevtoolsCapture(sid, batch);
    }

    function schedule(): void {
      if (flushTimer.current !== null) return;
      flushTimer.current = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    }

    function onMessage(ev: MessageEvent): void {
      const frame = iframeRef.current;
      // Source identity is the whole guard (the opaque frame's origin is "null").
      if (!frame || ev.source !== frame.contentWindow) return;
      const data = ev.data as DevtoolsMessage | null;
      if (!data || typeof data !== 'object' || typeof data.__dorkosDevtools !== 'string') return;

      switch (data.__dorkosDevtools) {
        case 'hello':
          // Ack unconditionally — the handshake carries no captured data, and the
          // shim stops retrying after ~5s, so gating the ack on session attach
          // would leave a preview that loads first permanently un-instrumented.
          // The attached-session gate below still keeps unattached CAPTURES from
          // ever relaying.
          frame.contentWindow?.postMessage({ __dorkosDevtools: 'ack' }, '*');
          return;
      }

      // Relay captures only for the attached session — never feed another's
      // buffer (and drop them entirely while no session is attached).
      const sid = sessionIdRef.current;
      if (!sid) return;

      switch (data.__dorkosDevtools) {
        case 'navigated':
          // Mark a navigation boundary and drop stale, not-yet-flushed captures.
          pendingReset.current = true;
          pendingConsole.current = [];
          pendingNetwork.current = [];
          schedule();
          return;
        case 'batch':
          if (Array.isArray(data.console)) pendingConsole.current.push(...data.console);
          if (Array.isArray(data.network)) pendingNetwork.current.push(...data.network);
          if (typeof data.seq === 'number') lastSeq.current = data.seq;
          cap(pendingConsole.current, DEVTOOLS_CONSOLE_BATCH_MAX);
          cap(pendingNetwork.current, DEVTOOLS_NETWORK_BATCH_MAX);
          schedule();
          return;
        case 'capture-result': {
          // A `browser_screenshot` round-trip result. Ingested IMMEDIATELY (no
          // debounce) — the tool call is awaiting this requestId server-side.
          if (typeof data.requestId !== 'string') return;
          const batch: DevtoolsIngest = {
            documentId: documentIdRef.current,
            logicalUrl: logicalUrlRef.current,
            // Reuses the last shim batch seq: `seq` tracks the console/network
            // stream (both arrays are empty here), and the screenshot result is
            // correlated by requestId, not seq. A gap-detection reader should
            // treat this as a repeat of the current watermark, not a new batch.
            seq: lastSeq.current,
            console: [],
            network: [],
            screenshot: {
              requestId: data.requestId,
              ...(typeof data.dataUrl === 'string' ? { dataUrl: data.dataUrl } : {}),
              ...(typeof data.error === 'string' ? { error: data.error } : {}),
            },
          };
          void transport.ingestDevtoolsCapture(sid, batch);
          return;
        }
      }
    }

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, [transport, iframeRef]);

  // Forward `browser_screenshot` capture requests into the preview frame. The
  // stream manager already gates `subscribeSessionEvent` to the ATTACHED
  // session, so a background agent can never trigger a capture of the preview
  // the operator is watching. The rasterizer source rides along (lazy-loaded on
  // first use — see `load-rasterizer.ts`); on a load failure the request is
  // forwarded without it so the shim fails fast with an error result instead of
  // letting the tool time out.
  //
  // KNOWN v1 LIMITATION (multi-preview race): this hook mounts once per open
  // browser document, and the capture request carries no document target, so
  // with several previews open EVERY bridge forwards it and the first ingest
  // wins nondeterministically (single screenshot slot, latest write retained;
  // the awaiting tool resolves on the first result). Acceptable for v1 — a
  // follow-up should target the request by documentId so the agent can choose
  // which preview to capture.
  useEffect(() => {
    return streamManager.subscribeSessionEvent((_sessionId, event) => {
      if (event.type !== 'devtools_capture_request') return;
      const target = iframeRef.current?.contentWindow;
      if (!target) return;
      const forward = (lib?: string): void => {
        // Re-read the ref: the frame may have re-rendered while the lazy
        // rasterizer chunk loaded.
        iframeRef.current?.contentWindow?.postMessage(
          { __dorkosDevtools: 'capture-request', requestId: event.requestId, lib },
          '*'
        );
      };
      loadRasterizerSource().then(forward, () => forward(undefined));
    });
  }, [iframeRef]);
}
