import type { BrowserContext, Page } from 'playwright-core';
import type { BrowserRecord } from '../lifecycle/records.js';
import { ordinaryRecord } from '../lifecycle/ownership.js';

export type BrowserCrashCause = 'renderer' | 'browser';
type CrashOwner = {
  readonly context: BrowserContext;
  readonly pages: Set<Page>;
  firstCause: BrowserCrashCause | null;
  rootFailed: (() => void) | null;
};
const owners = new WeakMap<BrowserRecord, CrashOwner>();

/** Read only the original native event cause; later cleanup cannot rewrite it. */
export function observedCrashCause(record: BrowserRecord): BrowserCrashCause | null {
  return owners.get(record)?.firstCause ?? null;
}

/** Actual original supervisor child exit; a preceding input-loss fence does not erase native cause. */
export function noteOriginalRootFailure(record: BrowserRecord): void {
  const owner = owners.get(record);
  if (owner?.rootFailed) owner.rootFailed();
  else {
    record.lifetime.uncertain = true;
    record.lifetime.requestRetirement('engineFault');
  }
}

/** Bind original public native events before input admission; never reconstruct a lost target. */
export function ownCrashRetirement(record: BrowserRecord, context: BrowserContext): void {
  if (owners.has(record) || !ordinaryRecord(record) || record.context !== context)
    throw new Error('CRASH_OWNER_REFUSED');
  const owner: CrashOwner = { context, pages: new Set(), firstCause: null, rootFailed: null };
  owners.set(record, owner);
  const crashed = (cause: BrowserCrashCause) => {
    if (!ordinaryRecord(record) || record.context !== context) return;
    const first = owner.firstCause === null;
    owner.firstCause ??= cause;
    // Fence before persistence getters or callbacks can reenter native input admission.
    record.lifetime.requestRetirement('engineFault');
    if (first) {
      try {
        record.reservation?.recordFailure(cause);
      } catch {
        record.lifetime.uncertain = true;
      }
    }
  };
  owner.rootFailed = () => {
    const cell = record.lifetime.ordinary;
    if (
      owner.context !== record.context ||
      cell.record !== record ||
      !cell.records ||
      Map.prototype.get.call(cell.records, record.browserId) !== record
    )
      return;
    if (cell.phase !== 'ordinary' && cell.retirement.firstCause !== 'engineFault') return;
    if (owner.firstCause) return;
    owner.firstCause = 'browser';
    record.lifetime.requestRetirement('engineFault');
    try {
      record.reservation?.recordFailure('browser');
    } catch {
      record.lifetime.uncertain = true;
    }
  };
  const page = (original: Page) => {
    if (!ordinaryRecord(record) || record.context !== context || owner.pages.has(original)) return;
    if (owner.pages.size >= 128) throw new Error('CRASH_PAGE_CAPACITY');
    owner.pages.add(original);
    const on = original.on;
    if (!ordinaryRecord(record)) return;
    Reflect.apply(on, original, ['crash', () => crashed('renderer')]);
  };
  try {
    const browser = record.controllerBrowser ?? context.browser();
    if (!browser) throw new Error('CRASH_BROWSER_UNAVAILABLE');
    const browserOn = browser.on;
    if (!ordinaryRecord(record)) throw new Error('CRASH_OWNER_REFUSED');
    Reflect.apply(browserOn, browser, ['disconnected', () => crashed('browser')]);
    const contextOn = context.on;
    if (!ordinaryRecord(record)) throw new Error('CRASH_OWNER_REFUSED');
    // Public context loss may arrive before Browser's disconnected event.
    Reflect.apply(contextOn, context, ['close', () => crashed('browser')]);
    if (!ordinaryRecord(record)) throw new Error('CRASH_OWNER_REFUSED');
    Reflect.apply(contextOn, context, [
      'page',
      (original: Page) => {
        try {
          page(original);
        } catch {
          record.lifetime.uncertain = true;
          record.lifetime.requestRetirement('engineFault');
        }
      },
    ]);
    const pages = context.pages;
    if (!ordinaryRecord(record)) throw new Error('CRASH_OWNER_REFUSED');
    for (const original of Reflect.apply(pages, context, []) as Page[]) page(original);
    if (!ordinaryRecord(record)) throw new Error('CRASH_OWNER_REFUSED');
  } catch (error) {
    record.lifetime.requestRetirement('engineFault');
    throw error;
  }
}
