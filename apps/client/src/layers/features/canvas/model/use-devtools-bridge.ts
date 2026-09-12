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
 * It also drives both server→client round trips: `devtools_capture_request`
 * (`browser_screenshot`, DOR-213 Phase 3) and `devtools_action_request` (the six
 * driving verbs, spec `canvas-agent-seat`). Each is forwarded into the frame —
 * the capture with the lazy-loaded rasterizer source riding along — and the
 * shim's one result is posted back immediately, tagged with its `requestId`,
 * resolving the awaiting tool call server-side.
 *
 * **Which window answers is the SERVER's decision, never this hook's.** One
 * session is routinely open in two windows, so "am I showing the active
 * preview?" has two true answers and cannot arbitrate anything. This hook
 * CLAIMS — it tells the server which page this window is showing, and the
 * server keeps one driver seat per session — and then answers only a request
 * addressed to its own `clientId` and its own `documentId`. Local state produces
 * a claim; the server produces the address.
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
  DevtoolsActionResult,
  DevtoolsConsoleEntry,
  DevtoolsIngest,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import { DEVTOOLS_CONSOLE_BATCH_MAX, DEVTOOLS_NETWORK_BATCH_MAX } from '@dorkos/shared/schemas';
import { useSessionId } from '@/layers/entities/session';
import { streamManager } from '@/layers/shared/lib/transport';
import { useTransport } from '@/layers/shared/model';
import { loadRasterizerSource } from '../lib/load-rasterizer';

/** How long to coalesce shim batches before one ingest POST. */
const FLUSH_DEBOUNCE_MS = 300;

/**
 * How often a window re-reports that it is still showing its browser page.
 *
 * Matches the server's `WORKBENCH.DEVTOOLS_SEAT_REFRESH_MS`, which is itself the
 * session stream's heartbeat cadence — the interval this app has already decided
 * is often enough to notice a window that went away. The server yields a seat
 * that has missed six of these, which is deliberately more than a hidden tab's
 * throttled one-wake-per-minute can miss; the server constant says why.
 */
const SEAT_REFRESH_MS = 15_000;

/** A message the shim posts to the parent. */
interface DevtoolsMessage {
  __dorkosDevtools?:
    'hello' | 'batch' | 'navigated' | 'capture-result' | 'act-result' | 'resource-error';
  seq?: number;
  console?: DevtoolsConsoleEntry[];
  network?: DevtoolsNetworkEntry[];
  /** `capture-result` and `act-result`: the id echoed from the request. */
  requestId?: unknown;
  /** `capture-result`: the rendered PNG data URL on success. */
  dataUrl?: unknown;
  /** `capture-result` and `act-result`: the shim's failure reason. */
  error?: unknown;
  /** `act-result`: whether the page did what it was asked. */
  ok?: unknown;
  /** `act-result`: one line saying what it did. */
  did?: unknown;
  /** `act-result`: how many elements the target matched. */
  matched?: unknown;
  /** `act-result`: which document answered. */
  documentId?: unknown;
  /** `act-result`: where that page is now. */
  page?: unknown;
  /** `act-result`: the accessibility outline, for a read. */
  outline?: unknown;
  /** `act-result`: whether the outline was cut to fit its budget. */
  truncated?: unknown;
  /** `act-result`: how long a wait actually took. */
  waitedMs?: unknown;
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

/**
 * Whether a page summary from the shim is shaped the way the server expects.
 *
 * The value crossed an untrusted page, so it is checked rather than cast: a
 * hostile page may only ever tell the agent something wrong, never post a body
 * the ingest route rejects, which would strand the tool call in a timeout.
 */
function isPageSummary(
  value: unknown
): value is { title: string; url: string; focused: string | null } {
  if (!value || typeof value !== 'object') return false;
  const page = value as { title?: unknown; url?: unknown; focused?: unknown };
  return (
    typeof page.title === 'string' &&
    typeof page.url === 'string' &&
    (page.focused === null || typeof page.focused === 'string')
  );
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
  // Which page is in the frame right now — the URL AND the reload counter, so a
  // reload of the same address counts as a new document, which it is.
  const documentKeyRef = useRef(documentKey);
  // Keep the refs current for the long-lived listener without re-adding it. Synced
  // in an effect (not during render) so a stale batch never posts under old ids.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    documentIdRef.current = documentId;
    logicalUrlRef.current = logicalUrl;
    previewOriginRef.current = previewOrigin;
    documentKeyRef.current = documentKey;
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
  /**
   * Which DOCUMENT the shim last said hello for, or `null` for none.
   *
   * Carried on the seat claim so a driving tool can answer "that page is open
   * but DorkOS is not instrumenting it" at once. An external site and a dev
   * server framed by its own address both render and neither carries the shim,
   * so without this the tool would wait out a whole timeout to say nothing
   * useful.
   *
   * **Keyed rather than a boolean, because a frame outlives its page.** A plain
   * `true` survived a same-tab navigation from an instrumented preview to a page
   * that carries no shim: the seat kept reporting `instrumented: true`, so every
   * driving verb minted a real request and waited out the whole timeout instead
   * of refusing in a sentence. Keying it to the document also settles the order
   * the two signals can arrive in — a `logicalUrl` change that beats the shim's
   * `navigated` message stops matching by itself, with nothing to reset.
   */
  const handshookFor = useRef<string | null>(null);
  /**
   * Claims for this page, serialised. See the claim effect for why the ORDER of
   * two fire-and-forget POSTs is load-bearing.
   */
  const claimChain = useRef<Promise<void>>(Promise.resolve());
  /**
   * Post one claim or release for the CURRENT session.
   *
   * Set by the claim effect and nulled when that effect tears down, so a `hello`
   * arriving after the session changed cannot re-claim a seat under the id the
   * old closure captured. `null` means "there is no session to claim for".
   */
  const claimSeat = useRef<((active: boolean, keepalive?: boolean) => void) | null>(null);

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
        case 'hello': {
          // Ack unconditionally — the handshake carries no captured data, and the
          // shim stops retrying after ~5s, so gating the ack on session attach
          // would leave a preview that loads first permanently un-instrumented.
          // The attached-session gate below still keeps unattached CAPTURES from
          // ever relaying.
          frame.contentWindow?.postMessage({ __dorkosDevtools: 'ack' }, '*');
          // And tell the server this page can be driven. The first claim goes
          // out on mount, before any handshake could have happened, so without
          // this upgrade every page would look un-instrumented forever.
          handshookFor.current = documentKeyRef.current;
          // Through the same chain as every other claim, so the upgrade cannot
          // overtake the mount claim and then be overwritten by it.
          claimSeat.current?.(true);
          return;
        }
        case 'resource-error':
          // Counted before the attached-session gate below: relaying captures
          // to an agent needs a session, but telling the person watching that
          // their page is broken does not.
          setResourceErrorCount((n) => n + 1);
          return;
      }

