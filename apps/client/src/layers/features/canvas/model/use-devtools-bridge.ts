/** Page-reported DevTools bridge. A generation correlates a frame lifetime; it authenticates no script. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { DevtoolsActionResult, DevtoolsIngest } from '@dorkos/shared/schemas';
import type { UploadFile } from '@dorkos/shared/transport';
import {
  CANVAS_BRIDGE_LIMITS as LIMITS,
  parseCanvasBridgeReport,
} from '@dorkos/shared/canvas-bridge-wire';
import { useSessionId } from '@/layers/entities/session';
import { streamManager } from '@/layers/shared/lib/transport';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { loadRasterizerSource } from '../lib/load-rasterizer';
import { drawFrames, encodeGif, halveFrames, type RecordingFrame } from '../lib/encode-recording';

/** Immutable host facts belonging to one observed frame lifetime. */
interface Lifetime {
  generation: string;
  frame: Window;
  sessionId: string | null;
  documentId: string;
  logicalUrl: string;
  source: string;
  origin: string;
  ready: boolean;
  activation: boolean;
  retired: boolean;
}
interface Pending {
  life: Lifetime;
  kind: 'capture' | 'action' | 'frame';
  capture: boolean;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve?: (data: string | null) => void;
}
interface RecordingJob {
  id: string;
  startRequestId: string;
  activated: boolean;
  reservationTimer?: ReturnType<typeof setTimeout>;
  reservationDeadline: number;
  life: Lifetime;
  startedAt: number;
  frames: string[];
  drawn: RecordingFrame[];
  finishing: boolean;
  cancelled: boolean;
  abort: AbortController;
}
/** Host-resolved eligibility is distinct from the frame's reported origin. */
export interface UseDevtoolsBridgeParams {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  documentId: string;
  logicalUrl: string;
  reloadNonce: number;
  previewOrigin: string | null;
  bridgeEligibility: 'served-document' | 'preview-listener' | null;
  resolvedSource: string | null;
}
/** The bridge's UI signals and its actual iframe load boundary. */
export interface DevtoolsBridge {
  resourceErrorCount: number;
  notePersonNavigated: () => void;
  noteFrameLoaded: () => void;
}
function bytesFile(name: string, type: string, bytes: Uint8Array): UploadFile {
  const buffer = bytes.slice().buffer;
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => buffer };
}
function pngBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const MAX_RECORDING_RESERVATION_MS = 8_000;

type ClaimOptions = { active: boolean; activation?: boolean; keepalive?: boolean; reset?: boolean };

/**
 * Admit bounded page reports only for an eligible, current, initialized frame.
 * Lifetime, pending-request and recording retirement stay in one controller:
 * clearing them atomically prevents an old asynchronous completion from gaining
 * the replacement frame's authority. Splitting their ownership would obscure
 * that ordering in this tightly coupled state machine.
 */
