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
  private readonly producers = new Map<ViewerPage, Producer>();
  private closed = false;
  private readonly budget = new ByteBudget(
    VIEWER_LIMITS.installBytesPerSecond,
    VIEWER_LIMITS.installBytesPerSecond
  );

  constructor(private readonly resolve: ResolveViewerPage) {}

  /** Subscribe only to the server's existing page for this chat. */
  async subscribe(
    principal: ViewerPrincipal,
    chatId: string
  ): Promise<{
    viewerId: string;
    nonce: string;
    binding: ViewerPageIdentity;
  }> {
    if (this.closed) throw new BrowserViewerError('viewer_unavailable');
    const page = await this.resolve(chatId);
    if (page.identity.chatId !== chatId) throw new BrowserViewerError('viewer_denied');
    await page.assertCurrent();
    if (this.closed) throw new BrowserViewerError('viewer_unavailable');
    let producer = this.producers.get(page);
    if (
      this.viewers.size >= VIEWER_LIMITS.viewers ||
      (producer?.viewers.size ?? 0) >= VIEWER_LIMITS.viewersPerPage
    )
      throw new BrowserViewerError('viewer_limit');
    if (!producer) {
      const owned: Producer = {
        page,
        sequence: 0,
        viewers: new Set(),
        stop: Promise.resolve().then(() => page.start((frame) => this.publish(owned, frame))),
        revoke: () => {
          for (const viewer of [...owned.viewers]) void this.remove(viewer);
        },
      };
      producer = owned;
      this.producers.set(page, owned);
      page.signal.addEventListener('abort', owned.revoke, { once: true });
      // Registration precedes the await, so simultaneous subscribers share one producer.
    }
    const id = opaque();
    const viewer: Viewer = {
      id,
      nonce: opaque(),
      principal: { ...principal },
      producer,
      expiresAt: Date.now() + VIEWER_LIMITS.lifetimeMs,
      idle: setTimeout(() => void this.remove(viewer), VIEWER_LIMITS.idleMs),
      busy: false,
      budget: new ByteBudget(VIEWER_LIMITS.viewerBytesPerSecond, VIEWER_LIMITS.viewerBurstBytes),
    };
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
      return { viewerId: id, nonce: viewer.nonce, binding: { ...page.identity } };
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
    signal?: AbortSignal
  ): Promise<DeliveredViewerFrame | null> {
    const viewer = this.find(principal, id, nonce);
    if (viewer.busy) throw new BrowserViewerError('viewer_busy');
    if (viewer.receipt !== receipt) throw new BrowserViewerError('viewer_denied');
    viewer.busy = true;
    try {
      await this.current(viewer);
      viewer.receipt = undefined;
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
      return { ...frame, receipt: viewer.receipt };
    } finally {
      viewer.busy = false;
    }
  }

  /** No await may separate this fence from the response's construction. */
  assertLive(principal: ViewerPrincipal, id: string, nonce: string): void {
    const viewer = this.find(principal, id, nonce);
    try {
      if (viewer.producer.page.signal.aborted || Date.now() >= viewer.expiresAt)
        throw new BrowserViewerError('viewer_denied');
      viewer.producer.page.assertLive();
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
      if (viewer.producer.page.signal.aborted) throw new BrowserViewerError('viewer_unavailable');
      await viewer.producer.page.assertCurrent();
      if (!this.viewers.has(viewer.id) || viewer.producer.page.signal.aborted)
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
      this.producers.get(producer.page) !== producer ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence <= producer.sequence ||
      !Number.isSafeInteger(frame.generation) ||
      frame.generation < 1 ||
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

  private async remove(viewer: Viewer): Promise<void> {
    if (!this.viewers.delete(viewer.id)) return;
    clearTimeout(viewer.idle);
    viewer.unregisterSession?.();
    viewer.unregisterSession = undefined;
    viewer.pending = undefined;
    viewer.receipt = undefined;
    viewer.wake?.();
    const producer = viewer.producer;
    producer.viewers.delete(viewer);
    if (!producer.viewers.size) {
      this.producers.delete(producer.page);
      producer.page.signal.removeEventListener('abort', producer.revoke);
      await producer.stop.then((stop) => stop()).catch(() => undefined);
    }
  }
}
