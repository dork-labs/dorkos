/**
 * The parent side of the DevTools capture bridge (DOR-213).
 *
 * The injected in-page shim (server-side `devtools-shim.ts`) posts its captures
 * to `window.parent` — never to `/api/*`, which would need a CORS hole any page
 * could POST to and would be subject to the previewed page's own CSP. This hook,
 * mounted by `CanvasBrowserContent`, is
 * that parent: it acks the shim's handshake, coalesces its batches, and forwards
 * them to `POST /sessions/:id/devtools/ingest` through the transport — the only
 * same-origin, authenticated party allowed to reach the API.
 *
 * Three guarantees are load-bearing:
 * - **Source identity.** A capture message is accepted only when
 *   `event.source === iframe.contentWindow`, which rejects a nested frame or any
 *   foreign window. Origin cannot do this job: an opaque frame's `event.origin`
 *   is the literal string `"null"`, shared by every opaque frame there is.
 * - **Known origin.** The frame must ALSO report an origin DorkOS instrumented:
 *   `"null"` for a local file served on the DorkOS origin (which renders
 *   opaque), or the exact preview-listener origin minted for THIS document.
 *   Everything else is rejected — including a dev server framed by its own
 *   address, which carries no shim and so cannot drive the bridge by posting
 *   messages that look like the shim's.
 * - **Attached session only.** Captures relay to the session they were CAPTURED
 *   under and no other, so one session's preview can never feed another
 *   session's buffer — including across the 300ms coalescing window, which is
 *   long enough for the operator to switch conversations mid-batch (see
 *   `pendingSessionId`; reading the current session at send time is a bleed, not
 *   a guarantee).
 *   Which session that is comes from {@link useSessionId}, the dual-mode hook —
 *   the URL's `?session=` in the browser and desktop app, the store in the
 *   Obsidian embed. Reading `app-store.sessionId` directly instead is what left
 *   this relay dead everywhere but Obsidian (DOR-1305): only the embedded branch
 *   ever writes that field, so in a browser the gate below never opened and an
 *   agent's `browser_read_console` saw nothing.
 *
 * It also drives the `browser_screenshot` round-trip (DOR-213 Phase 3): a
 * `devtools_capture_request` on the attached session's event stream is
 * forwarded into the frame (with the lazy-loaded rasterizer source riding
 * along), and the shim's `capture-result` is ingested immediately, tagged with
 * its `requestId`, resolving the awaiting tool call server-side.
 *
 * It also counts the resources the current document failed to load and hands
 * that count back to the canvas, which turns it into a banner — a page whose
 * scripts 404 renders blank and otherwise explains nothing.
 *
 * Idle-cheap: one window listener, and no timer runs until a batch actually
 * arrives; the rasterizer chunk downloads only on the first capture request.
 *
 * @module features/canvas/model/use-devtools-bridge
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type {
  DevtoolsConsoleEntry,
  DevtoolsIngest,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import { DEVTOOLS_CONSOLE_BATCH_MAX, DEVTOOLS_NETWORK_BATCH_MAX } from '@dorkos/shared/schemas';
import { useSessionId } from '@/layers/entities/session';
import { streamManager } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { loadRasterizerSource } from '../lib/load-rasterizer';

/** How long to coalesce shim batches before one ingest POST. */
const FLUSH_DEBOUNCE_MS = 300;

/** A message the shim posts to the parent. */
interface DevtoolsMessage {
  __dorkosDevtools?: 'hello' | 'batch' | 'navigated' | 'capture-result' | 'resource-error';
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
  /**
   * Bumped by the browser on every reload. Same document, fresh page — so the
   * failed-resource count starts over with it, as it does on navigation.
   */
  reloadNonce: number;
  /**
   * The one REAL origin allowed to drive this bridge for the current document —
   * the preview listener DorkOS opened for a dev server, which is the only
   * non-opaque frame our shim is injected into. `null` for every other kind of
   * frame, which leaves `'null'` (an opaque origin) as the only accepted source.
   */
  previewOrigin: string | null;
}

