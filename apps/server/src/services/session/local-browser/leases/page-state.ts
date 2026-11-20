import { randomUUID } from 'node:crypto';
import type { JSHandle, Page } from 'playwright-core';
import type { LocalBrowserObservation, LocalBrowserState } from '@dorkos/shared/local-browser';
import type { ObservedPageNodes } from '../observation-nodes.js';
import { LocalBrowserTabMetadata } from '../tab-metadata.js';
import type { PageWorkTracker } from './page-work.js';
import { observeSelectedPage, screenshotSelectedPage } from '../connection/observe-page.js';
import { LocalBrowserError } from '../errors.js';

/** Page-local observations and tab identities; no profile or chat can adopt these handles. */
export class BrowserPageState {
  readonly tabs = new Map<string, Page>();
  selectedTabId: string | null = null;
  revision = 0;
  // Frame churn fences reads without consuming every action revision.
  frameChanges = 0;
  observation?: LocalBrowserObservation;
  observedNodes?: JSHandle<ObservedPageNodes>;
  readonly metadata: LocalBrowserTabMetadata;
  private readonly listeners = new Set<() => void>();

  /** Metadata-only invalidation notification; no Page read is performed. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  constructor(
    private readonly trackWork: PageWorkTracker,
    private readonly watch: (page: Page) => void,
    private readonly readable: () => boolean,
    private readonly addresses: (page: Page) => void = () => undefined
  ) {
    this.metadata = new LocalBrowserTabMetadata(trackWork, readable);
  }
  /** Cached labels are read only within this lease's Page set. */
  describe(
    base: Omit<LocalBrowserState, 'tabs' | 'selectedTabId' | 'revision'>,
    selectedOnly: boolean
  ): LocalBrowserState {
    const selected = this.tabs.get(this.selectedTabId ?? '');
    if (selected && this.readable()) this.metadata.refresh(selected);
    const pages = [...this.tabs].filter(([id]) => !selectedOnly || id === this.selectedTabId);
    return {
      ...base,
      tabs: this.metadata.describe(pages),
      selectedTabId: this.selectedTabId,
      revision: this.revision,
    };
  }

  /** Install nodes only after the exact page's read and custody fences succeed. */
  async observe(page: Page, refuse: () => void): Promise<LocalBrowserObservation> {
    refuse();
    this.invalidate();
    const observed = await observeSelectedPage(page, this.selectedTabId!, {
      revision: () => this.revision,
      frames: () => this.frameChanges,
      refuse,
      stale: () =>
        new LocalBrowserError('stale_page', 'The page changed. Read it again before acting.'),
      track: this.trackWork,
    });
    this.observedNodes = observed.nodes;
    this.observation = observed.observation;
    return observed.observation;
  }

  /** Pixels grant no action revision and retain the physical read reservation. */
  screenshot(page: Page, refuse: () => void) {
    return screenshotSelectedPage(
      page,
      () => ({
        revision: this.revision,
        tabId: this.selectedTabId!,
        frames: this.frameChanges,
      }),
      refuse,
      this.trackWork
    );
  }

  /** Reconcile only the host's already-scoped Page list. */
  sync(pages: readonly Page[]): void {
    for (const page of pages) this.track(page);
    for (const [id, page] of this.tabs) if (page.isClosed()) this.tabs.delete(id);
    if (this.selectedTabId && !this.tabs.has(this.selectedTabId)) {
      this.selectedTabId = null;
      this.invalidate();
    }
    this.selectedTabId ??= this.tabs.keys().next().value ?? null;
  }

  /** Each Page object receives a fresh opaque id, including a reopened URL. */
  track(page: Page): string {
    for (const [id, known] of this.tabs) if (known === page) return id;
    const id = randomUUID();
    this.tabs.set(id, page);
    this.watch(page);
    this.metadata.track(page, {
      active: () => [...this.tabs.values()].includes(page),
      selected: () => this.tabs.get(this.selectedTabId ?? '') === page,
      invalidate: () => this.invalidate(),
      framesChanged: () => {
        this.frameChanges++;
        this.addresses(page);
        this.notify();
      },
      closed: () => {
        this.selectedTabId = null;
        this.invalidate();
      },
    });
    return id;
  }

  /** Synchronous revocation precedes asynchronous protocol cleanup. */
  invalidate(): void {
    this.revision++;
    this.observation = undefined;
    const nodes = this.observedNodes;
    this.observedNodes = undefined;
    this.notify();
    void nodes?.dispose().catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* An observer cannot interrupt revocation or handle disposal. */
      }
    }
  }
}
