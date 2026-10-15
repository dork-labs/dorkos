import type { Page } from 'playwright-core';
import type { LocalBrowserTab } from '@dorkos/shared/local-browser';

/** Event-refreshed tab labels; polling never evaluates an unrelated page's document. */
export class LocalBrowserTabMetadata {
  private tracked = new WeakSet<Page>();
  private entries = new WeakMap<Page, { title: string; url: string; pending: boolean }>();

  /** Register page-event refresh and selection invalidation once for this page handle. */
  track(
    page: Page,
    owner: {
      active(): boolean;
      selected(): boolean;
      invalidate(): void;
      closed(): void;
    }
  ): void {
    if (this.tracked.has(page)) return;
    this.tracked.add(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || !owner.active()) return;
      this.refresh(page, { newDocument: true });
      if (owner.selected()) owner.invalidate();
    });
    page.on('domcontentloaded', () => {
      if (owner.active()) this.refresh(page, { newDocument: true });
    });
    page.on('close', () => {
      if (owner.selected()) owner.closed();
    });
  }

  /** Capture cached metadata only for entries already admitted by the caller's scope. */
  describe(pages: Iterable<[string, Page]>): LocalBrowserTab[] {
    return [...pages].map(([id, page]) => ({
      id,
      url: page.url(),
      title: this.entries.get(page)?.url === page.url() ? this.entries.get(page)!.title : '',
    }));
  }

  /** Refresh without waiting, retaining same-document labels and deduplicating pending reads. */
  refresh(page: Page, options: { newDocument?: boolean } = {}): void {
    const entries = this.entries;
    const url = page.url();
    const previous = entries.get(page);
    if (previous?.pending && previous.url === url && !options.newDocument) return;
    const record = {
      title: !options.newDocument && previous?.url === url ? previous.title : '',
      url,
      pending: true,
    };
    entries.set(page, record);
    void page
      .title()
      .then((title) => {
        record.pending = false;
        if (
          this.entries === entries &&
          entries.get(page) === record &&
          !page.isClosed() &&
          page.url() === url
        )
          record.title = title;
      })
      .catch(() => {
        record.pending = false;
      });
  }

  /** Fence pending metadata from an older browser connection. */
  clear(): void {
    this.entries = new WeakMap();
  }
}