export function useDevtoolsBridge(params: UseDevtoolsBridgeParams): DevtoolsBridge {
  const transport = useTransport();
  const transportRef = useRef(transport);
  useLayoutEffect(() => {
    transportRef.current = transport;
  });
  const [sessionId] = useSessionId();
  const [resourceErrorCount, setResourceErrorCount] = useState(0);
  const life = useRef<Lifetime | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const queue = useRef<DevtoolsIngest | null>(null);
  const queuedSizes = useRef({
    console: [] as number[],
    network: [] as number[],
    entryBytes: 0,
    overheadBytes: 0,
  });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(-1);
  const loadedFrame = useRef<{
    frame: Window;
    source: string;
    reload: number;
    documentId: string;
    logicalUrl: string;
  } | null>(null);
  const observedContext = useRef<{
    frame: Window | null | undefined;
    sessionId: typeof sessionId;
    documentId: string;
    logicalUrl: string;
    source: typeof params.resolvedSource;
    eligibility: typeof params.bridgeEligibility;
    origin: typeof params.previewOrigin;
    reload: number;
  } | null>(null);
  // A page report may retire a lifetime, but only browser/host facts may replace it.
  const awaitingFrameLoad = useRef(false);
  const lastBatchAt = useRef(-Infinity);
  const batchProcessingLoss = useRef(false);
  const job = useRef<RecordingJob | null>(null);
  const resourceCount = useRef(0);
  const resourceRaf = useRef<number | null>(null);
  const claimedDocument = useRef<string | null>(null);
  const personActivationPending = useRef(false);
  const personActedOn = useRef<string | null>(null);
  const currentParams = useRef({ ...params, sessionId });
  const claimChain = useRef<Promise<void>>(Promise.resolve());
  const claimRef = useRef<(options: ClaimOptions) => void>(() => {});
  // Installed listeners stay stable. Their controller functions read current refs,
  // while every asynchronous operation still retains its immutable lifetime.
  const methodsRef = useRef({
    initialize,
    retire,
    consume,
    register,
    eligiblePending,
    refuseRequest,
    live,
    captureFrame,
    valid,
    reportRecordingStart,
    cancelReservation,
    finish,
  });
  useLayoutEffect(() => {
    methodsRef.current = {
      initialize,
      retire,
      consume,
      register,
      eligiblePending,
      refuseRequest,
      live,
      captureFrame,
      valid,
      reportRecordingStart,
      cancelReservation,
      finish,
    };
  });

  const activatedHere = (documentId: string): boolean =>
    personActedOn.current === documentId ||
    useAppStore.getState().openDocuments.some((d) => d.id === documentId && d.openedHere);

  function claim(
    snapshot: Lifetime,
    { active, activation = false, keepalive = false, reset = false }: ClaimOptions
  ): void {
    if (!snapshot.sessionId) return;
    // Snapshot before chaining: delayed delivery must never read a replacement frame's facts.
    const payload: DevtoolsIngest = {
      documentId: snapshot.documentId,
      logicalUrl: snapshot.logicalUrl,
      bridgeGeneration: snapshot.generation,
      seq: Math.max(0, lastSeq.current),
      console: [],
      network: [],
      active,
      activation,
      instrumented: snapshot.ready && !snapshot.retired,
      ...(reset ? { reset: true } : {}),
    };
    claimChain.current = claimChain.current
      .then(() =>
        transportRef.current.ingestDevtoolsCapture(
          snapshot.sessionId!,
          payload,
          keepalive ? { keepalive: true } : undefined
        )
      )
      .catch(() => {});
  }
  function retire(): void {
    const old = life.current;
    if (old) old.retired = true;
    life.current = null;
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    queue.current = null;
    queuedSizes.current = { console: [], network: [], entryBytes: 0, overheadBytes: 0 };
    lastSeq.current = -1;
    lastBatchAt.current = -Infinity;
    batchProcessingLoss.current = false;
    for (const [requestId, entry] of pending.current) {
      if (entry.life.sessionId && entry.deadline > Date.now()) {
        if (entry.kind !== 'frame')
          refuseRequest(
            requestId,
            entry.kind,
            entry.life,
            'The frame changed while this request was pending.'
          );
      }
      clearTimeout(entry.timer);
      entry.resolve?.(null);
    }
    pending.current.clear();
    if (old) claim(old, { active: false });
    const recording = job.current;
    if (recording) {
      clearTimeout(recording.reservationTimer);
      recording.cancelled = true;
      recording.abort.abort();
      recording.frames.length = 0;
      // A finishing helper still owns its pixel buffers until its await unwinds.
      if (!recording.finishing) {
        recording.drawn.length = 0;
        job.current = null;
      }
    }
    if (resourceRaf.current !== null) cancelAnimationFrame(resourceRaf.current);
    resourceRaf.current = null;
    resourceCount.current = 0;
    setResourceErrorCount(0);
  }
  function initialize({
    loadActivation,
    reset = false,
  }: { loadActivation?: boolean; reset?: boolean } = {}): void {
    const p = currentParams.current;
    const frame = p.iframeRef.current?.contentWindow;
    if (awaitingFrameLoad.current || !frame || !p.bridgeEligibility || !p.resolvedSource) return;
    const next: Lifetime = {
      generation: crypto.randomUUID(),
      frame,
      sessionId: p.sessionId,
      documentId: p.documentId,
      logicalUrl: p.logicalUrl,
      source: p.resolvedSource,
      origin: p.bridgeEligibility === 'served-document' ? 'null' : p.previewOrigin!,
      ready: false,
      activation: false,
      retired: false,
    };
    life.current = next;
    const activation =
      loadActivation ??
      (personActivationPending.current ||
        (claimedDocument.current !== next.documentId && activatedHere(next.documentId)));
    next.activation = activation;
    personActivationPending.current = false;
    claimedDocument.current = next.documentId;
    claim(next, { active: true, activation, reset });
    if (
      loadedFrame.current?.frame === frame &&
      loadedFrame.current.source === p.resolvedSource &&
      loadedFrame.current.reload === p.reloadNonce &&
      loadedFrame.current.documentId === p.documentId &&
      loadedFrame.current.logicalUrl === p.logicalUrl
    ) {
      frame.postMessage({ __dorkosDevtools: 'init', bridgeGeneration: next.generation }, '*');
    }
  }
  // Layout observes ref attachment/replacement before any queued message can be admitted.
  useLayoutEffect(() => {
    currentParams.current = { ...params, sessionId };
    const next = {
      frame: params.iframeRef.current?.contentWindow,
      sessionId,
      documentId: params.documentId,
      logicalUrl: params.logicalUrl,
      source: params.resolvedSource,
      eligibility: params.bridgeEligibility,
      origin: params.previewOrigin,
      reload: params.reloadNonce,
    };
    const previous = observedContext.current;
    const changed =
      !previous ||
      Object.keys(next).some(
        (key) => next[key as keyof typeof next] !== previous[key as keyof typeof next]
      );
    if (changed) {
      const pageChanged =
        !previous ||
        previous.frame !== next.frame ||
        previous.documentId !== next.documentId ||
        previous.logicalUrl !== next.logicalUrl ||
        previous.source !== next.source ||
        previous.reload !== next.reload;
      observedContext.current = next;
      awaitingFrameLoad.current = false;
      retire();
      initialize({ reset: pageChanged });
    }
  });
  const noteFrameLoaded = useCallback(() => {
    const { initialize, retire } = methodsRef.current;
    const p = currentParams.current;
    const frame = p.iframeRef.current?.contentWindow;
    const activation = life.current?.ready ? false : life.current?.activation;
    if (frame && p.resolvedSource)
      loadedFrame.current = {
        frame,
        source: p.resolvedSource,
        reload: p.reloadNonce,
        documentId: p.documentId,
        logicalUrl: p.logicalUrl,
      };
    awaitingFrameLoad.current = false;
    retire();
    initialize({ loadActivation: activation, reset: true });
  }, []);
  const notePersonNavigated = useCallback(() => {
    const current = life.current;
    // Address submission can precede signed-source resolution. Keep the person's
    // intent, but publish no claim until an eligible frame lifetime exists.
    personActivationPending.current = true;
    personActedOn.current = currentParams.current.documentId;
    if (current) claimRef.current({ active: true, activation: true });
  }, []);
  useLayoutEffect(() => {
    claimRef.current = (options) => {
      if (life.current) claim(life.current, options);
    };
  });

  function live(snapshot: Lifetime): boolean {
    return life.current === snapshot && !snapshot.retired;
  }
  /** Resolve a host refusal using the request's pinned lifetime, never page data. */
  function refuseRequest(
    requestId: string,
    kind: 'action' | 'capture',
    snapshot: Lifetime,
    error: string
  ): void {
    if (!snapshot.sessionId) return;
    const facts = {
      requestId,
      bridgeGeneration: snapshot.generation,
      documentId: snapshot.documentId,
      hostOutcome: 'host' as const,
      error,
    };
    if (kind === 'action')
      void transportRef.current
        .postDevtoolsAction(snapshot.sessionId, { ...facts, ok: false })
        .catch(() => {});
    else
      void transportRef.current
        .ingestDevtoolsCapture(snapshot.sessionId, {
          ...facts,
          logicalUrl: snapshot.logicalUrl,
          seq: Math.max(0, lastSeq.current),
          console: [],
          network: [],
          screenshot: { requestId, error },
        })
        .catch(() => {});
  }
  function register(
    id: string,
    kind: Pending['kind'],
    snapshot: Lifetime,
    {
      capture = false,
      resolve,
      timeoutMs = 8000,
    }: {
      capture?: boolean;
      resolve?: Pending['resolve'];
      timeoutMs?: number;
    } = {}
  ): Pending | null {
    if (pending.current.size >= LIMITS.pending || pending.current.has(id)) return null;
    const timer = setTimeout(() => releasePending(id, entry), timeoutMs);
    const entry: Pending = {
      kind,
      life: snapshot,
      capture,
      deadline: Date.now() + timeoutMs,
      timer,
      resolve,
    };
    pending.current.set(id, entry);
    return entry;
  }
  /** Only this registration can clear its timer or settle its frame waiter. */
  function releasePending(id: string, entry: Pending): void {
    if (pending.current.get(id) !== entry) return;
    pending.current.delete(id);
    clearTimeout(entry.timer);
    entry.resolve?.(null);
  }
  function eligiblePending(id: string, entry: Pending, snapshot: Lifetime): boolean {
    if (pending.current.get(id) !== entry || entry.life !== snapshot || !live(snapshot))
      return false;
    // Timer dispatch may be delayed; it never extends command eligibility.
    if (Date.now() >= entry.deadline) {
      releasePending(id, entry);
      return false;
    }
    return true;
  }
  function consume(id: string, kind: 'capture' | 'action', snapshot: Lifetime): Pending | null {
    const entry = pending.current.get(id);
    if (
      !entry ||
      entry.life !== snapshot ||
      (entry.kind !== kind && !(kind === 'capture' && entry.kind === 'frame'))
    )
      return null;
    if (!eligiblePending(id, entry, snapshot)) return null;
    pending.current.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  useEffect(() => {
    const { initialize, retire, consume } = methodsRef.current;
    function flush(): void {
      flushTimer.current = null;
      const batch = queue.current;
      queue.current = null;
      queuedSizes.current = { console: [], network: [], entryBytes: 0, overheadBytes: 0 };
      const snapshot = life.current;
      if (
        batch &&
        snapshot &&
        !snapshot.retired &&
        snapshot.sessionId &&
        batch.bridgeGeneration === snapshot.generation
      )
        void transportRef.current.ingestDevtoolsCapture(snapshot.sessionId, batch);
    }
    function onMessage(event: MessageEvent): void {
      const snapshot = life.current;
      if (
        !snapshot ||
        snapshot.retired ||
        event.source !== snapshot.frame ||
        event.origin !== snapshot.origin
      )
        return;
      if (
        loadedFrame.current?.frame !== snapshot.frame ||
        loadedFrame.current.source !== snapshot.source ||
        loadedFrame.current.reload !== currentParams.current.reloadNonce ||
        loadedFrame.current.documentId !== snapshot.documentId ||
        loadedFrame.current.logicalUrl !== snapshot.logicalUrl
      )
        return;
      const raw = event.data as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') return;
      if (
        typeof raw.__dorkosDevtools !== 'string' ||
        ![
          'hello',
          'ready',
          'navigated',
          'resource-error',
          'batch',
          'capture-result',
          'act-result',
        ].includes(raw.__dorkosDevtools)
      )
        return;
      if (raw.__dorkosDevtools !== 'hello' && raw.bridgeGeneration !== snapshot.generation) return;
      const batchTag = raw.__dorkosDevtools === 'batch';
      if (batchTag) {
        // Cheap host facts and the processing budget precede args/Zod/JSON work.
        if (
          !snapshot.ready ||
          !snapshot.sessionId ||
          raw.bridgeGeneration !== snapshot.generation ||
          !Number.isSafeInteger(raw.seq) ||
          (raw.seq as number) < 0 ||
          (raw.seq as number) <= lastSeq.current
        )
          return;
        const now = Date.now();
        if (now - lastBatchAt.current < LIMITS.batchMs) {
          if (queue.current) queue.current.dropped = true;
          else batchProcessingLoss.current = true;
          return;
        }
        lastBatchAt.current = now;
      }
      const report = parseCanvasBridgeReport(raw);
      if (!report) {
        if (batchTag) batchProcessingLoss.current = true;
        return;
      }
      if (report.__dorkosDevtools === 'hello') {
        snapshot.frame.postMessage(
          { __dorkosDevtools: 'init', bridgeGeneration: snapshot.generation },
          '*'
        );
        return;
      }
      if (report.bridgeGeneration !== snapshot.generation) return;
      if (report.__dorkosDevtools === 'ready') {
        if (!snapshot.ready) {
          snapshot.ready = true;
          snapshot.activation = false;
          claim(snapshot, { active: true });
        }
        return;
      }
      if (!snapshot.ready) return;
      if (report.__dorkosDevtools === 'navigated') {
        awaitingFrameLoad.current = true;
        retire();
        return;
      }
      if (report.__dorkosDevtools === 'resource-error') {
        resourceCount.current = Math.min(LIMITS.resourceErrors, resourceCount.current + 1);
        if (resourceRaf.current === null)
          resourceRaf.current = requestAnimationFrame(() => {
            resourceRaf.current = null;
            if (live(snapshot)) setResourceErrorCount(resourceCount.current);
          });
        return;
      }
      if (!snapshot.sessionId) return;
      if (report.__dorkosDevtools === 'batch') {
        if (report.seq <= lastSeq.current) return;
        lastSeq.current = report.seq;
        const batch = queue.current ?? {
          documentId: snapshot.documentId,
          logicalUrl: snapshot.logicalUrl,
          bridgeGeneration: snapshot.generation,
          seq: report.seq,
          console: [],
          network: [],
        };
        batch.seq = report.seq;
        if (batchProcessingLoss.current) batch.dropped = true;
        batchProcessingLoss.current = false;
        const sizes = queuedSizes.current;
        const encoder = new TextEncoder();
        if (!queue.current) {
          // Reserve the longest sequence and drop metadata; arrays include their
          // brackets here, and inter-entry commas are accounted below.
          sizes.overheadBytes = encoder.encode(
            JSON.stringify({
              ...batch,
              seq: Number.MAX_SAFE_INTEGER,
              dropped: true,
              console: [],
              network: [],
            })
          ).length;
        }
        if (sizes.overheadBytes > LIMITS.queueBytes) {
          queue.current = null;
          queuedSizes.current = { console: [], network: [], entryBytes: 0, overheadBytes: 0 };
          batchProcessingLoss.current = true;
          return;
        }
        for (const [key, entries] of [
          ['console', report.console],
          ['network', report.network],
        ] as const) {
          for (const entry of entries) {
            const bytes = encoder.encode(JSON.stringify(entry)).length;
            sizes[key].push(bytes);
            sizes.entryBytes += bytes;
          }
        }
        // These spreads are bounded by prior raw/schema validation.
        batch.console.push(...report.console);
        batch.network.push(...report.network);
        const retainedBytes = () =>
          sizes.overheadBytes +
          sizes.entryBytes +
          Math.max(0, batch.console.length - 1) +
          Math.max(0, batch.network.length - 1);
        while (
          batch.console.length > 500 ||
          batch.network.length > 200 ||
          retainedBytes() > LIMITS.queueBytes
        ) {
          batch.dropped = true;
          const key =
            (batch.console[0]?.timestamp ?? Infinity) <= (batch.network[0]?.timestamp ?? Infinity)
              ? 'console'
              : 'network';
          if (!batch[key].length) break;
          batch[key].shift();
          sizes.entryBytes -= sizes[key].shift()!;
        }
        queue.current = batch;
        if (flushTimer.current === null) flushTimer.current = setTimeout(flush, LIMITS.batchMs);
        return;
      }
      if (report.__dorkosDevtools === 'capture-result') {
        const entry = consume(report.requestId, 'capture', snapshot);
        if (!entry) return;
        if (entry.kind === 'frame') {
          entry.resolve?.(report.dataUrl ?? null);
          return;
        }
        // An accepted result carries pinned host facts through app Transport.
        void transportRef.current.ingestDevtoolsCapture(snapshot.sessionId, {
          bridgeGeneration: snapshot.generation,
          documentId: snapshot.documentId,
          logicalUrl: snapshot.logicalUrl,
          seq: Math.max(0, lastSeq.current),
          console: [],
          network: [],
          hostOutcome: 'page-reported',
          screenshot: { requestId: report.requestId, dataUrl: report.dataUrl, error: report.error },
        });
        return;
      }
      const entry = consume(report.requestId, 'action', snapshot);
      if (!entry) return;
      const recording = job.current;
      const captured =
        entry.capture &&
        report.dataUrl !== undefined &&
        recording !== null &&
        recording.life === snapshot &&
        recording.activated &&
        !recording.finishing &&
        !recording.cancelled &&
        recording.frames.length < 61;
      if (captured) recording.frames.push(report.dataUrl!);
      const { __dorkosDevtools: _marker, dataUrl: _image, ...result } = report;
      // The schema strips page-supplied provenance and host assigns binding/document facts.
      void transportRef.current.postDevtoolsAction(snapshot.sessionId, {
        ...result,
        hostOutcome: 'page-reported',
        documentId: snapshot.documentId,
        captured: captured || undefined,
      } satisfies DevtoolsActionResult);
    }
    window.addEventListener('message', onMessage);
    const refresh = setInterval(() => claimRef.current({ active: true }), 15000);
    const focus = () => {
      if (!life.current) initialize();
      claimRef.current({ active: true, activation: true });
    };
    const hide = () => {
      claimRef.current({ active: false, keepalive: true });
      retire();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') focus();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(refresh);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', focus);
      document.removeEventListener('visibilitychange', visible);
      retire();
    };
  }, []);

  useEffect(
    () =>
      streamManager.subscribeSessionEvent((_sid, event) => {
        if (
          event.type !== 'devtools_capture_request' &&
          event.type !== 'devtools_action_request' &&
          event.type !== 'devtools_recording_request'
        )
          return;
        const {
          register,
          eligiblePending,
          refuseRequest,
          captureFrame,
          valid,
          finish,
          reportRecordingStart,
          cancelReservation,
        } = methodsRef.current;
        const snapshot = life.current;
        if (
          !snapshot?.ready ||
          !snapshot.sessionId ||
          snapshot.retired ||
          event.targetClientId !== transportRef.current.clientId ||
          event.documentId !== snapshot.documentId ||
          event.bridgeGeneration !== snapshot.generation
        )
          return;
        if (event.type === 'devtools_capture_request' || event.type === 'devtools_action_request') {
          const action = event.type === 'devtools_action_request';
          const entry = register(event.requestId, action ? 'action' : 'capture', snapshot, {
            capture: action && !!event.capture,
            timeoutMs:
              action && event.command.action === 'wait_for'
                ? Math.min(10000, event.command.timeoutMs) + 2000
                : 8000,
          });
          if (!entry) {
            // A repeated event still belongs to its existing waiter. Refuse only
            // a new request that the bounded registry cannot admit.
            if (!pending.current.has(event.requestId))
              refuseRequest(
                event.requestId,
                action ? 'action' : 'capture',
                snapshot,
                'Too many browser requests are waiting. Try again when one finishes.'
              );
            return;
          }
          const forward = (lib?: string): void => {
            if (!eligiblePending(event.requestId, entry, snapshot)) return;
            snapshot.frame.postMessage(
              action
                ? {
                    __dorkosDevtools: 'act-request',
                    bridgeGeneration: snapshot.generation,
                    requestId: event.requestId,
                    documentId: snapshot.documentId,
                    command: event.command,
                    ...(event.capture ? { capture: true, lib } : {}),
                  }
                : {
                    __dorkosDevtools: 'capture-request',
                    bridgeGeneration: snapshot.generation,
                    requestId: event.requestId,
                    lib,
                  },
              '*'
            );
          };
          if (!action || event.capture) loadRasterizerSource().then(forward, () => forward());
          else forward();
        }
        if (event.type === 'devtools_recording_request') {
          if (event.action === 'cancel-start') {
            cancelReservation(event.recordingId, event.requestId, snapshot);
            return;
          }
          if (event.action === 'confirm-start') {
            const recording = job.current;
            if (
              !recording ||
              recording.id !== event.recordingId ||
              recording.startRequestId !== event.requestId ||
              recording.life !== snapshot ||
              recording.finishing ||
              !valid(recording)
            )
              return;
            if (!recording.activated) {
              // A delayed timer callback cannot extend first-activation eligibility.
              if (performance.now() >= recording.reservationDeadline) {
                cancelReservation(recording.id, recording.startRequestId, snapshot);
                reportRecordingStart(event, snapshot, {
                  phase: 'started',
                  ok: false,
                  error: 'This recording reservation expired before capture could start.',
                });
                return;
              }
              clearTimeout(recording.reservationTimer);
              recording.activated = true;
              recording.startedAt = Date.now();
              void captureFrame(snapshot).then((data) => {
                if (data && valid(recording)) recording.frames.push(data);
              });
            }
            reportRecordingStart(event, snapshot, { phase: 'started', ok: true });
            return;
          }
          if (event.action === 'start') {
            const timeoutMs = event.reservationTimeoutMs;
            if (
              !Number.isSafeInteger(timeoutMs) ||
              !timeoutMs ||
              timeoutMs < 1 ||
              timeoutMs > MAX_RECORDING_RESERVATION_MS
            ) {
              reportRecordingStart(event, snapshot, {
                phase: 'reserved',
                ok: false,
                error: 'This recording request has no valid reservation timeout.',
              });
              return;
            }
            if (job.current) {
              reportRecordingStart(event, snapshot, {
                phase: 'reserved',
                ok: false,
                error:
                  'Another recording in this window is still running or being saved. Wait for it to finish, then start again.',
              });
              return;
            }
            const recording: RecordingJob = {
              id: event.recordingId,
              startRequestId: event.requestId,
              activated: false,
              reservationDeadline: performance.now() + timeoutMs,
              life: snapshot,
              startedAt: Date.now(),
              frames: [],
              drawn: [],
              finishing: false,
              cancelled: false,
              abort: new AbortController(),
            };
            job.current = recording;
            recording.reservationTimer = setTimeout(() => {
              if (job.current === recording && !recording.activated)
                cancelReservation(recording.id, recording.startRequestId, snapshot);
            }, timeoutMs);
            reportRecordingStart(event, snapshot, { phase: 'reserved', ok: true });
          } else void finish(event.requestId, event.recordingId, snapshot);
        }
      }),
    []
  );

  function reportRecordingStart(
    request: { requestId: string; recordingId: string },
    snapshot: Lifetime,
    outcome: { phase: 'reserved' | 'started'; ok: boolean; error?: string }
  ): void {
    if (!live(snapshot) || !snapshot.sessionId) return;
    void transportRef.current
      .ingestDevtoolsCapture(snapshot.sessionId, {
        hostOutcome: 'host',
        documentId: snapshot.documentId,
        bridgeGeneration: snapshot.generation,
        seq: 0,
        console: [],
        network: [],
        recordingStart: {
          ...outcome,
          requestId: request.requestId,
          recordingId: request.recordingId,
        },
      })
      .catch(() => {});
  }
  function cancelReservation(recordingId: string, requestId: string, snapshot: Lifetime): void {
    const recording = job.current;
    if (
      !recording ||
      recording.id !== recordingId ||
      recording.startRequestId !== requestId ||
      recording.life !== snapshot ||
      recording.finishing
    )
      return;
    clearTimeout(recording.reservationTimer);
    recording.cancelled = true;
    recording.abort.abort();
    recording.frames.length = 0;
    recording.drawn.length = 0;
    for (const [id, entry] of pending.current) {
      if (entry.life === snapshot && entry.kind === 'frame') {
        clearTimeout(entry.timer);
        entry.resolve?.(null);
        pending.current.delete(id);
      }
    }
    job.current = null;
  }
  function valid(recording: RecordingJob): boolean {
    return job.current === recording && !recording.cancelled && live(recording.life);
  }
  function captureFrame(snapshot: Lifetime): Promise<string | null> {
    const requestId = `frame-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      const entry = register(requestId, 'frame', snapshot, { resolve });
      if (!entry) {
        resolve(null);
        return;
      }
      loadRasterizerSource().then(
        (lib) => {
          if (eligiblePending(requestId, entry, snapshot))
            snapshot.frame.postMessage(
              {
                __dorkosDevtools: 'capture-request',
                bridgeGeneration: snapshot.generation,
                requestId,
                lib,
              },
              '*'
            );
        },
        () => {
          releasePending(requestId, entry);
        }
      );
    });
  }
  async function finish(requestId: string, recordingId: string, snapshot: Lifetime): Promise<void> {
    const recording = job.current;
    if (
      !recording ||
      !recording.activated ||
      recording.id !== recordingId ||
      recording.life !== snapshot
    ) {
      if (live(snapshot))
        await transportRef.current
          .uploadDevtoolsRecording(snapshot.sessionId!, {
            requestId,
            bridgeGeneration: snapshot.generation,
            documentId: snapshot.documentId,
            hostOutcome: 'host',
            error: 'The window showing that page stopped recording before it could be saved.',
          })
          .catch(() => {});
      return;
    }
    if (recording.finishing) return;
    recording.finishing = true;
    const assertLive = () => {
      if (!valid(recording)) throw new Error('retired');
    };
    const metadata = {
      requestId,
      bridgeGeneration: snapshot.generation,
      documentId: snapshot.documentId,
    };
    try {
      const last = await captureFrame(snapshot);
      assertLive();
      if (last && recording.frames.length < LIMITS.frames) recording.frames.push(last);
      const keyframe = recording.frames.length
        ? pngBytes(recording.frames[recording.frames.length - 1])
        : new Uint8Array();
      recording.drawn = await drawFrames(recording.frames, 800, assertLive);
      assertLive();
      let encoded = await encodeGif(
        recording.drawn,
        { frameMs: 500, maxBytes: 8 * 1024 * 1024 },
        assertLive
      );
      assertLive();
      if (!encoded.ok && recording.drawn.length) {
        halveFrames(recording.drawn, assertLive);
        encoded = await encodeGif(
          recording.drawn,
          { frameMs: 500, maxBytes: 8 * 1024 * 1024 },
          assertLive
        );
        assertLive();
      }
      if (!encoded.ok) {
        await transportRef.current.uploadDevtoolsRecording(
          snapshot.sessionId!,
          { ...metadata, hostOutcome: 'host', error: encoded.error },
          { signal: recording.abort.signal }
        );
        assertLive();
        return;
      }
      assertLive();
      await transportRef.current.uploadDevtoolsRecording(
        snapshot.sessionId!,
        {
          ...metadata,
          frames: recording.drawn.length,
          durationMs: Date.now() - recording.startedAt,
          recording: bytesFile(`${recordingId}.gif`, 'image/gif', encoded.bytes),
          keyframe: bytesFile(`${recordingId}.png`, 'image/png', keyframe),
        },
        { signal: recording.abort.signal }
      );
      assertLive();
    } catch {
      if (valid(recording))
        await transportRef.current
          .uploadDevtoolsRecording(
            snapshot.sessionId!,
            {
              ...metadata,
              hostOutcome: 'host',
              error: 'This window could not turn that recording into a file.',
            },
            { signal: recording.abort.signal }
          )
          .catch(() => {});
    } finally {
      recording.frames.length = 0;
      recording.drawn.length = 0;
      if (job.current === recording) job.current = null;
    }
  }
  return { resourceErrorCount, notePersonNavigated, noteFrameLoaded };
}
