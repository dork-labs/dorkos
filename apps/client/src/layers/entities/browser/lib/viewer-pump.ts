import { readBrowserFrameBody } from '@/layers/shared/lib/browser-frame';
import {
  BrowserBindingSchema,
  BrowserViewerSchema,
  type BrowserBinding,
  type BrowserViewer,
  type BrowserRenderReceipt,
} from '@dorkos/shared/browser-schemas';
import {
  BrowserPixelRenderer,
  BrowserPixelRenderRefusal,
  type BrowserPixelPresentation,
} from './pixel-renderer';

import type { BrowserViewerTransport } from '@dorkos/shared/transport';
/** Private entity alias of the supplemental semantic transport seam; no mount or permission. */
export type BrowserViewerDeliveryPort = BrowserViewerTransport;
/** Private issuance descriptor alias; ticket remains transient transport correlation. */
export type { BrowserViewerAdmission } from '@dorkos/shared/transport';
/** Local presentation lifetime only; opaque identity equality confers no server authority. */
export interface BrowserViewerContext {
  readonly identity: object;
  readonly binding: BrowserBinding;
}
/** Disposable viewer admission/lifetime refusal, unrelated to server permission. */
export class BrowserViewerPumpRefusal extends Error {
  constructor(readonly reason: 'stale' | 'capacity' | 'admission') {
    super(reason);
  }
}
const same = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);

// Reserve cleanup time before the server removes the original expired token. This is a
// local replacement schedule, never an extension or a retry hint from an HTTP refusal.
const renewalLead = 1000;

