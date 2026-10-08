import {
  ViewerTerminalCustody,
  retainViewerCaptureTerminal,
  joinViewerCaptureTerminal,
  joinViewerCaptureTerminals,
} from './viewer-terminal-custody.js';
import type {
  PrivateViewerSampleObserver,
  PrivateViewerCensusObserver,
} from '../runtime/private-native-acceptance.js';
import { randomBytes } from 'node:crypto';
import {
  originalCaptureCancellation,
  isOriginalCaptureCancellation,
} from './capture-cancellation.js';
import type {
  PrivateBrowserCaptureDispatcher,
  OwnedCaptureAuthorization,
} from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserFrameSchema,
  BrowserFramePointerEnvelopeSchema,
  BrowserFrameAcknowledgmentSchema,
  type BrowserBinding,
  type BrowserFramePointerEnvelope,
} from '@dorkos/shared/browser-schemas';

/** Constructor-private host proof. Neither a wire ticket nor a grant projection creates this proof. */
export interface OriginalViewerAdmission {
  readonly actorIdentity: object;
  readonly grantIdentity?: object;
  readonly binding: BrowserBinding;
  /** Original fresh authenticated session, exact original engine and grant revision checks. */
  refresh(): Promise<void>;
  /** Synchronous original authority fence, including feature and scope currentness. */
  current(): boolean;
}

type Frame = {
  readonly metadata: BrowserFramePointerEnvelope;
  readonly bytes: Uint8Array;
};
type Viewer = {
  readonly id: string;
  readonly token: string;
  readonly origin: string;
  readonly actorIdentity: object;
  readonly grantIdentity?: object;
  readonly refresh: OriginalViewerAdmission['refresh'];
  readonly current: OriginalViewerAdmission['current'];
  readonly binding: BrowserBinding;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  sequence: number;
  busy: boolean;
  work?: Promise<void>;
  closed: boolean;
  pending?: Frame;
  encodingMs: number | null;
  droppedFrames: number;
};

/** Bounded viewer refusal category without browser data or permission claims. */
export class ViewerRefusal extends Error {
  constructor(readonly reason: 'authority' | 'receipt' | 'capacity' | 'capture') {
    super(reason);
  }
}

const equal = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);

/** Freeze separate canonical CSS/raster/pointer scalars; returned envelopes share no mutable custody. */
function freezeEnvelope(value: BrowserFramePointerEnvelope): BrowserFramePointerEnvelope {
  return Object.freeze({
    frame: Object.freeze({
      ...value.frame,
      binding: Object.freeze({ ...value.frame.binding }),
    }),
    geometry: Object.freeze({
      ...value.geometry,
      cssViewport: Object.freeze({ ...value.geometry.cssViewport }),
      raster: Object.freeze({ ...value.geometry.raster }),
    }),
    pointer: value.pointer ? Object.freeze({ ...value.pointer }) : null,
  });
}

