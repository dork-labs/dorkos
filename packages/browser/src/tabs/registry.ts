import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright-core';
import { advanceCounter } from '../counters.js';
import { parseTabId } from '../ids.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';

/** Own the canonical record before Page callbacks; parent retirement precedes child listeners. */
export function trackPage(record: BrowserRecord, page: Page, origin: string): TabRecord {
  const prior = [...record.tabs.values()].find((tab) => tab.page === page);
  if (prior) return prior;
  const tab: TabRecord = {
    page,
    binding: {
      browserId: record.browserId,
      browserGeneration: record.browserGeneration,
      tabId: parseTabId(randomBytes(16).toString('base64url')),
      navigationGeneration: 0,
      viewportVersion: 0,
      epoch: 0,
      inputGeneration: 0,
    },
    stopped: record.lifetime.gate.stopped,
    captureSequence: 0,
    tail: Promise.resolve(),
    pending: 0,
  };
  record.tabs.set(tab.binding.tabId, tab);
  const retire = () => {
    tab.stopped = true;
    record.lifetime.gate.stop();
    record.lifetime.retire?.();
  };
  record.lifetime.gate.register(tab.binding, () => {
    tab.stopped = true;
    record.lifetime.retire?.();
  });
  if (tab.stopped) return tab;
  try {
    const active = () =>
      record.tabs.get(tab.binding.tabId) === tab && !tab.stopped && !record.lifetime.gate.stopped;
    const timeout = page.setDefaultTimeout;
    if (!active()) return tab;
    Reflect.apply(timeout, page, [1500]);
    const navigationTimeout = page.setDefaultNavigationTimeout;
    if (!active()) return tab;
    Reflect.apply(navigationTimeout, page, [1500]);
    const onClose = page.on;
    if (!active()) return tab;
    Reflect.apply(onClose, page, ['close', retire]);
    const onNavigation = page.on;
    if (!active()) return tab;
    Reflect.apply(onNavigation, page, [
      'framenavigated',
      (frame: import('playwright-core').Frame) => {
        if (frame !== page.mainFrame()) return;
        if (record.tabs.get(tab.binding.tabId) !== tab || record.lifetime.gate.stopped) {
          retire();
          return;
        }
        try {
          tab.binding = {
            ...tab.binding,
            navigationGeneration: advanceCounter(tab.binding.navigationGeneration),
          };
          if (
            !tab.initialNavigation ||
            record.status !== 'opening' ||
            (frame.url() !== 'about:blank' && new URL(frame.url()).origin !== origin)
          )
            retire();
        } catch {
          retire();
        }
      },
    ]);
  } catch (error) {
    retire();
    throw new Error('PAGE_REGISTRATION_FAILED', { cause: error });
  }
  return tab;
}
