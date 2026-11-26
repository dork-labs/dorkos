/**
 * Hand the computer side the asks port, and the space side's consent writers
 * what they write through (spec `computer-side-starts-alone` §5.7).
 *
 * - The asks port: the space side's cards and standing-decision writes
 *   (`services/core/approvals/computer-asks/`), filled into the slot each
 *   computer-side folder that asks keeps. Each slot's unset answer is
 *   fail-closed (nobody asked, nothing recorded).
 * - The consent writes: the config store and write log the consent door
 *   writes `harness` and `permissions` through (`consent-config.ts`), and the
 *   hook decision writers the marketplace's consent code records through
 *   (`marketplace/consent/hook-entry-writers.ts`). Unwired, each of those
 *   throws on every write rather than skip one.
 *
 * Runs before any step that can start a turn, so an upgrade pin or a
 * first-use pin is never dropped; the approval service the cards are raised
 * through comes later (`setAskApprovals`). A composition root: it may import
 * every side.
 *
 * @module startup/computer-asks
 */
import type { ComputerAsks } from '@dorkos/shared/computer-asks';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { computerAsks } from '../services/core/approvals/computer-asks/index.js';
import {
  setConsentConfigStore,
  type ConsentConfigStore,
} from '../services/core/approvals/computer-asks/consent-config.js';
import {
  forgetApprovedEntries,
  recordApprovedEntry,
  recordRefusedEntry,
} from '../services/core/approvals/computer-asks/hook-decisions.js';
import { setHookEntryWriters } from '../services/marketplace/consent/hook-entry-writers.js';
import { setHarnessAsks } from '../services/harness/computer-asks.js';
import { setRuntimeAsks } from '../services/runtimes/computer-asks.js';
import { setWorkspaceAsks } from '../services/workspace/computer-asks.js';

/** The consent door's store over the running process's config and its write log. */
export const configConsentStore: ConsentConfigStore = {
  get: (section) => configManager.get(section),
  set: (section, value) => configManager.set(section, value),
  logWrite: (reason, section, before, after) => logConfigWrite(reason, section, before, after),
};

/**
 * Hand the consent door its config store and the marketplace its hook
 * decision writers.
 *
 * @param store - The store; the running process's config by default.
 */
export function wireConsentWrites(store: ConsentConfigStore = configConsentStore): void {
  setConsentConfigStore(store);
  setHookEntryWriters({
    recordApproved: recordApprovedEntry,
    recordRefused: recordRefusedEntry,
    forgetApproved: forgetApprovedEntries,
  });
}

/**
 * Fill every computer-side asks slot with one port, and wire the consent
 * writes behind it ({@link wireConsentWrites}).
 *
 * @param asks - The port; the space side's own by default.
 */
export function wireComputerAsks(asks: ComputerAsks = computerAsks): void {
  wireConsentWrites();
  setRuntimeAsks(asks);
  setHarnessAsks(asks);
  setWorkspaceAsks(asks);
}
