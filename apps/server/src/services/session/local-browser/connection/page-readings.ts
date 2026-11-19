import type { Page, JSHandle } from 'playwright-core';
import type { LocalBrowserObservation } from '@dorkos/shared/local-browser';
import { localBrowserRefusalNext } from '@dorkos/shared/local-browser-refusal';
import type { ObservedPageNodes } from '../observation-nodes.js';
import { NavigationRefusals, refusalPageUrl } from './navigation-refusal.js';
import { observeSelectedPage, screenshotSelectedPage } from './observe-page.js';

interface ReadingOwner {
  state(): {
    page?: Page;
    connectionId: string | null;
    tabId: string | null;
    connected: boolean;
    paused: boolean;
    revision: number;
    frames: number;
  };
  page(): Page;
  protect(page: Page): void;
  invalidate(): void;
  stale(): Error;
}

/** Owns DOM reading leases separately from bounded, browser-event refusal evidence. */
export class BrowserPageReadings {
  readonly navigation = new NavigationRefusals();
  observation?: LocalBrowserObservation;
  nodes?: JSHandle<ObservedPageNodes>;

  constructor(private readonly owner: ReadingOwner) {}

  /** Invalidate handles synchronously; protocol disposal cannot delay admission fences. */
  clear(): void {
    this.observation = undefined;
    const nodes = this.nodes;
    this.nodes = undefined;
    void nodes?.dispose().catch(() => undefined);
  }

  lastRefusalHost(): string | null {
    const { page, connected } = this.owner.state();
    return page && connected
      ? (this.navigation.refusal(page)?.host ??
          (this.nodes ? (this.observation?.refusal?.host ?? null) : null))
      : null;
  }

  /** Opaque identity from this connection, selected tab and exact live web address. */
  refusalIdentity(): string | null {
    if (this.lastRefusalHost() === null) return null;
    const { connectionId, tabId, page } = this.owner.state();
    return JSON.stringify([connectionId, tabId, refusalPageUrl(page!.url())]);
  }

  hasNavigationRefusal(tabId = this.owner.state().tabId, url?: string): boolean {
    const state = this.owner.state();
    return !!(
      state.page &&
      state.connected &&
      !state.paused &&
      tabId === state.tabId &&
      (!url || refusalPageUrl(url) === refusalPageUrl(state.page.url())) &&
      this.navigation.refusal(state.page)
    );
  }

  /** Recheck protected frames and exact proof after every capability admission await. */
  requireRefusalCurrent(tabId: string, url: string): void {
    this.owner.protect(this.owner.page());
    if (!this.hasNavigationRefusal(tabId, url)) throw this.owner.stale();
  }

  /** Metadata only: a reload proof grants no DOM handles or actionable reading. */
  observeRefusal(): LocalBrowserObservation {
    const page = this.owner.page();
    this.owner.protect(page);
    if (!this.hasNavigationRefusal()) throw this.owner.stale();
    this.owner.invalidate();
    const refusal = this.navigation.refusal(page)!;
    const state = this.owner.state();
    return (this.observation = {
      revision: state.revision,
      tabId: state.tabId!,
      url: page.url(),
      snapshot: '',
      refusal: { ...refusal, next: localBrowserRefusalNext(refusal.kind) },
    });
  }

  async observe(): Promise<LocalBrowserObservation> {
    const page = this.owner.page();
    this.owner.protect(page);
    if (this.hasNavigationRefusal()) return this.observeRefusal();
    this.owner.invalidate();
    const observed = await observeSelectedPage(page, this.owner.state().tabId!, {
      revision: () => this.owner.state().revision,
      frames: () => this.owner.state().frames,
      refuse: () => this.owner.protect(page),
      stale: () => this.owner.stale(),
    });
    this.navigation.readSnapshot(page, observed.observation.snapshot);
    if (this.hasNavigationRefusal()) {
      void observed.nodes.dispose().catch(() => undefined);
      return this.observeRefusal();
    }
    this.nodes = observed.nodes;
    this.observation = observed.observation;
    return observed.observation;
  }

  /** Pixels keep the same lease checks and never grant new DOM handles. */
  async screenshot() {
    const page = this.owner.page();
    return screenshotSelectedPage(
      page,
      () => {
        const { revision, tabId, frames } = this.owner.state();
        return { revision, tabId: tabId!, frames };
      },
      () => this.owner.protect(page)
    );
  }
}
