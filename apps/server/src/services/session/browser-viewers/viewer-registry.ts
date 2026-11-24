import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import {
  viewerViewportSchema,
  type BrowserViewerMetadata,
  type BrowserViewerPaint,
  type BrowserViewerViewport,
} from '@dorkos/shared/browser-viewer-control';
import { ViewerControls } from './viewer-controls.js';
import { ViewerControlQueue } from './control-queue.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { registerLiveConnection } from '../../core/auth/sessions/live-connections.js';
import {
  BrowserViewerError,
  VIEWER_LIMITS,
  type DeliveredViewerFrame,
  type ResolveViewerPage,
  type ViewerFrame,
  type ViewerPage,
  type ViewerPrincipal,
  type ViewerPageIdentity,
} from './viewer-contract.js';

interface Producer {
  queue: ViewerControlQueue;
  latest?: ViewerFrame;
  key: string;
  closing: boolean;
  page: ViewerPage;
  stop: Promise<() => Promise<void>>;
  sequence: number;
  viewers: Set<Viewer>;
  revoke: () => void;
}

interface Viewer {
  id: string;
  nonce: string;
  principal: ViewerPrincipal;
  page: ViewerPage;
  cleanup?: Promise<void>;
  controls: ViewerControls;
  offChange: () => void;
  address?: { receipt: string; navigation: number };
  delivered?: DeliveredViewerFrame;
  painted?: Pick<ViewerFrame, 'navigationGeneration' | 'controlEpoch' | 'viewport'>;
  producer: Producer;
  expiresAt: number;
  idle: ReturnType<typeof setTimeout>;
  pending?: ViewerFrame;
  receipt?: string;
  busy: boolean;
  wake?: () => void;
  budget: ByteBudget;
  unregisterSession?: () => void;
}

class ByteBudget {
  private credit: number;
  private updatedAt = Date.now();

  constructor(
    private readonly rate: number,
    private readonly capacity: number
  ) {
    this.credit = capacity;
  }

  available(now: number): number {
    this.credit = Math.min(
      this.capacity,
      this.credit + (Math.max(0, now - this.updatedAt) * this.rate) / 1_000
    );
    this.updatedAt = Math.max(now, this.updatedAt);
    return this.credit;
  }

  spend(bytes: number): void {
    this.credit -= bytes;
  }
}

const opaque = () => randomBytes(32).toString('base64url');
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Volatile owner-bound subscriptions. Viewer lifetime never owns the browser lifetime. */
export class BrowserViewerRegistry {
  private readonly viewers = new Map<string, Viewer>();
  private readonly producers = new Map<string, Producer>();
  private closed = false;
  private readonly draining = new Set<Promise<void>>();
  private readonly budget = new ByteBudget(
    VIEWER_LIMITS.installBytesPerSecond,
    VIEWER_LIMITS.installBytesPerSecond
  );

  private readonly uploads = new Map<string, number>();
  constructor(
    private readonly resolve: ResolveViewerPage,
    private readonly inputEnabled: () => boolean = () => false
  ) {}

