import type { Page } from 'playwright-core';
import type { BrowserPageState } from '../page-state.js';
import { refusalPageUrl } from '../../connection/navigation-refusal.js';
import { stalePageRefusal } from '../../errors.js';

interface RefusalOwner {
  state: BrowserPageState;
  identity(): { connectionId: string | null; connected: boolean; paused: boolean };
  page(): Page;
  protect(page: Page): void;
}

/** Metadata-only refusal evidence remains bound to one captured chat Page. */
export class BrowserPageRefusals {
  constructor(private readonly owner: RefusalOwner) {}
  lastHost(): string | null {
    const { state } = this.owner;
    const page = state.tabs.get(state.selectedTabId ?? '');
    return page && this.owner.identity().connected
      ? (state.navigation.refusal(page)?.host ??
          (state.observedNodes ? (state.observation?.refusal?.host ?? null) : null))
      : null;
  }
  identity(): string | null {
    if (this.lastHost() === null) return null;
    const { state } = this.owner;
    return JSON.stringify([
      this.owner.identity().connectionId,
      state.selectedTabId,
      refusalPageUrl(state.tabs.get(state.selectedTabId!)!.url()),
    ]);
  }
  has(tabId = this.owner.state.selectedTabId, url?: string): boolean {
    const { state } = this.owner;
    const identity = this.owner.identity();
    const page = state.tabs.get(state.selectedTabId ?? '');
    return !!(
      page &&
      identity.connected &&
      !identity.paused &&
      tabId === state.selectedTabId &&
      (!url || refusalPageUrl(url) === refusalPageUrl(page.url())) &&
      state.navigation.refusal(page)
    );
  }
  requireCurrent(tabId: string, url: string): void {
    this.owner.protect(this.owner.page());
    if (!this.has(tabId, url)) throw stalePageRefusal();
  }
  observe() {
    const page = this.owner.page();
    this.owner.protect(page);
    if (!this.has()) throw stalePageRefusal();
    return this.owner.state.observeRefusal(page, () => this.owner.protect(page));
  }
}
