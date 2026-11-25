import { schemefulSiteKey } from '@dorkos/shared/site-name';
import type { BrowserViewerChooser } from '@dorkos/shared/browser-viewer-control';
import type { BrowserBrokerSource } from '../broker-source.js';
import type { BrowserPersonInputLease, BrowserViewerPageHandle } from '../broker-contract.js';
import { BrowserPersonGeneration } from './person-generation.js';
import { LocalBrowserError } from '../../errors.js';

/** One held controller survives only verified same-site commits; operations never survive one. */
export class BrowserPersonController {
  readonly lease: BrowserPersonInputLease;
  ending = false;
  private work: BrowserPersonGeneration;
  private navigation: number;
  private commit: number;
  private readonly site: string | null;
  private renewal = 0;
  private renewing = false;
  private offReset = () => undefined as void;
  private offChange = () => undefined as void;
  private readonly choosers = new Map<(ticket: BrowserViewerChooser) => void, () => void>();

  constructor(
    readonly source: BrowserBrokerSource,
    readonly viewer: BrowserViewerPageHandle,
    readonly epoch: number,
    private readonly isActive: () => boolean,
    private readonly finish: () => void,
    private readonly fileOperations: Map<string, number>
  ) {
    this.navigation = source.facts().navigationGeneration;
    const committed = source.committed();
    this.commit = committed.generation;
    this.site = schemefulSiteKey(committed.url);
    this.work = this.createWork(this.navigation);
    this.lease = Object.freeze({
      epoch,
      isCurrent: () => this.current(),
      inputReady: () => this.current() && this.work.ready(),
      confirmPaint: (paint) => this.work.confirmPaint(paint),
      // Capture the generation-specific object synchronously before the first await.
      runPerson: (event, admit) => this.work.run(event, admit),
      readSelection: (admit) => this.work.readSelection(admit),
      chooseFiles: (id, payloads, settled, admit) =>
        this.work.chooseFiles(id, payloads, settled, admit),
      cancelFileChooser: (id) => {
        const work = this.work;
        work.assertCurrent();
        return work.files.cancel(id);
      },
      onFileChooser: (listener) => {
        this.assertCurrent();
        this.choosers.set(listener, this.work.files.listen(listener));
        return () => {
          this.choosers.get(listener)?.();
          this.choosers.delete(listener);
        };
      },
    } satisfies BrowserPersonInputLease);
  }
  current(): boolean {
    return (
      !this.ending &&
      this.viewer.isCurrent() &&
      this.source.custody.held &&
      this.source.custody.epoch === this.epoch &&
      this.isActive()
    );
  }
  private readonly assertCurrent = (): void => {
    if (
      !this.current() ||
      !this.source.protectionAllowed() ||
      (this.site !== null && schemefulSiteKey(this.source.committed().url) !== this.site)
    )
      throw stale();
  };
  async start(): Promise<void> {
    this.offReset = this.source.custody.onReset(() => this.work.reset());
    this.offChange = this.source.onChange(this.changed);
    try {
      await this.work.initialize();
      this.assertCurrent();
    } catch (error) {
      this.end();
      throw error;
    }
  }
  unregister(): void {
    this.offReset();
    this.offChange();
    for (const off of this.choosers.values()) off();
    this.choosers.clear();
  }
  private createWork(generation: number): BrowserPersonGeneration {
    return new BrowserPersonGeneration(
      this.source,
      generation,
      this.assertCurrent,
      this.viewer.identity.viewerId,
      this.viewer.identity.ownerId,
      this.fileOperations
    );
  }
  private readonly changed = (): void => {
    if (this.ending) return;
    if (!this.current() || !this.source.protectionAllowed()) {
      this.end();
      return;
    }
    const navigation = this.source.facts().navigationGeneration;
    if (navigation === this.navigation) return;
    this.navigation = navigation;
    const committed = this.source.committed();
    if (committed.generation !== this.commit) {
      this.commit = committed.generation;
      const nextSite = schemefulSiteKey(committed.url);
      if (this.site === null || nextSite === null || nextSite !== this.site) {
        this.end();
        return;
      }
    }
    this.renewal++;
    // Old work fails its captured generation synchronously. Serialize renewal so
    // several same-site commits cannot race each other's custody reset.
    this.scheduleRenewal();
  };
  private scheduleRenewal(): void {
    if (this.renewing || this.ending) return;
    this.renewing = true;
    queueMicrotask(() => {
      void this.renew()
        .catch(() => this.end())
        .finally(() => {
          this.renewing = false;
          if (this.work.generation !== this.navigation) this.scheduleRenewal();
        });
    });
  }
  private async renew(): Promise<void> {
    while (true) {
      this.assertCurrent();
      const renewal = this.renewal;
      const navigation = this.navigation;
      await this.source.custody.resetHeld(this.epoch);
      this.assertCurrent();
      if (renewal !== this.renewal) continue;
      await this.source.authorize();
      this.assertCurrent();
      if (renewal !== this.renewal) continue;
      const work = this.createWork(navigation);
      this.work = work;
      try {
        await work.initialize();
      } catch (error) {
        this.assertCurrent();
        if (renewal !== this.renewal) continue;
        throw error;
      }
      await this.source.authorize();
      this.assertCurrent();
      if (renewal !== this.renewal) continue;
      for (const listener of this.choosers.keys())
        this.choosers.set(listener, work.files.listen(listener));
      // Paint stays false until a new receipt and person address match this generation.
      return;
    }
  }
  private end(): void {
    if (this.ending) return;
    this.ending = true;
    queueMicrotask(() => {
      // Another custody transition owns its reset. Never unregister before that reset runs.
      if (!this.isActive() || this.source.custody.epoch !== this.epoch) return;
      void this.source.custody
        .hold()
        .then(this.finish)
        .catch(() => undefined);
    });
  }
}

function stale(): LocalBrowserError {
  return new LocalBrowserError('stale_page', 'The page changed. Open its view again.');
}