/** One ephemeral viewer serially reads/draws and submits only the exact original drawn receipt. */
export class BrowserViewerPump {
  private static readonly active = new Set<BrowserViewerPump>();
  private readonly binding: BrowserBinding;
  private readonly identity: object;
  private controller = new AbortController();
  private renewing = false;
  private replacing = false;
  private readonly replacementReason = Object.freeze(
    new Error('original viewer disposal requested')
  );
  private expiryReason: object = Object.freeze(new Error('original viewer lease replacement due'));
  private readonly issueOriginal: BrowserViewerDeliveryPort['issueBrowserViewer'];
  private readonly nextOriginal: BrowserViewerDeliveryPort['nextBrowserViewerFrame'];
  private readonly disconnectOriginal: BrowserViewerDeliveryPort['disconnectBrowserViewer'];
  private readonly clearWidth: () => void;
  private readonly clearHeight: () => void;
  private readonly onLoss: () => void;
  private readonly removeLossOriginal: () => void;
  private hasPresentation = false;
  private viewer?: BrowserViewer;
  private ticket?: string;
  private renderOriginal?: BrowserPixelRenderer['render'];
  private closeRendererOriginal?: BrowserPixelRenderer['close'];
  private presentationOriginal?: BrowserPixelRenderer['presentation'];
  private rendererCleanupOriginal?: BrowserPixelRenderer['cleanupObservation'];
  private rendererClosing?: Promise<void>;
  private disconnectEntered?: Promise<void>;
  private expiry?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private failed = false;
  private first: unknown;
  private resourceCleanup?: { readonly reason: unknown };
  private resourceSettled = false;
  private leaseCleanupFailed = false;
  private leaseCleanupFirst: unknown;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    port: BrowserViewerDeliveryPort,
    private readonly readContext: () => BrowserViewerContext | undefined,
    private readonly lossSignal: AbortSignal,
    private readonly onPresentation: (
      presentation: BrowserPixelPresentation | undefined,
      viewer: BrowserViewer | undefined,
      receipt?: BrowserRenderReceipt
    ) => void = () => undefined,
    private readonly drawAfterOriginalInput: (
      draw: () => void,
      signal: AbortSignal
    ) => Promise<void> = async (draw) => draw()
  ) {
    const context = readContext();
    if (!context || typeof context.identity !== 'object' || context.identity === null)
      throw new BrowserViewerPumpRefusal('admission');
    this.binding = Object.freeze(BrowserBindingSchema.parse(context.binding));
    this.identity = context.identity;
    this.issueOriginal = port.issueBrowserViewer.bind(port);
    this.nextOriginal = port.nextBrowserViewerFrame.bind(port);
    this.disconnectOriginal = port.disconnectBrowserViewer.bind(port);
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!.set!;
    const height = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height')!.set!;
    this.clearWidth = () => width.call(canvas, 0);
    this.clearHeight = () => height.call(canvas, 0);
    this.onLoss = () => {
      this.failure(lossSignal.reason);
      this.fence();
    };
    const addLoss = lossSignal.addEventListener.bind(lossSignal);
    const removeLoss = lossSignal.removeEventListener.bind(lossSignal);
    this.removeLossOriginal = () => removeLoss('abort', this.onLoss);
    addLoss('abort', this.onLoss, { once: true });
    if (lossSignal.aborted) this.onLoss();
  }
  private failure(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.first = error;
    }
  }
  private resourceFailure(error: unknown): void {
    this.resourceCleanup ??= { reason: error };
  }
  private leaseCleanupFailure(error: unknown): void {
    this.resourceFailure(error);
    if (!this.leaseCleanupFailed) {
      this.leaseCleanupFailed = true;
      this.leaseCleanupFirst = error;
    }
  }
  private current(checkExpiry = true): void {
    if (this.closed || this.lossSignal.aborted)
      throw this.replacing && !this.lossSignal.aborted
        ? this.replacementReason
        : new BrowserViewerPumpRefusal('stale');
    const context = this.readContext();
    if (
      !context ||
      context.identity !== this.identity ||
      !same(BrowserBindingSchema.parse(context.binding), this.binding) ||
      this.closed ||
      this.lossSignal.aborted
    )
      throw new BrowserViewerPumpRefusal('stale');
    if (
      checkExpiry &&
      (this.renewing ||
        (this.viewer && Date.now() >= Date.parse(this.viewer.expiresAt) - renewalLead))
    ) {
      this.expireLease();
      throw this.expiryReason;
    }
  }
  private expectedStopFailure(error: unknown): boolean {
    return (
      (this.renewing && error === this.expiryReason) ||
      (this.replacing && !this.lossSignal.aborted && error === this.replacementReason) ||
      ((this.renewing || (this.replacing && !this.lossSignal.aborted)) &&
        error instanceof BrowserPixelRenderRefusal &&
        error.reason === 'stale')
    );
  }
  private expireLease(): void {
    if (this.closed || this.renewing) return;
    this.renewing = true;
    this.hasPresentation = false;
    for (const effect of [
      this.clearWidth,
      this.clearHeight,
      () => this.onPresentation(undefined, undefined),
      () => this.controller.abort(this.expiryReason),
    ]) {
      try {
        effect();
      } catch (error) {
        this.resourceFailure(error);
        this.failure(error);
      }
    }
    this.cleanup();
    if (this.failed) this.fence();
  }
  private observe(
    promise: Promise<void>,
    rendererExpiryCleanup = false,
    leaseCleanup = false
  ): Promise<void> {
    void promise.catch((error: unknown) => {
      if (leaseCleanup) this.leaseCleanupFailure(error);
      else if (!rendererExpiryCleanup || !this.expectedStopFailure(error)) this.failure(error);
    });
    return promise;
  }
  private cleanup(): void {
    if (this.closeRendererOriginal && !this.rendererClosing) {
      try {
        this.rendererClosing = this.observe(this.closeRendererOriginal(), true);
      } catch (error) {
        this.resourceFailure(error);
        this.failure(error);
        this.rendererClosing = this.observe(Promise.reject(error));
      }
    }
    if (this.ticket !== undefined && !this.disconnectEntered) {
      const ticket = this.ticket;
      this.ticket = undefined;
      this.disconnectEntered = this.observe(
        Promise.resolve().then(() => this.disconnectOriginal(ticket)),
        false,
        true
      );
    }
  }
  private fence(): void {
    const newlyClosed = !this.closed;
    this.closed = true;
    // Each original cleanup is entered independently; a falsy removal refusal cannot stop clear/join.
    for (const cleanup of [
      this.removeLossOriginal,
      () => {
        if (this.expiry !== undefined) {
          clearTimeout(this.expiry);
          this.expiry = undefined;
        }
      },
      () =>
        this.controller.abort(
          this.failed
            ? this.first
            : this.replacing
              ? this.replacementReason
              : new BrowserViewerPumpRefusal('stale')
        ),
      this.clearWidth,
      this.clearHeight,
    ]) {
      try {
        cleanup();
      } catch (error) {
        this.resourceFailure(error);
        this.failure(error);
      }
    }
    if (newlyClosed) {
      try {
        this.onPresentation(undefined, undefined);
      } catch (error) {
        this.resourceFailure(error);
        this.failure(error);
      }
    }
    this.cleanup();
  }
  private armExpiry(): void {
    const remaining = Date.parse(this.viewer!.expiresAt) - renewalLead - Date.now();
    if (remaining <= 0) {
      this.expireLease();
      return;
    }
    // Viewer expiry fences presentation; this is not an alternative HTTP request timeout.
    this.expiry = setTimeout(
      () => {
        this.expiry = undefined;
        if (!this.closed) this.armExpiry();
      },
      Math.min(remaining, 2147483647)
    );
  }
  private async run(): Promise<void> {
    try {
      while (!this.closed) {
        this.current(false);
        try {
          const admission = await this.issueOriginal(this.binding, this.controller.signal);
          // Remember a valid ticket first, so a malformed/stale public descriptor still disconnects it.
          const ticket = admission.ticket;
          if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket))
            throw new BrowserViewerPumpRefusal('admission');
          this.ticket = ticket;
          const parsed = BrowserViewerSchema.parse(admission.viewer);
          if (Date.parse(parsed.expiresAt) - renewalLead <= Date.now())
            throw new BrowserViewerPumpRefusal('admission');
          this.viewer = Object.freeze({ ...parsed, binding: Object.freeze({ ...parsed.binding }) });
          if (!same(this.viewer.binding, this.binding))
            throw new BrowserViewerPumpRefusal('admission');
          this.current();
          const renderer = new BrowserPixelRenderer(
            this.canvas,
            this.viewer,
            () => {
              this.current();
              return this.viewer;
            },
            (error) => this.leaseCleanupFailure(error),
            (draw, signal) =>
              this.drawAfterOriginalInput(draw, AbortSignal.any([signal, this.controller.signal]))
          );
          this.renderOriginal = renderer.render.bind(renderer);
          this.closeRendererOriginal = renderer.close.bind(renderer);
          this.presentationOriginal = renderer.presentation.bind(renderer);
          this.rendererCleanupOriginal = renderer.cleanupObservation.bind(renderer);
          this.armExpiry();
          let priorReceipt: BrowserRenderReceipt | undefined;
          while (!this.closed && !this.renewing) {
            this.current();
            const entered = this.nextOriginal(
              this.ticket!,
              priorReceipt,
              this.controller.signal,
              (error) => this.leaseCleanupFailure(error)
            );
            priorReceipt = undefined;
            const body = await entered;
            // Even a late body after loss is owned/cancelled by the original bounded reader.
            const frame = await readBrowserFrameBody(body, this.controller.signal, (error) =>
              this.leaseCleanupFailure(error)
            );
            try {
              this.current();
              const drawn = await this.renderOriginal(frame.metadata, frame.bytes);
              this.current();
              const snapshot = this.presentationOriginal!();
              if (!snapshot) throw new BrowserViewerPumpRefusal('stale');
              this.current();
              this.hasPresentation = true;
              this.onPresentation(snapshot, this.viewer, drawn);
              this.current();
              priorReceipt = drawn;
            } finally {
              frame.bytes.fill(0);
            }
          }
        } catch (error) {
          // Only the exact admitted lease's scheduled replacement permits fresh issuance.
          // HTTP denial, original decode errors and falsy causes never become retry hints.
          if (
            !this.renewing &&
            this.viewer &&
            Date.now() >= Date.parse(this.viewer.expiresAt) - renewalLead &&
            error instanceof BrowserPixelRenderRefusal &&
            error.reason === 'stale'
          ) {
            this.current(false);
            this.expireLease();
          }
          if (this.renewing) this.current(false);
          if (!this.expectedStopFailure(error)) this.failure(error);
        } finally {
          if (!this.renewing || this.failed) this.fence();
          else this.cleanup();
          const duties = [this.rendererClosing, this.disconnectEntered].filter(
            (value): value is Promise<void> => value !== undefined
          );
          const results = await Promise.allSettled(duties);
          if (this.leaseCleanupFailed) this.failure(this.leaseCleanupFirst);
          results.forEach((result, index) => {
            if (
              result.status === 'rejected' &&
              !(duties[index] === this.rendererClosing && this.expectedStopFailure(result.reason))
            )
              this.failure(result.reason);
          });
        }
        if (this.leaseCleanupFailed) this.failure(this.leaseCleanupFirst);
        const rendererCleanup = this.rendererCleanupOriginal?.();
        if (rendererCleanup?.failed) this.failure(rendererCleanup.first);
        if (this.failed || this.closed) break;
        this.current(false);
        // All old reader/decode/renderer/disconnect originals returned before a new lease can enter.
        if (this.expiry !== undefined) clearTimeout(this.expiry);
        this.expiry = undefined;
        this.viewer = undefined;
        this.presentationOriginal = undefined;
        this.rendererCleanupOriginal = undefined;
        this.renderOriginal = undefined;
        this.closeRendererOriginal = undefined;
        this.rendererClosing = undefined;
        this.disconnectEntered = undefined;
        this.leaseCleanupFailed = false;
        this.leaseCleanupFirst = undefined;
        this.renewing = false;
        this.expiryReason = Object.freeze(new Error('original viewer lease replacement due'));
        this.controller = new AbortController();
      }
    } catch (error) {
      if (!this.expectedStopFailure(error)) this.failure(error);
    } finally {
      this.fence();
      const duties = [this.rendererClosing, this.disconnectEntered].filter(
        (value): value is Promise<void> => value !== undefined
      );
      const results = await Promise.allSettled(duties);
      if (this.leaseCleanupFailed) this.failure(this.leaseCleanupFirst);
      results.forEach((result, index) => {
        if (
          result.status === 'rejected' &&
          !(duties[index] === this.rendererClosing && this.expectedStopFailure(result.reason))
        )
          this.failure(result.reason);
      });
      BrowserViewerPump.active.delete(this);
    }
    if (this.failed) throw this.first;
  }
  /** Start once; retained stalled originals remain charged until natural settlement. */
  start(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed)
      return Promise.reject(this.failed ? this.first : new BrowserViewerPumpRefusal('stale'));
    if (BrowserViewerPump.active.size >= 16)
      return Promise.reject(new BrowserViewerPumpRefusal('capacity'));
    BrowserViewerPump.active.add(this);
    this.running = this.observe(Promise.resolve().then(() => this.run()));
    return this.running;
  }
  /** Exact last drawn visual metadata only; stale observation synchronously clears/aborts. */
  presentation(): BrowserPixelPresentation | undefined {
    try {
      this.current();
      const snapshot = this.presentationOriginal?.();
      if (this.hasPresentation && !snapshot) throw new BrowserViewerPumpRefusal('stale');
      return snapshot;
    } catch (error) {
      if (!this.expectedStopFailure(error)) {
        this.failure(error);
        this.fence();
      }
      return undefined;
    }
  }
  /** Current canonical public descriptor for visual correlation; no ticket or permission is exposed. */
  currentViewer(): BrowserViewer | undefined {
    try {
      this.current();
      return this.viewer;
    } catch (error) {
      if (!this.expectedStopFailure(error)) {
        this.failure(error);
        this.fence();
      }
      return undefined;
    }
  }
  /** Deliberately stop this current local display before navigation; this grants no navigation authority.
   * Only this exact stop and the renderer's resulting closed refusal are expected. Original
   * reader cancellation, image cleanup, disconnect and owner-loss failures remain retained. */
  disposeForNavigation(): Promise<void> {
    if (!this.closing) {
      try {
        this.current(false);
        this.replacing = true;
      } catch (error) {
        this.failure(error);
      }
    }
    return this.close();
  }
  /** Independent original cleanup report for an authenticated successor consumer.
   * This preserves the original failure and confers no replacement or controller permission. */
  async settleForSuccessor(): Promise<
    Readonly<{
      settled: boolean;
      cleanup: Readonly<{ failed: false } | { failed: true; first: unknown }>;
      primary: Readonly<{ failed: false } | { failed: true; first: unknown }>;
    }>
  > {
    try {
      await this.close();
    } catch {
      /* The exact boxed primary remains in this original bank. */
    }
    return Object.freeze({
      settled: this.resourceSettled,
      cleanup: this.resourceCleanup
        ? Object.freeze({ failed: true as const, first: this.resourceCleanup.reason })
        : Object.freeze({ failed: false as const }),
      primary: this.failed
        ? Object.freeze({ failed: true as const, first: this.first })
        : Object.freeze({ failed: false as const }),
    });
  }
  /** Fence synchronously, disconnect once, then join original admission/read/decode and cleanup. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    // Reserve the original closing promise before synchronous clear callbacks can reenter.
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.fence();
    const retained = [this.running, this.rendererClosing, this.disconnectEntered].filter(
      (value): value is Promise<void> => value !== undefined
    );
    void Promise.allSettled(retained).then((results) => {
      if (this.leaseCleanupFailed) this.failure(this.leaseCleanupFirst);
      results.forEach((result, index) => {
        if (
          result.status === 'rejected' &&
          !(retained[index] === this.rendererClosing && this.expectedStopFailure(result.reason))
        )
          this.failure(result.reason);
      });
      try {
        const rendererCleanup = this.rendererCleanupOriginal?.();
        if (rendererCleanup?.failed) this.resourceFailure(rendererCleanup.first);
      } catch (reason) {
        this.resourceFailure(reason);
        this.failure(reason);
      }
      this.resourceSettled = true;
      if (this.failed) reject(this.first);
      else resolve();
    });
    void this.closing.catch(() => undefined);
    return this.closing;
  }
}