  /** Subscribe only to the server's existing page for this chat. */
  async subscribe(
    principal: ViewerPrincipal,
    chatId: string
  ): Promise<{
    viewerId: string;
    nonce: string;
    binding: ViewerPageIdentity;
    metadata: BrowserViewerMetadata;
  }> {
    if (this.closed) throw new BrowserViewerError('viewer_unavailable');
    const id = opaque();
    const page = await this.resolve(chatId, principal, id);
    try {
      if (page.identity.chatId !== chatId) throw new BrowserViewerError('viewer_denied');
      await page.assertCurrent();
      if (this.closed) throw new BrowserViewerError('viewer_unavailable');
    } catch (error) {
      await page.close();
      throw error;
    }
    const key = bindingKey(page);
    let producer = this.producers.get(key);
    if (producer?.closing) {
      await page.close();
      throw new BrowserViewerError('viewer_busy');
    }
    if (
      this.viewers.size >= VIEWER_LIMITS.viewers ||
      (producer?.viewers.size ?? 0) >= VIEWER_LIMITS.viewersPerPage
    ) {
      await page.close();
      throw new BrowserViewerError('viewer_limit');
    }
    if (!producer) {
      const owned: Producer = {
        queue: new ViewerControlQueue(),
        key,
        closing: false,
        page,
        sequence: 0,
        viewers: new Set(),
        stop: Promise.resolve().then(() => page.start((frame) => this.publish(owned, frame))),
        revoke: () => {
          for (const viewer of [...owned.viewers]) void this.remove(viewer);
        },
      };
      producer = owned;
      this.producers.set(key, owned);
      page.signal.addEventListener('abort', owned.revoke, { once: true });
      // Registration precedes the await, so simultaneous subscribers share one producer.
    }
    const viewer = {
      id,
      offChange: () => undefined,
      nonce: opaque(),
      principal: { ...principal },
      page,
      producer,
      expiresAt: Date.now() + VIEWER_LIMITS.lifetimeMs,
      idle: setTimeout(() => void this.remove(viewer), VIEWER_LIMITS.idleMs),
      busy: false,
      budget: new ByteBudget(VIEWER_LIMITS.viewerBytesPerSecond, VIEWER_LIMITS.viewerBurstBytes),
    } as Viewer;
    viewer.controls = new ViewerControls({
      page,
      queue: producer.queue,
      owner: principal.ownerId,
      uploads: this.uploads,
      enabled: this.inputEnabled,
      admit: () => this.assertLive(principal, id, viewer.nonce),
      wake: () => viewer.wake?.(),
      viewport: () => this.viewport(viewer),
    });
    viewer.offChange = page.onChange(() => {
      // Navigation/control changes clear old image/address authority before the next await.
      const facts = page.facts();
      if (viewer.address?.navigation !== facts.navigationGeneration) viewer.address = undefined;
      if (viewer.pending && !matchesFacts(viewer.pending, facts)) viewer.pending = undefined;
      viewer.wake?.();
    });
    viewer.idle.unref?.();
    this.viewers.set(id, viewer);
    producer.viewers.add(viewer);
    viewer.unregisterSession = registerLiveConnection(
      principal.sessionId,
      principal.ownerId,
      () => {
        void this.remove(viewer);
      }
    );
    try {
      await producer.stop;
      if (page.signal.aborted) throw new BrowserViewerError('viewer_unavailable');
      await this.current(viewer);
      return {
        viewerId: id,
        nonce: viewer.nonce,
        binding: { ...page.identity },
        metadata: this.metadata(principal, id, viewer.nonce),
      };
    } catch {
      await this.remove(viewer);
      throw new BrowserViewerError('viewer_unavailable');
    }
  }

  /** Return one frame after consuming exactly the preceding paint receipt. */
  async frame(
    principal: ViewerPrincipal,
    id: string,
    nonce: string,
    receipt?: string,
    signal?: AbortSignal,
    paint?: BrowserViewerPaint
  ): Promise<DeliveredViewerFrame | null> {
    const viewer = this.find(principal, id, nonce);
    if (viewer.busy) throw new BrowserViewerError('viewer_busy');
    if (viewer.receipt !== receipt) throw new BrowserViewerError('viewer_denied');
    viewer.busy = true;
    try {
      await this.current(viewer);
      if (receipt && viewer.delivered) {
        const { navigationGeneration, controlEpoch, viewport } = viewer.delivered;
        viewer.painted = { navigationGeneration, controlEpoch, viewport };
      }
      const painted = viewer.painted;
      if (
        paint &&
        painted &&
        viewer.address &&
        viewer.address.receipt === paint.addressReceipt &&
        painted.viewport.generation === paint.viewportGeneration &&
        this.viewport(viewer)?.generation === paint.viewportGeneration &&
        matchesFacts(painted, viewer.page.facts()) &&
        viewer.address.navigation === painted.navigationGeneration
      ) {
        viewer.controls.paint({
          navigationGeneration: painted.navigationGeneration,
          addressGeneration: viewer.address.navigation,
          viewportGeneration: paint.viewportGeneration,
          controlEpoch: painted.controlEpoch,
        });
      }
      viewer.receipt = undefined;
      viewer.delivered = undefined;
      this.touch(viewer);
      if (!viewer.pending) await this.wait(viewer, signal);
      await this.current(viewer);
      if (signal?.aborted) throw new BrowserViewerError('viewer_unavailable');
      const frame = viewer.pending;
      viewer.pending = undefined;
      if (!frame) return null;
      const now = Date.now();
      const bytes = frame.bytes.length;
      // Charge every fan-out delivery, never queued capture bytes. Exhaustion drops the frame.
      if (viewer.budget.available(now) < bytes || this.budget.available(now) < bytes) return null;
      viewer.budget.spend(bytes);
      this.budget.spend(bytes);
      viewer.receipt = opaque();
      viewer.delivered = { ...frame, receipt: viewer.receipt };
      return viewer.delivered;
    } finally {
      viewer.busy = false;
    }
  }

