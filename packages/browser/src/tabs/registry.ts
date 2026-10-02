import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright-core';
import { advanceCounter } from '../counters.js';
import { parseTabId } from '../ids.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';

/** Register Pages once; IDs never rebind and frame navigations advance safely. */
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
    stopped: false,
    captureSequence: 0,
    tail: Promise.resolve(),
    pending: 0,
  };
  record.tabs.set(tab.binding.tabId, tab);
  page.setDefaultTimeout(1500);
  page.setDefaultNavigationTimeout(1500);
  page.on('close', () => {
    tab.stopped = true;
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      tab.binding = {
        ...tab.binding,
        navigationGeneration: advanceCounter(tab.binding.navigationGeneration),
      };
    } catch {
      tab.stopped = true;
      void page.close().catch(() => {});
      return;
    }
    if (frame.url() !== 'about:blank' && new URL(frame.url()).origin !== origin) {
      tab.stopped = true;
      void page.close().catch(() => {});
    }
  });
  return tab;
}