/** Disposable pull subscriptions: one unacknowledged frame per viewer, no durable replay. */
export class BrowserPixelSubscriptions {
  private readonly viewers = new Map<string, Viewer>();
  private readonly maximumViewers: number;
  private readonly terminals = new ViewerTerminalCustody();
  private readonly work = new Set<Promise<Frame>>();
  private readonly navigationFences = new Map<string, BrowserBinding>();
  private readonly workBindings = new Map<Promise<Frame>, BrowserBinding>();
  private readonly capture: PrivateBrowserCaptureDispatcher['capture'];
  private readonly observeViewer?: PrivateViewerSampleObserver;
  private readonly sampleTimer?: ReturnType<typeof setInterval>;
  private observationFailure?: Readonly<{ value: unknown }>;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    engine: Pick<PrivateBrowserCaptureDispatcher, 'capture'>,
    observer?: PrivateViewerSampleObserver,
    private readonly observeCensus?: PrivateViewerCensusObserver,
    viewersPerBrowser?: number
  ) {
    const limit = viewersPerBrowser ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16)
      throw new ViewerRefusal('capacity');
    this.maximumViewers = limit;
    this.capture = engine.capture.bind(engine);
    this.observeViewer = observer;
    this.sampleCensus();
    if (observer || observeCensus) {
      this.sampleTimer = setInterval(() => {
        try {
          this.sampleCensus();
          for (const viewer of this.viewers.values()) this.sampleOriginal(viewer);
        } catch (value) {
          this.observationFailure ??= { value };
          void this.close().catch(() => {});
        }
      }, 1000);
      this.sampleTimer.unref();
    }
  }

  private sampleCensus(): void {
    this.observeCensus?.(
      Object.freeze({ at: Date.now(), subscriptions: this.viewers.size, closed: this.closed })
    );
  }

  private sampleOriginal(viewer: Viewer): void {
    if (!this.observeViewer) return;
    if (this.observationFailure) throw this.observationFailure.value;
    try {
      this.observeViewer(
        Object.freeze({
          at: Date.now(),
          binding: Object.freeze({ ...viewer.binding }),
          viewerId: viewer.id,
          pendingFrames: viewer.pending ? 1 : 0,
          pendingBytes: viewer.pending?.bytes.byteLength ?? 0,
          encodingMs: viewer.encodingMs,
          droppedFrames: viewer.droppedFrames,
          closed: viewer.closed,
        })
      );
    } catch (value) {
      this.observationFailure ??= { value };
      throw value;
    }
  }

  /** Private dispatch correlation only. Membership does not admit a viewer or bypass original proof. */
  ownsTicket(token: string): boolean {
    return !this.closed && (this.viewers.has(token) || this.terminals.has(token));
  }

  /** Called only by the private authenticated host after genuine origin/CSRF admission. */
  issue(proof: OriginalViewerAdmission, admittedOrigin: string) {
    if (this.observationFailure) throw this.observationFailure.value;
    if (
      this.closed ||
      this.viewers.size >= this.maximumViewers ||
      this.viewers.size + this.terminals.size >= 64
    )
      throw new ViewerRefusal('capacity');
    const binding = Object.freeze(BrowserBindingSchema.parse(proof.binding));
    const refresh = proof.refresh.bind(proof),
      current = proof.current.bind(proof);
    const actorIdentity = proof.actorIdentity,
      grantIdentity = proof.grantIdentity;
    // Observe every fallible proof getter before the final original authority callback.
    const finalActorIdentity = proof.actorIdentity;
    const finalGrantIdentity = proof.grantIdentity;
    const id = randomBytes(18).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    const admitted = current();
    const expiresAt = Date.now() + 30_000;
    // Only captured scalars and private state are compared after the final callbacks.
    if (
      !admittedOrigin ||
      !admitted ||
      this.closed ||
      !this.navigationAdmitted(binding) ||
      this.viewers.size >= this.maximumViewers ||
      this.viewers.size + this.terminals.size >= 64 ||
      finalActorIdentity !== actorIdentity ||
      finalGrantIdentity !== grantIdentity
    )
      throw new ViewerRefusal('authority');
    const timer = setTimeout(() => this.disconnect(token), 30_000);
    timer.unref();
    const viewer: Viewer = {
      id,
      token,
      origin: admittedOrigin,
      actorIdentity,
      grantIdentity,
      refresh,
      current,
      binding,
      expiresAt,
      timer,
      sequence: -1,
      encodingMs: null,
      droppedFrames: 0,
      busy: false,
      closed: false,
    };
    this.viewers.set(token, viewer);
    try {
      this.sampleOriginal(viewer);
      this.sampleCensus();
      // A private observer may synchronously revoke original authority.
      this.admitted(viewer, admittedOrigin);
    } catch (value) {
      this.disconnect(token);
      throw value;
    }
    return Object.freeze({ viewerId: id, binding, expiresAt, token });
  }

  private admitted(viewer: Viewer, origin: string): void {
    const current = viewer.current();
    const time = Date.now();
    const navigationAdmitted = this.navigationAdmitted(viewer.binding);
    if (
      !current ||
      this.closed ||
      viewer.closed ||
      !navigationAdmitted ||
      this.viewers.get(viewer.token) !== viewer ||
      time >= viewer.expiresAt ||
      origin !== viewer.origin
    ) {
      const error = new ViewerRefusal('authority');
      // Only this original viewer's actual local revocation is a canceled work outcome.
      if (
        origin === viewer.origin &&
        (current === false ||
          this.closed ||
          viewer.closed ||
          !navigationAdmitted ||
          this.viewers.get(viewer.token) !== viewer ||
          time >= viewer.expiresAt)
      )
        originalCaptureCancellation(error);
      this.disconnect(viewer.token);
      throw error;
    }
  }

  /** Host freshly verifies the incoming actor before passing its original opaque identity.
   * Tokens alone never authorize delivery; they belong in private bodies/headers, never durable URLs. */
  next(
    token: string,
    origin: string,
    authenticatedIdentity: object,
    priorReceipt?: unknown
  ): Promise<Frame> {
    if (this.observationFailure) return Promise.reject(this.observationFailure.value);
    const viewer = this.viewers.get(token);
    if (!viewer || viewer.actorIdentity !== authenticatedIdentity)
      return Promise.reject(new ViewerRefusal('authority'));
    try {
      this.admitted(viewer, origin);
      // Retained originals remain charged after viewer disconnect until natural settlement.
      if (viewer.busy || this.work.size >= 16) throw new ViewerRefusal('capacity');
      viewer.busy = true;
    } catch (error) {
      return Promise.reject(error);
    }
    // Enter retained original work before any asynchronous or fallible acquisition callback.
    const operation = Promise.resolve().then(() => this.acquire(viewer, origin, priorReceipt));
    const terminal = retainViewerCaptureTerminal(operation);
    viewer.work = terminal;
    this.work.add(operation);
    this.workBindings.set(operation, viewer.binding);
    void operation.then(
      () => this.settled(viewer, operation, terminal),
      () => this.settled(viewer, operation, terminal)
    );
    return operation;
  }

  private settled(viewer: Viewer, operation: Promise<Frame>, terminal: Promise<void>): void {
    viewer.busy = false;
    if (viewer.work === terminal) viewer.work = undefined;
    this.work.delete(operation);
    this.workBindings.delete(operation);
  }

  private async acquire(viewer: Viewer, origin: string, priorReceipt: unknown): Promise<Frame> {
    try {
      await viewer.refresh();
      this.admitted(viewer, origin);
      if (viewer.pending) {
        const ack = BrowserFrameAcknowledgmentSchema.safeParse({
          frame: viewer.pending.metadata.frame,
          receipt: priorReceipt,
        });
        if (!ack.success) throw new ViewerRefusal('receipt');
        // Validate against the actual prior server-held frame, never a caller-supplied frame.
        viewer.pending = undefined;
        this.sampleOriginal(viewer);
      } else if (priorReceipt !== undefined) throw new ViewerRefusal('receipt');
      // Wire preflight can encounter a reentrant proxy descriptor trap; never start a producer
      // after authority changed during receipt inspection.
      this.admitted(viewer, origin);
      const authority: OwnedCaptureAuthorization = Object.freeze({
        isCurrent: () => {
          try {
            this.admitted(viewer, origin);
            return true;
          } catch (error) {
            if (isOriginalCaptureCancellation(error)) return false;
            throw error;
          }
        },
        authorize: async (binding: BrowserBinding, signal: AbortSignal) => {
          if (!equal(binding, viewer.binding) || signal.aborted) return 'refused';
          await viewer.refresh();
          try {
            this.admitted(viewer, origin);
          } catch {
            return 'refused';
          }
          return signal.aborted ? 'refused' : 'allowed';
        },
      });
      const capture = await this.capture(
        {
          requestId: randomBytes(18).toString('base64url'),
          binding: viewer.binding,
        },
        authority
      );
      const receipt = capture.receipt;
      if (this.observeViewer) {
        const elapsed = capture.encodingMilliseconds;
        if (elapsed === undefined || !Number.isFinite(elapsed) || elapsed < 0)
          throw new Error('PRIVATE_ACCEPTANCE_ORIGINAL_ENCODING_REQUIRED');
        viewer.encodingMs = elapsed;
      }
      if (
        !equal(receipt.binding, viewer.binding) ||
        receipt.captureSequence <= viewer.sequence ||
        capture.bytes.byteLength !== receipt.byteLength ||
        capture.bytes.byteLength > 2 * 1024 * 1024
      )
        throw new ViewerRefusal('capture');
      const parsedMetadata = BrowserFrameSchema.parse({
        binding: viewer.binding,
        viewerId: viewer.id,
        frameId: randomBytes(18).toString('base64url'),
        sequence: receipt.captureSequence,
        width: receipt.width,
        height: receipt.height,
        byteLength: receipt.byteLength,
        format: receipt.format,
      });
      const metadata = freezeEnvelope(
        BrowserFramePointerEnvelopeSchema.parse({
          frame: parsedMetadata,
          geometry: {
            cssViewport: { width: receipt.width, height: receipt.height },
            raster: {
              width: receipt.rasterWidth,
              height: receipt.rasterHeight,
              format: receipt.format,
            },
            scaleX: receipt.rasterWidth / receipt.width,
            scaleY: receipt.rasterHeight / receipt.height,
          },
          pointer: receipt.pointer,
        })
      );
      // Copy only after the producer's bound is established; authority rechecked before publication.
      const frame = Object.freeze({
        metadata,
        bytes: new Uint8Array(capture.bytes),
      });
      await viewer.refresh();
      this.admitted(viewer, origin);
      viewer.sequence = metadata.frame.sequence;
      viewer.pending = frame;
      this.sampleOriginal(viewer);
      this.admitted(viewer, origin);
      // The delivered envelope and bytes cannot mutate the private prior-frame correlation.
      return Object.freeze({
        metadata: freezeEnvelope(metadata),
        bytes: new Uint8Array(frame.bytes),
      });
    } catch (error) {
      this.disconnect(viewer.token);
      throw error;
    }
  }

  /** Constructor-private response lease, from exact incoming actor and server-held prior frame.
   * It carries no wire representation; cleanup never grants or resets controller authority. */
  publication(token: string, origin: string, identity: object, expectedFrame?: unknown) {
    const viewer = this.viewers.get(token);
    if (!viewer || viewer.actorIdentity !== identity) throw new ViewerRefusal('authority');
    const frame = expectedFrame === undefined ? undefined : BrowserFrameSchema.parse(expectedFrame);
    const check = () => {
      this.admitted(viewer, origin);
      const pending = viewer.pending?.metadata.frame;
      if (
        frame
          ? !pending ||
            !equal(frame.binding, pending.binding) ||
            frame.viewerId !== pending.viewerId ||
            frame.frameId !== pending.frameId ||
            frame.sequence !== pending.sequence ||
            frame.width !== pending.width ||
            frame.height !== pending.height ||
            frame.byteLength !== pending.byteLength ||
            frame.format !== pending.format
          : pending !== undefined
      )
        throw new ViewerRefusal('authority');
    };
    check();
    let consumed = false;
    return Object.freeze({
      publish: (effect: () => void) => {
        // A private publication lease permits only one original response effect.
        if (consumed) throw new ViewerRefusal('authority');
        consumed = true;
        // Serialization/header/client observations must precede this last original authority fence.
        check();
        effect();
      },
      cancel: () => {
        if (this.viewers.get(token) === viewer) this.disconnect(token);
      },
    });
  }

  /** Private custody observation only; the count never supplies viewer/engine permission. */
  viewerCount(): number {
    return this.viewers.size;
  }

  /** Private host has freshly verified this incoming original identity before disconnect. */
  disconnectFor(token: string, authenticatedIdentity: object): Promise<void> {
    const viewer = this.viewers.get(token),
      retired = this.terminals.get(token);
    const original = viewer ?? retired;
    if (this.closed || !original || original.actorIdentity !== authenticatedIdentity)
      throw new ViewerRefusal('authority');
    // A fresh original host identity was verified before this call. Only exact terminal
    // cleanup is consumed here; next/publication still require the original live viewer.
    const pending = original.work;
    if (viewer) this.disconnect(token);
    this.terminals.consume(token);
    // Renewal may admit a successor only after this viewer's exact original capture
    // returns. Internal disconnect remains synchronous so acquisition cannot join itself.
    return joinViewerCaptureTerminal(pending);
  }

  /** Disconnect clears only viewer pixels/timer; it never revokes a grant or controller. */
  disconnect(token: string): void {
    const viewer = this.viewers.get(token);
    if (!viewer) return;
    viewer.closed = true;
    if (!this.closed) this.terminals.retainCapture(token, viewer);
    if (viewer.pending) viewer.droppedFrames++;
    viewer.pending = undefined;
    this.viewers.delete(token);
    clearTimeout(viewer.timer);
    try {
      this.sampleCensus();
    } catch (value) {
      this.observationFailure ??= { value };
    }
    try {
      this.sampleOriginal(viewer);
    } catch (value) {
      this.observationFailure ??= { value };
    }
  }

  private navigationKey(binding: BrowserBinding): string {
    return JSON.stringify([binding.browserId, binding.browserGeneration, binding.tabId]);
  }

  private navigationAdmitted(binding: BrowserBinding): boolean {
    const fenced = this.navigationFences.get(this.navigationKey(binding));
    return (
      !fenced ||
      (binding.navigationGeneration > fenced.navigationGeneration &&
        binding.epoch > fenced.epoch &&
        binding.inputGeneration > fenced.inputGeneration)
    );
  }

  /** Original navigation fences every viewer of this exact immutable tab lifetime. */
  bindingLost(binding: BrowserBinding): Promise<void> {
    const exact = Object.freeze(BrowserBindingSchema.parse(binding));
    const id = this.navigationKey(exact),
      prior = this.navigationFences.get(id);
    if (
      !prior ||
      exact.navigationGeneration > prior.navigationGeneration ||
      (exact.navigationGeneration === prior.navigationGeneration && exact.epoch >= prior.epoch)
    )
      this.navigationFences.set(id, exact);
    const matching = (original: BrowserBinding) =>
      original.browserId === binding.browserId &&
      original.browserGeneration === binding.browserGeneration &&
      original.tabId === binding.tabId;
    const originals = [...this.workBindings]
      .filter(([, original]) => matching(original))
      .map(([operation]) => operation);
    for (const viewer of this.viewers.values()) {
      const original = viewer.binding;
      if (matching(original)) {
        this.terminals.retainNavigation(viewer.token, viewer);
        this.disconnect(viewer.token);
      }
    }

    // Publication refusal after the synchronous viewer fence is expected. This joins
    // the original server acquisition; the engine separately joins raw native captures.
    return Promise.allSettled(originals).then(() => undefined);
  }

  /** Called with exact originals by trusted host loss producers, never with wire identities. */
  identityLost(identity: object): void {
    for (const viewer of this.viewers.values())
      if (viewer.actorIdentity === identity) this.disconnect(viewer.token);
  }

  grantLost(identity: object): void {
    for (const viewer of this.viewers.values())
      if (viewer.grantIdentity === identity) this.disconnect(viewer.token);
  }

  /** Fence admission synchronously; retain every entered original capture through natural settlement. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.terminals.clear();
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending = [...this.work];
    for (const token of this.viewers.keys()) this.disconnect(token);
    void joinViewerCaptureTerminals(pending, () => this.observationFailure).then(resolve, reject);
    return this.closing;
  }
}