  /** Bounded URL-free metadata accompanies subscription, JPEG and idle replies. */
  metadata(principal: ViewerPrincipal, id: string, nonce: string): BrowserViewerMetadata {
    this.assertLive(principal, id, nonce);
    const viewer = this.find(principal, id, nonce);
    if (!this.inputEnabled()) viewer.controls.disable();
    return {
      ...viewer.page.facts(),
      viewport: this.viewport(viewer),
      ...viewer.controls.snapshot(),
    };
  }
  control(principal: ViewerPrincipal, id: string, nonce: string): ViewerControls {
    this.assertLive(principal, id, nonce);
    const viewer = this.find(principal, id, nonce);
    if (!this.inputEnabled()) {
      viewer.controls.disable();
      throw new BrowserViewerError('viewer_denied');
    }
    this.touch(viewer);
    return viewer.controls;
  }
  disableInput(): void {
    for (const viewer of this.viewers.values()) viewer.controls.disable();
  }
  /** Final synchronous image fence after awaited live-session admission. */
  deliveryCurrent(
    principal: ViewerPrincipal,
    id: string,
    nonce: string,
    frame: DeliveredViewerFrame
  ): boolean {
    this.assertLive(principal, id, nonce);
    const viewer = this.find(principal, id, nonce);
    if (
      matchesFacts(frame, viewer.page.facts()) &&
      this.viewport(viewer)?.generation === frame.viewport.generation
    )
      return true;
    if (viewer.delivered?.receipt === frame.receipt) {
      viewer.receipt = undefined;
      viewer.delivered = undefined;
    }
    return false;
  }
  /** Stamp the existing person URL response only across an unchanged captured Page generation. */
  async address(
    principal: ViewerPrincipal,
    id: string,
    nonce: string,
    chatId: string | null,
    read: () => Promise<LocalBrowserPersonState>
  ): Promise<LocalBrowserPersonState> {
    const viewer = this.find(principal, id, nonce);
    if (viewer.page.identity.chatId !== chatId) throw new BrowserViewerError('viewer_denied');
    const generation = viewer.page.facts().navigationGeneration;
    await this.current(viewer);
    const state = await read();
    await this.current(viewer);
    if (
      viewer.page.facts().navigationGeneration !== generation ||
      state.connectionId !== viewer.page.identity.connectionId ||
      state.selectedTabId !== viewer.page.identity.tabId ||
      state.sessionId !== chatId ||
      state.status !== 'connected'
    )
      return state;
    const receipt = opaque();
    viewer.address = { receipt, navigation: generation };
    return { ...state, viewerAddress: { receipt, navigationGeneration: generation } };
  }
  private viewport(viewer: Viewer): BrowserViewerViewport | null {
    const frame = viewer.producer.latest;
    return frame && matchesFacts(frame, viewer.page.facts()) ? frame.viewport : null;
  }

  /** No await may separate this fence from the response's construction. */
  assertLive(principal: ViewerPrincipal, id: string, nonce: string): void {
    const viewer = this.find(principal, id, nonce);
    try {
      if (viewer.page.signal.aborted || Date.now() >= viewer.expiresAt)
        throw new BrowserViewerError('viewer_denied');
      viewer.page.assertLive();
    } catch {
      void this.remove(viewer);
      throw new BrowserViewerError('viewer_denied');
    }
  }

  /** Close only the caller's own subscription, never its page. */
  async unsubscribe(principal: ViewerPrincipal, id: string, nonce: string): Promise<void> {
    await this.remove(this.find(principal, id, nonce));
  }

