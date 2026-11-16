/**
 * Which sites the one http:// fallback opened in each tab (DOR-4450). A page on
 * one of those sites, over http, says so to the person and to the agent, so
 * nobody types a password into a page they think is secure. The mark follows the
 * site the fallback opened, not the tab: another http site the tab reaches
 * never carries it, and Back to the fallback's site carries it again. Keyed by
 * the page handle, so a new browser connection starts with none.
 */
import type { Page } from 'playwright-core';

const opened = new WeakMap<Page, Set<string>>();

/** The page's origin, or null when its address doesn't parse. */
function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

/**
 * Record that the http:// fallback opened this page, at the address it landed on.
 *
 * @param page - The tab the person moved.
 */
export function markOpenedOverHttp(page: Page): void {
  const origin = originOf(page.url());
  if (!origin?.startsWith('http:')) return;
  const sites = opened.get(page) ?? new Set<string>();
  sites.add(origin);
  opened.set(page, sites);
}

/**
 * Whether this page is, right now, on a site the fallback opened, over http.
 *
 * @param page - The tab to describe.
 */
export function openedOverHttp(page: Page): boolean {
  const origin = originOf(page.url());
  return origin !== null && origin.startsWith('http:') && !!opened.get(page)?.has(origin);
}