      // The page in the frame is being replaced, so whatever handshook is going
      // with it. Handled ABOVE the attached-session gate on purpose: telling the
      // server this page can no longer be driven is not about relaying captures,
      // and a window with no conversation attached still has to stop claiming a
      // page it can drive. Re-reporting here rather than waiting for the next
      // beat is what makes the refusal instant.
      if (data.__dorkosDevtools === 'navigated') {
        handshookFor.current = null;
        claimSeat.current?.(true);
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
        case 'act-result': {
          // One driving round trip's answer. Posted the moment it exists, with
          // no debounce: a tool call is awaiting this requestId server-side, and
          // a coalesced answer is an answer that arrives after the timeout.
          if (typeof data.requestId !== 'string') return;
          const result: DevtoolsActionResult = {
            requestId: data.requestId,
            ok: data.ok === true,
            ...(typeof data.did === 'string' ? { did: data.did } : {}),
            ...(typeof data.matched === 'number' ? { matched: data.matched } : {}),
            ...(typeof data.documentId === 'string' ? { documentId: data.documentId } : {}),
            ...(isPageSummary(data.page) ? { page: data.page } : {}),
            ...(typeof data.outline === 'string' ? { outline: data.outline } : {}),
            ...(typeof data.truncated === 'boolean' ? { truncated: data.truncated } : {}),
            ...(typeof data.waitedMs === 'number' ? { waitedMs: data.waitedMs } : {}),
            ...(typeof data.error === 'string' ? { error: data.error } : {}),
          };
          void transport.postDevtoolsAction(sid, result);
          return;
        }
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

  // Claim the driver seat for this page, so the SERVER can address exactly one
  // window (spec `canvas-agent-seat` §2.2).
  //
  // THE RACE THIS CLOSES, and why it is a claim rather than a decision. This
  // hook mounts once per browser document a window is showing, and until now a
  // capture request carried no target at all — so with several previews open,
  // every bridge forwarded it and the first ingest won nondeterministically. The
  // obvious fix, "answer only when my document is the active one", does not
  // work: two windows on one session each hold their own `activeBrowserDocumentId`
  // and each would consider itself addressed. So the window says what it is
  // SHOWING, the server keeps one seat per session, and the answer half below
  // consults neither — it compares the addressed ids to its own.
  //
  // A release is sent when the page closes or this window stops showing it.
  // Deliberately NOT on window blur: a preview does not stop being on screen
  // because somebody switched to another application, and releasing there would
  // answer "no window is showing a preview" while one plainly is.
  useEffect(() => {
    const sid = sessionId;
    if (!sid) return;
    claimSeat.current = (active: boolean, keepalive = false): void => {
      // Claims for one page go out in ORDER, chained on the previous one. Two
      // fire-and-forget POSTs can arrive either way round, and on an in-preview
      // navigation the pair is a release followed by a claim: arriving swapped,
      // the release lands last and the window drops a seat it is still holding.
      // A chain costs nothing here — these are a handful of small POSTs — and it
      // removes the ordering question rather than making it unlikely.
      claimChain.current = claimChain.current
        .then(() =>
          transport.ingestDevtoolsCapture(
            sid,
            {
              documentId: documentIdRef.current,
              logicalUrl: logicalUrlRef.current,
              seq: lastSeq.current,
              console: [],
              network: [],
              active,
              // True only for the page the frame is showing NOW. A handshake
              // that belonged to the page before a navigation is not an answer
              // about this one.
              instrumented: handshookFor.current === documentKeyRef.current,
            },
            keepalive ? { keepalive: true } : undefined
          )
        )
        .catch(() => {
          /* best-effort: a dropped claim is corrected by the next refresh */
        });
    };
    const claim = (active: boolean): void => claimSeat.current?.(active);
    claim(true);

    const onFocus = (): void => claim(true);
    // Re-report on a beat, because a window that is killed, suspended or loses
    // its network never sends a release — and a seat nobody is sitting in makes
    // every verb address a window that no longer answers. The server yields a
    // seat that has missed six of these.
    const refresh = setInterval(() => claim(true), SEAT_REFRESH_MS);
    // The one release a vanishing window CAN still send. `keepalive` is what
    // makes it survive the unload; it is best effort, and the staleness rule
    // above is what makes it not have to work.
    const onPageHide = (): void => claimSeat.current?.(false, true);
    // And the two moments a window comes BACK, where the beat alone is not
    // enough. A tab hidden for more than five minutes has its timers aligned to
    // one wake per minute (Chrome), and a tab restored from the back/forward
    // cache ran no timers at all while it was away — so in both cases the beat
    // that should have reported is late or never happened, and the seat may
    // already have yielded. Re-reporting the instant the page is visible again
    // is what takes it straight back.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') claim(true);
    };
    const onPageShow = (): void => claim(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(refresh);
      claim(false);
      // Unset LAST, so the release above still goes out. A late `hello` from a
      // frame that outlives this effect — the session changed while the preview
      // stayed mounted — would otherwise re-claim the seat under the session id
      // this closure captured, which is no longer the one on screen.
      claimSeat.current = null;
    };
  }, [transport, sessionId, documentId, logicalUrl]);

