import type { BrowserPageCustody } from './page-custody.js';
import type { BrowserBrokerSource } from './broker-source.js';
import type {
  BrowserPageFacts,
  BrowserPageScreencast,
  BrowserPersonInput,
  BrowserPersonInputLease,
  BrowserViewerIdentity,
  BrowserViewerPageHandle,
} from './broker-contract.js';
import { BrowserPersonInputFlight } from './person-input.js';
import { openPageScreencast } from './page-screencast.js';
import { LocalBrowserError } from '../errors.js';

interface Controller {
  source: BrowserBrokerSource;
  epoch: number;
  viewer: BrowserViewerPageHandle;
  unregister(): void;
}

/** Server-only Page broker. Owner authentication remains in the caller's viewer router. */
export class BrowserPageBroker {
  private readonly viewers = new WeakMap<BrowserViewerPageHandle, BrowserBrokerSource>();
  private readonly controllers = new WeakMap<BrowserPersonInputLease, Controller>();
  private readonly active = new WeakMap<BrowserPageCustody, BrowserPersonInputLease>();
  private readonly preparing = new Set<string>();

  constructor(private readonly resolve: (sessionId: string) => BrowserBrokerSource) {}

  /** Bind only an existing grant; identity fields must come from verified owner ingress. */
  async captureViewerLease(
    sessionId: string,
    identity: BrowserViewerIdentity
  ): Promise<BrowserViewerPageHandle> {
    const source = this.resolve(sessionId);
    assertSource(source);
    await source.authorize();
    assertSource(source);
    let closed = false;
    const streams = new Set<BrowserPageScreencast>();
    const revoked = new Map<() => void, () => void>();
    const current = () => !closed && source.isCurrent();
    const admit = () => {
      if (!current()) throw stale();
    };
    const viewer: BrowserViewerPageHandle = Object.freeze({
      binding: source.binding,
      identity: Object.freeze({ ...identity }),
      isCurrent: current,
      assertCurrent: admit,
      facts() {
        admit();
        return source.facts();
      },
      onPageChange(listener: (facts: BrowserPageFacts) => void) {
        admit();
        const notify = () => {
          if (current()) listener(source.facts());
        };
        const unsubscribe = source.onChange(notify);
        revoked.set(notify, unsubscribe);
        return () => {
          revoked.delete(notify);
          unsubscribe();
        };
      },
      async assertAuthorized() {
        admit();
        await source.authorize();
        admit();
      },
      onRevoked(listener: () => void) {
        if (!current()) {
          listener();
          return () => undefined;
        }
        let notified = false;
        const notify = () => {
          if (!notified && !current()) {
            notified = true;
            listener();
          }
        };
        const unsubscribe = source.onChange(notify);
        revoked.set(notify, unsubscribe);
        return () => {
          revoked.delete(notify);
          unsubscribe();
        };
      },
      async openScreencast() {
        admit();
        await source.authorize();
        admit();
        const stream = await openPageScreencast(source, admit);
        try {
          admit();
        } catch (error) {
          await stream.close().catch(() => undefined);
          throw error;
        }
        streams.add(stream);
        return stream;
      },
      close: async () => {
        if (closed) return;
        const releasing = this.closeViewer(viewer);
        closed = true;
        for (const [notify, unsubscribe] of revoked) {
          try {
            notify();
          } catch {
            /* Consumer failures cannot retain Page resources. */
          }
          unsubscribe();
        }
        revoked.clear();
        try {
          await releasing;
        } finally {
          await Promise.allSettled([...streams].map((stream) => stream.close()));
          streams.clear();
        }
      },
    });
    this.viewers.set(viewer, source);
    return viewer;
  }

  /** Block agents synchronously before the shared physical drain, then grant one controller. */
  async takePersonControl(viewer: BrowserViewerPageHandle): Promise<BrowserPersonInputLease> {
    const source = this.viewers.get(viewer);
    if (!source) throw stale();
    const id = source.binding.leaseId;
    if (this.preparing.has(id))
      throw new LocalBrowserError('busy', 'The page is changing control. Wait a moment.');
    this.preparing.add(id);
    try {
      return await this.take(viewer, source);
    } finally {
      this.preparing.delete(id);
    }
  }

  private async take(
    viewer: BrowserViewerPageHandle,
    source: BrowserBrokerSource
  ): Promise<BrowserPersonInputLease> {
    viewer.assertCurrent();
    await source.authorize();
    viewer.assertCurrent();
    const previous = this.active.get(source.custody);
    if (previous?.isCurrent())
      throw new LocalBrowserError('busy', 'Someone is already using this page.');
    const epoch = source.custody.epoch + 1;
    await source.hold();
    viewer.assertCurrent();
    if (source.custody.epoch !== epoch) throw stale();
    await source.authorize();
    viewer.assertCurrent();
    if (source.custody.epoch !== epoch || !source.custody.held) throw stale();
    if (previous) this.controllers.get(previous)?.unregister();
    const current = () =>
      viewer.isCurrent() &&
      source.custody.held &&
      source.custody.epoch === epoch &&
      this.active.get(source.custody) === lease;
    const input = new BrowserPersonInputFlight(source, () => {
      if (!current()) throw stale();
    });
    const lease: BrowserPersonInputLease = Object.freeze({
      epoch,
      isCurrent: current,
      runPerson: async (event: BrowserPersonInput) => {
        await source.authorize();
        if (!current()) throw stale();
        await input.run(event);
        await source.authorize();
        if (!current()) throw stale();
      },
    });
    this.controllers.set(lease, {
      source,
      epoch,
      viewer,
      unregister: source.custody.onReset(() => input.reset()),
    });
    this.active.set(source.custody, lease);
    return lease;
  }

  /** Only this exact active controller can explicitly give the page back. */
  async handBack(lease: BrowserPersonInputLease): Promise<void> {
    const control = this.control(lease);
    await control.source.authorize();
    this.control(lease);
    await control.source.resume();
    this.finish(lease, control);
  }

  /** Lost viewers release their input through the barrier and leave agent custody blocked. */
  async abandon(lease: BrowserPersonInputLease): Promise<void> {
    const control = this.control(lease);
    await control.source.hold();
    this.finish(lease, control);
  }

  private control(lease: BrowserPersonInputLease): Controller {
    const control = this.controllers.get(lease);
    if (!control || !lease.isCurrent()) throw stale();
    return control;
  }

  private finish(lease: BrowserPersonInputLease, control: Controller): void {
    control.unregister();
    this.controllers.delete(lease);
    if (this.active.get(control.source.custody) === lease)
      this.active.delete(control.source.custody);
  }

  private async closeViewer(viewer: BrowserViewerPageHandle): Promise<void> {
    const source = this.viewers.get(viewer);
    if (!source) return;
    const lease = this.active.get(source.custody);
    const control = lease && this.controllers.get(lease);
    if (!lease || !control || control.viewer !== viewer) return;
    await source.hold();
    this.finish(lease, control);
  }
}

function assertSource(source: BrowserBrokerSource): void {
  if (!source.isCurrent()) throw stale();
}
function stale(): LocalBrowserError {
  return new LocalBrowserError('stale_page', 'The page changed. Open its view again.');
}