/** What the bridge hands back to the canvas. */
export interface DevtoolsBridge {
  /**
   * How many resources (scripts, styles, images) the current document failed to
   * load, as reported by the shim. The canvas turns a non-zero count into a
   * banner, because a page whose scripts 404 renders blank and says nothing.
   *
   * Counts only what an instrumented frame reports — a local file DorkOS served,
   * or a dev server on a DorkOS preview listener. A dev server framed by its own
   * address carries no shim, so it can neither raise this count nor keep it at
   * zero to reassure anybody: the count only ever SHOWS a warning, it never
   * promises a page is fine.
   */
  resourceErrorCount: number;
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
 * @returns What the canvas can show about this preview — see {@link DevtoolsBridge}.
 */
export function useDevtoolsBridge({
  iframeRef,
  documentId,
  logicalUrl,
  reloadNonce,
  previewOrigin,
}: UseDevtoolsBridgeParams): DevtoolsBridge {
  const transport = useTransport();
  // The attached conversation, asked the way every other surface asks: the URL in
  // the browser and desktop app, the store in the Obsidian embed. Never the store
  // alone — see the module doc's third guarantee.
  const [sessionId] = useSessionId();

  // Failed resources for the CURRENT document only. Reset during render rather
  // than in an effect (React's documented "adjusting state when a prop changes"
  // pattern): an effect would let one render paint the previous page's count
  // against the new page.
  const [resourceErrorCount, setResourceErrorCount] = useState(0);
  const documentKey = `${logicalUrl}:${reloadNonce}`;
  const [countedFor, setCountedFor] = useState(documentKey);
  if (countedFor !== documentKey) {
    setCountedFor(documentKey);
    setResourceErrorCount(0);
  }

  // Refs so the single, long-lived window listener always reads current values
  // without being torn down and re-added on every render.
  const sessionIdRef = useRef(sessionId);
  const documentIdRef = useRef(documentId);
  const logicalUrlRef = useRef(logicalUrl);
  const previewOriginRef = useRef(previewOrigin);
  // Keep the refs current for the long-lived listener without re-adding it. Synced
  // in an effect (not during render) so a stale batch never posts under old ids.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    documentIdRef.current = documentId;
    logicalUrlRef.current = logicalUrl;
    previewOriginRef.current = previewOrigin;
  });

  const pendingConsole = useRef<DevtoolsConsoleEntry[]>([]);
  const pendingNetwork = useRef<DevtoolsNetworkEntry[]>([]);
  const pendingReset = useRef(false);
  const lastSeq = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The session the pending captures were captured UNDER, recorded when they are
   * accumulated rather than read when they are sent.
   *
   * The 300ms debounce is a window in which the attached session can change, and
   * for that window the current session and the pending batch's session are two
   * different facts. Reading `sessionIdRef` at fire time answered with the first
   * and posted the second, so a switch mid-window put A's console into B's
   * buffer. `null` means nothing is pending.
   */
  const pendingSessionId = useRef<string | null>(null);

  useEffect(() => {
    /** Relay whatever is pending to the session it was captured under. */
    function flush(): void {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      const sid = pendingSessionId.current;
      pendingSessionId.current = null;
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
      // Two guards, and both are needed.
      //
      // SOURCE IDENTITY rejects any other window — a nested frame, a popup, the
      // opener. It is the only guard that can distinguish windows, because every
      // opaque frame in existence reports the same origin: the string "null".
      //
      // ORIGIN rejects the frame itself when it is not one DorkOS instrumented.
      // Two kinds are: a local file served on the DorkOS origin, which renders
      // opaque and so reports `"null"`, and a dev server on a preview listener,
      // which has a real origin — the exact one the resolve cascade minted for
      // THIS document, and nothing else. A dev server framed by its own address
      // carries no shim, so `previewOrigin` is null for it and anything it posts
      // is the page's own code impersonating the bridge; it is dropped rather
      // than counted or relayed.
      if (!frame || ev.source !== frame.contentWindow) return;
      const allowedOrigin = previewOriginRef.current;
      if (ev.origin !== 'null' && (allowedOrigin === null || ev.origin !== allowedOrigin)) return;
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
        case 'resource-error':
          // Counted before the attached-session gate below: relaying captures
          // to an agent needs a session, but telling the person watching that
          // their page is broken does not.
          setResourceErrorCount((n) => n + 1);
          return;
      }

      // Relay captures only for the attached session — never feed another's
      // buffer (and drop them entirely while no session is attached).
      const sid = sessionIdRef.current;
      if (!sid) return;

      // A conversation switch CLOSES the pending group instead of letting it
      // carry across: whatever was captured under the previous session goes to
      // that session now, before anything captured under this one joins it. The
      // debounce window and a session switch are independent clocks, and this is
      // the only place they are reconciled.
      if (pendingSessionId.current !== null && pendingSessionId.current !== sid) flush();

      switch (data.__dorkosDevtools) {
        case 'navigated':
          // Mark a navigation boundary and drop stale, not-yet-flushed captures.
          pendingSessionId.current = sid;
          pendingReset.current = true;
          pendingConsole.current = [];
          pendingNetwork.current = [];
          schedule();
          return;
        case 'batch':
          pendingSessionId.current = sid;
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

  return { resourceErrorCount };
}