  // Forward the two server→client round trips into the preview frame.
  //
  // The stream manager already gates `subscribeSessionEvent` to the ATTACHED
  // session, so a background agent can never reach the preview the operator is
  // watching. On top of that, this bridge answers ONLY when the server addressed
  // this window and this document: `targetClientId` and `documentId` are
  // resolved server-side from the driver seat, and a window that is not the one
  // named simply does nothing. A request carrying neither (an older server) is
  // forwarded the way it always was.
  //
  // The rasterizer source rides along with a capture (lazy-loaded on first use —
  // see `load-rasterizer.ts`); on a load failure the request is forwarded
  // without it so the shim fails fast with an error result instead of letting
  // the tool time out.
  useEffect(() => {
    return streamManager.subscribeSessionEvent((_sessionId, event) => {
      if (event.type === 'devtools_capture_request') {
        if (!addressedTo(event.targetClientId, event.documentId)) return;
        if (!iframeRef.current?.contentWindow) return;
        const forward = (lib?: string): void => {
          // Re-read the ref: the frame may have re-rendered while the lazy
          // rasterizer chunk loaded.
          iframeRef.current?.contentWindow?.postMessage(
            { __dorkosDevtools: 'capture-request', requestId: event.requestId, lib },
            '*'
          );
        };
        loadRasterizerSource().then(forward, () => forward(undefined));
        return;
      }
      if (event.type === 'devtools_action_request') {
        if (!addressedTo(event.targetClientId, event.documentId)) return;
        iframeRef.current?.contentWindow?.postMessage(
          {
            __dorkosDevtools: 'act-request',
            requestId: event.requestId,
            documentId: event.documentId,
            command: event.command,
          },
          '*'
        );
      }
    });

    /**
     * Whether the server addressed THIS window and THIS page.
     *
     * Both ids are compared, and `activeBrowserDocumentId` is not consulted at
     * all: re-deriving the arbiter locally is the original bug in a new place.
     */
    function addressedTo(targetClientId?: string, documentId?: string): boolean {
      if (targetClientId !== undefined && targetClientId !== transport.clientId) return false;
      if (documentId !== undefined && documentId !== documentIdRef.current) return false;
      return true;
    }
  }, [iframeRef, transport]);

  return { resourceErrorCount };
}
