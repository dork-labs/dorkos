import { schemefulSiteKey } from '@dorkos/shared/site-name';
import type { BrowserPageCustody } from './page-custody.js';
import type { BrowserBrokerSource } from './broker-source.js';
import type {
  BrowserPageFacts,
  BrowserPageScreencast,
  BrowserPersonInputLease,
  BrowserViewerIdentity,
  BrowserViewerPageHandle,
} from './broker-contract.js';
import { BrowserPersonController } from './viewer-control/person-controller.js';
import { openPageScreencast } from './page-screencast.js';
import { LocalBrowserError } from '../errors.js';

/** Server-only Page broker. Owner authentication remains in the caller's viewer router. */
export class BrowserPageBroker {
  private readonly viewers = new WeakMap<BrowserViewerPageHandle, BrowserBrokerSource>();
  private readonly controllers = new WeakMap<BrowserPersonInputLease, BrowserPersonController>();
  private readonly active = new WeakMap<BrowserPageCustody, BrowserPersonInputLease>();
  private readonly preparing = new Set<string>();
  private readonly fileOperations = new Map<string, number>();

  constructor(private readonly resolve: (sessionId: string) => BrowserBrokerSource) {}

  /** Bind only an existing grant; identity fields must come from verified owner ingress. */
  async captureViewerLease(
    sessionId: string,
    identity: BrowserViewerIdentity
  ): Promise<BrowserViewerPageHandle> {
    const source = this.resolve(sessionId);
    assertSource(source);
    const committed = source.committed();
    const site = schemefulSiteKey(committed.url);
    await source.authorize();
    assertSource(source);
    let closed = false;
    const streams = new Set<BrowserPageScreencast>();
    const revoked = new Map<() => void, () => void>();
    const current = () => !closed && source.isCurrent();
    const admit = () => {
      if (!current()) throw stale();
    };
    const watch = () => {
      admit();
      source.assertWatchAllowed();
      const now = source.committed();
      // Retaining a stream is confined to its originally captured schemeful site.
      if (
        now.generation !== committed.generation &&
        (site === null || schemefulSiteKey(now.url) !== site)
      )
        throw stale();
    };
    const viewer: BrowserViewerPageHandle = Object.freeze({
      binding: source.binding,
      identity: Object.freeze({ ...identity }),
      isCurrent: current,
      assertCurrent: admit,
      assertWatchAllowed: watch,
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
        const stream = await openPageScreencast(source, watch);
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
        const releasing = this.abandonViewer(viewer);
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
    const navigation = source.facts().navigationGeneration;
    const assertPreparing = () => {
      viewer.assertCurrent();
      if (source.facts().navigationGeneration !== navigation || !source.protectionAllowed())
        throw stale();
    };
    viewer.assertCurrent();
    const previous = this.active.get(source.custody);
    if (previous?.isCurrent())
      throw new LocalBrowserError('busy', 'Someone is already using this page.');
    // Failed or delayed authorization cannot leave agent admission open.
    source.custody.block();
    assertPreparing();
    await source.authorize();
    assertPreparing();
    const epoch = source.custody.epoch + 1;
    await source.hold();
    assertPreparing();
    if (source.custody.epoch !== epoch) throw stale();
    await source.authorize();
    assertPreparing();
    if (source.custody.epoch !== epoch || !source.custody.held) throw stale();
    if (previous) this.controllers.get(previous)?.unregister();
    const control: BrowserPersonController = new BrowserPersonController(
      source,
      viewer,
      epoch,
      () => this.active.get(source.custody) === control.lease,
      () => this.finish(control.lease, control),
      this.fileOperations
    );
    this.controllers.set(control.lease, control);
    this.active.set(source.custody, control.lease);
    await control.start();
    return control.lease;
  }

  /** Only this exact active controller can explicitly give the page back. */
  async handBack(lease: BrowserPersonInputLease): Promise<void> {
    const control = this.control(lease);
    await control.source.authorize();
    this.control(lease);
    control.ending = true;
    await control.source.resume();
    this.finish(lease, control);
  }

  /** Lost viewers release their input through the barrier and leave agent custody blocked. */
  async abandon(lease: BrowserPersonInputLease): Promise<void> {
    const control = this.control(lease);
    control.ending = true;
    await control.source.hold();
    this.finish(lease, control);
  }

  private control(lease: BrowserPersonInputLease): BrowserPersonController {
    const control = this.controllers.get(lease);
    if (!control || !lease.isCurrent()) throw stale();
    return control;
  }

  private finish(lease: BrowserPersonInputLease, control: BrowserPersonController): void {
    control.unregister();
    this.controllers.delete(lease);
    if (this.active.get(control.source.custody) === lease)
      this.active.delete(control.source.custody);
  }

  /** Retire only this viewer’s controller, keeping shared watching alive and agents held. */
  async abandonViewer(viewer: BrowserViewerPageHandle): Promise<void> {
    const source = this.viewers.get(viewer);
    if (!source) return;
    const lease = this.active.get(source.custody);
    const control = lease && this.controllers.get(lease);
    if (!lease || !control || control.viewer !== viewer) return;
    control.ending = true;
    await source.custody.hold();
    this.finish(lease, control);
  }
}

function assertSource(source: BrowserBrokerSource): void {
  if (!source.isCurrent()) throw stale();
}
function stale(): LocalBrowserError {
  return new LocalBrowserError('stale_page', 'The page changed. Open its view again.');
}
