import type { Page, JSHandle } from 'playwright-core';
import type { LocalBrowserObservation } from '@dorkos/shared/local-browser';
import type { ObservedPageNodes } from '../observation-nodes.js';
import { observeSelectedPage, screenshotSelectedPage } from './observe-page.js';

interface ReadingOwner {
  page(): Page;
  tabId(): string;
  revision(): number;
  frames(): number;
  invalidate(): void;
  refuse(page: Page): void;
  stale(): Error;
}

/** The existing selected-page read cache and its disposal, separate from browser acquisition. */
export class LocalBrowserPageReadings {
  observation?: LocalBrowserObservation;
  nodes?: JSHandle<ObservedPageNodes>;

  constructor(private readonly owner: ReadingOwner) {}

  async observe(): Promise<LocalBrowserObservation> {
    const page = this.owner.page();
    this.owner.refuse(page);
    this.owner.invalidate();
    const observed = await observeSelectedPage(page, this.owner.tabId(), {
      revision: this.owner.revision,
      frames: this.owner.frames,
      refuse: () => this.owner.refuse(page),
      stale: this.owner.stale,
    });
    this.nodes = observed.nodes;
    this.observation = observed.observation;
    return observed.observation;
  }

  /** Pixel capture grants no new action observation. */
  async screenshot(): Promise<{ data: string; mimeType: string; revision: number; tabId: string }> {
    const page = this.owner.page();
    return screenshotSelectedPage(
      page,
      () => ({
        revision: this.owner.revision(),
        tabId: this.owner.tabId(),
        frames: this.owner.frames(),
      }),
      () => this.owner.refuse(page)
    );
  }

  /** Invalidation fences admission synchronously; protocol disposal cannot delay it. */
  clear(): void {
    this.observation = undefined;
    const nodes = this.nodes;
    this.nodes = undefined;
    void nodes?.dispose().catch(() => undefined);
  }
}