  /** Revoke every subscription when the server shuts down or the feature is disabled. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.viewers.values()].map((viewer) => this.remove(viewer)));
    await Promise.all([...this.draining]);
  }

  private find(principal: ViewerPrincipal, id: string, nonce: string): Viewer {
    const viewer = this.viewers.get(id);
    if (
      !viewer ||
      !sameSecret(viewer.nonce, nonce) ||
      Object.keys(viewer.principal).some(
        (key) =>
          viewer.principal[key as keyof ViewerPrincipal] !== principal[key as keyof ViewerPrincipal]
      )
    )
      throw new BrowserViewerError('viewer_denied');
    return viewer;
  }

  private async current(viewer: Viewer): Promise<void> {
    try {
      if (!this.viewers.has(viewer.id) || Date.now() >= viewer.expiresAt)
        throw new BrowserViewerError('viewer_unavailable');
      if (viewer.page.signal.aborted) throw new BrowserViewerError('viewer_unavailable');
      await viewer.page.assertCurrent();
      if (!this.viewers.has(viewer.id) || viewer.page.signal.aborted)
        throw new BrowserViewerError('viewer_unavailable');
    } catch {
      await this.remove(viewer);
      throw new BrowserViewerError('viewer_unavailable');
    }
  }

  private touch(viewer: Viewer): void {
    clearTimeout(viewer.idle);
    viewer.idle = setTimeout(
      () => void this.remove(viewer),
      Math.min(VIEWER_LIMITS.idleMs, viewer.expiresAt - Date.now())
    );
    viewer.idle.unref?.();
  }

  private publish(producer: Producer, frame: ViewerFrame): void {
    if (
      this.producers.get(producer.key) !== producer ||
      producer.closing ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence <= producer.sequence ||
      !Number.isSafeInteger(frame.generation) ||
      frame.generation < 1 ||
      !Number.isSafeInteger(frame.navigationGeneration) ||
      frame.navigationGeneration < 0 ||
      !Number.isSafeInteger(frame.controlEpoch) ||
      frame.controlEpoch < 0 ||
      !viewerViewportSchema.safeParse(frame.viewport).success ||
      frame.generation !== frame.viewport.generation ||
      !Buffer.isBuffer(frame.bytes) ||
      frame.bytes.length === 0 ||
      frame.bytes.length > VIEWER_LIMITS.frameBytes ||
      !Number.isSafeInteger(frame.width) ||
      frame.width < 1 ||
      frame.width > VIEWER_LIMITS.width ||
      !Number.isSafeInteger(frame.height) ||
      frame.height < 1 ||
      frame.height > VIEWER_LIMITS.height
    )
      return;
    producer.sequence = frame.sequence;
    producer.latest = frame;
    for (const viewer of producer.viewers) {
      viewer.pending = frame;
      viewer.wake?.();
    }
  }

  private wait(viewer: Viewer, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        viewer.wake = undefined;
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, VIEWER_LIMITS.pollMs);
      timer.unref?.();
      viewer.wake = done;
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted || !this.viewers.has(viewer.id)) done();
    });
  }

  private remove(viewer: Viewer): Promise<void> {
    if (viewer.cleanup) return viewer.cleanup;
    if (!this.viewers.delete(viewer.id)) return Promise.resolve();
    clearTimeout(viewer.idle);
    viewer.offChange();
    viewer.controls.disable(false);
    viewer.address = undefined;
    viewer.delivered = undefined;
    viewer.painted = undefined;
    viewer.unregisterSession?.();
    viewer.unregisterSession = undefined;
    viewer.pending = undefined;
    viewer.receipt = undefined;
    viewer.wake?.();
    const producer = viewer.producer;
    producer.viewers.delete(viewer);
    const last = !producer.viewers.size;
    if (last) producer.closing = true;
    viewer.cleanup = (async () => {
      try {
        // A producer's first handle outlives its subscriber; its controller does not.
        if (viewer.page === producer.page) await viewer.page.abandon();
        else await viewer.page.close();
      } catch {
        // A failed reset leaves custody held in the broker; closing never resumes agents.
      } finally {
        if (last) {
          producer.page.signal.removeEventListener('abort', producer.revoke);
          try {
            await producer.stop.then((stop) => stop());
          } catch {
            /* The broker keeps unresolved physical teardown reserved. */
          } finally {
            await producer.page.close().catch(() => undefined);
            if (this.producers.get(producer.key) === producer) this.producers.delete(producer.key);
          }
        }
      }
    })();
    this.draining.add(viewer.cleanup);
    void viewer.cleanup.finally(() => this.draining.delete(viewer.cleanup!));
    return viewer.cleanup;
  }
}

/** Full server binding; owner/session/client authority remains on each viewer's handle. */
function bindingKey(page: ViewerPage): string {
  const b = page.binding;
  return JSON.stringify([
    b.sessionId,
    b.profileId,
    b.connectionId,
    b.profileConnectionGeneration,
    b.leaseId,
    b.tabId,
  ]);
}

function matchesFacts(
  frame: Pick<ViewerFrame, 'navigationGeneration' | 'controlEpoch'>,
  facts: { navigationGeneration: number; controlEpoch: number }
): boolean {
  return (
    frame.navigationGeneration === facts.navigationGeneration &&
    frame.controlEpoch === facts.controlEpoch
  );
}
