/**
 * Which tabs the one http:// fallback opened (DOR-4450). A page the fallback
 * opened says so, to the person and to the agent, for as long as it stays on
 * http, so nobody types a password into a page they think is secure. Keyed by
 * the page handle, so a new browser connection starts with none.
 */
import type { Page } from 'playwright-core';

const marked = new WeakSet<Page>();

/**
 * Record how a person's navigation opened this page: by the http:// fallback, or not.
 *
 * @param page - The tab the person moved.
 * @param opened - Whether the fallback opened it.
 */
export function setOpenedOverHttp(page: Page, opened: boolean): void {
  if (opened) marked.add(page);
  else marked.delete(page);
}

/**
 * Whether the fallback opened this page and it is still on http. Once the page
 * leaves http the mark is gone for good, so a later return to http does not
 * bring it back.
 *
 * @param page - The tab to describe.
 */
export function openedOverHttp(page: Page): boolean {
  if (!marked.has(page)) return false;
  if (page.url().startsWith('http:')) return true;
  marked.delete(page);
  return false;
}
