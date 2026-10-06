import type { Frame, Page } from 'playwright-core';
import type { TabRecord } from '../lifecycle/records.js';

const observers = new WeakMap<
  TabRecord,
  Readonly<{ page: Page; observe(frame: Frame): boolean | null }>
>();

/** Constructor-private original observer; no URL/body or latest input grants continuation. */
export function registerOwnerSameDocument(
  tab: TabRecord,
  page: Page,
  observe: (frame: Frame) => boolean | null
): void {
  if (tab.page !== page || observers.has(tab)) throw new Error('OWNER_NAVIGATION_OBSERVER_REFUSED');
  observers.set(tab, Object.freeze({ page, observe }));
}

/** Registry supplies the genuine original native Frame before canonical generation changes. */
export function observeOwnerSameDocument(tab: TabRecord, page: Page, frame: Frame): boolean | null {
  const original = observers.get(tab);
  if (!original || original.page !== page || tab.page !== page) return null;
  return original.observe(frame);
}
