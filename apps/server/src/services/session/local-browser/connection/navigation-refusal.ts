import type { Page, Request } from 'playwright-core';
import type { LocalBrowserRefusal } from '@dorkos/shared/local-browser-refusal';

const LOOP_WINDOW_MS = 8_000;
const PROOF_LIFETIME_MS = 10_000;
const EMPTY_GRACE_MS = 2_000;
const LOOP_COMMITS = 4; // The initial document and three repeats.

interface Reading {
  url: string | null;
  pending?: Request;
  commits: number[];
  loadedAt?: number;
  expiresAt?: number;
}

/** An exact web address, with a fragment excluded because it cannot reload a document. */
export function refusalPageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** Browser-event evidence, independent of DOM handles and never supplied by a renderer or tool. */
export class NavigationRefusals {
  private readonly readings = new Map<Page, Reading>();
  private readonly watched = new WeakSet<Page>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Start observing only this server's Page's own main-frame requests and commits. */
  watch(page: Page): void {
    this.readings.set(page, { url: refusalPageUrl(page.url()), commits: [] });
    if (this.watched.has(page)) return;
    this.watched.add(page);
    page.on('request', (request) => {
      const reading = this.readings.get(page);
      if (!reading || !request.isNavigationRequest()) return;
      try {
        if (request.frame() !== page.mainFrame()) return;
      } catch {
        return;
      }
      if (refusalPageUrl(request.url()) !== reading.url) {
        reading.commits = [];
        reading.expiresAt = undefined;
        reading.loadedAt = undefined;
      }
      reading.pending = request;
    });
    page.on('requestfailed', (request) => {
      const reading = this.readings.get(page);
      if (reading?.pending === request) reading.pending = undefined;
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const reading = this.readings.get(page);
      if (!reading) return;
      const url = refusalPageUrl(page.url());
      if (url !== reading.url) {
        reading.url = url;
        reading.commits = [];
        reading.expiresAt = undefined;
        reading.loadedAt = undefined;
      }
      // Same-document events do not have a navigation request. Subframes never get here.
      if (!reading.pending || !url) return;
      reading.pending = undefined;
      reading.loadedAt = undefined;
      const now = this.now();
      reading.commits = [...reading.commits.filter((at) => now - at <= LOOP_WINDOW_MS), now].slice(
        -LOOP_COMMITS
      );
      if (reading.commits.length === LOOP_COMMITS) reading.expiresAt = now + PROOF_LIFETIME_MS;
    });
    page.on('domcontentloaded', () => {
      const reading = this.readings.get(page);
      if (reading && reading.url === refusalPageUrl(page.url())) reading.loadedAt = this.now();
    });
    page.on('close', () => this.readings.delete(page));
  }

  /** Record only an actual successful empty snapshot after this document's load grace period. */
  readSnapshot(page: Page, snapshot: string): void {
    const reading = this.readings.get(page);
    if (
      !reading?.url ||
      reading.url !== refusalPageUrl(page.url()) ||
      snapshot.trim() !== '' ||
      reading.loadedAt === undefined ||
      this.now() - reading.loadedAt < EMPTY_GRACE_MS
    )
      return;
    // Further reads cannot refresh proof; only the browser's new-document events can.
    reading.expiresAt ??= this.now() + PROOF_LIFETIME_MS;
  }

  /** Read bounded proof only for the very same live page and exact address. */
  refusal(page: Page): LocalBrowserRefusal | null {
    const reading = this.readings.get(page);
    if (
      !reading?.url ||
      page.isClosed() ||
      reading.url !== refusalPageUrl(page.url()) ||
      reading.expiresAt === undefined ||
      this.now() >= reading.expiresAt
    )
      return null;
    return { kind: 'blocked', host: new URL(reading.url).host };
  }

  /** A tab/owner/profile/connection move discards all evidence, including pending reads. */
  reset(): void {
    for (const page of this.readings.keys())
      this.readings.set(page, { url: refusalPageUrl(page.url()), commits: [] });
  }

  /** Drop closed connection pages; listeners on them cannot create new records. */
  clear(): void {
    this.readings.clear();
  }
}
