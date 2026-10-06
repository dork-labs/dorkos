import { observeOwnerSameDocument } from '../navigation/owner-same-document.js';
import { commitNavigation } from '../navigation/cohort.js';
import { commitInitialNavigation } from '../lifecycle/initial-navigation-state.js';
import { observePopup, commitPopup } from './popup-navigation.js';
import { createPointerLedger } from './pointer.js';
import { ordinaryRecord } from '../lifecycle/ownership.js';
import { createDiagnosticsOwner, unavailableDiagnostics } from './diagnostics.js';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright-core';
import { advanceCounter } from '../counters.js';
import { parseTabId } from '../ids.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';

/** Own the canonical record before Page callbacks; parent retirement precedes child listeners. */
export function trackPage(
  record: BrowserRecord,
  page: Page,
  origin: string,
  now: () => number,
  observedContext?: import('playwright-core').BrowserContext
): TabRecord {
  if (!ordinaryRecord(record)) throw new Error('PAGE_REGISTRATION_REFUSED');
  const prior = [...record.tabs.values()].find((tab) => tab.page === page);
  if (prior) return prior;
  const currentBinding = () =>
    tab &&
    ordinaryRecord(record) &&
    record.tabs.get(tab.binding.tabId) === tab &&
    !tab.stopped &&
    !record.lifetime.gate.stopped
      ? { ...tab.binding }
      : null;
  const pointer = createPointerLedger(currentBinding);
  const tab: TabRecord = {
    pointer,
    diagnostics: unavailableDiagnostics,
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
  if (observedContext && record.tabs.size > 1) observePopup(record, tab, observedContext);
  tab.diagnostics = createDiagnosticsOwner({
    budget: record.diagnosticsBudget,
    readBinding: currentBinding,
    now,
  });
  const retire = () => {
    // Local changed-target refusal precedes cohort capture; no shared terminal gate yet.
    tab.stopped = true;
    record.lifetime.requestRetirement('engineFault');
    for (const invalidate of [() => tab.pointer.invalidate(), () => tab.diagnostics.discard()]) {
      try {
        invalidate();
      } catch {
        record.lifetime.uncertain = true;
      }
    }
  };
  record.lifetime.gate.register(tab.binding, () => {
    tab.pointer.invalidate();
    tab.diagnostics.discard();
    tab.stopped = true;
    record.lifetime.requestRetirement('engineFault');
  });
  if (tab.stopped || record.lifetime.gate.stopped) {
    tab.diagnostics.discard();
    return tab;
  }
  try {
    const active = () =>
      ordinaryRecord(record) &&
      record.tabs.get(tab.binding.tabId) === tab &&
      !tab.stopped &&
      !record.lifetime.gate.stopped;
    tab.diagnostics.install(page);
    if (!active()) return tab;
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
        if (
          !ordinaryRecord(record) ||
          record.tabs.get(tab.binding.tabId) !== tab ||
          record.lifetime.gate.stopped
        ) {
          retire();
          return;
        }
        try {
          tab.pointer.invalidate();
          const popupCommit = commitPopup(tab, page, frame.url(), origin);
          if (popupCommit) {
            void popupCommit.then((accepted) => {
              if (!accepted) retire();
            }, retire);
            return;
          }
          const navigationCommit = commitNavigation(tab, frame.url());
          if (navigationCommit !== null) {
            if (!navigationCommit) retire();
            else tab.diagnostics.replaceEpoch();
            return;
          }
          const initialCommit = commitInitialNavigation(tab, frame.url());
          if (initialCommit !== null) {
            if (!initialCommit) retire();
            else tab.diagnostics.replaceEpoch();
            return;
          }
          const sameDocument = observeOwnerSameDocument(tab, page, frame);
          if (sameDocument !== null) {
            if (!sameDocument) retire();
            return;
          }
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
          else tab.diagnostics.replaceEpoch();
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
