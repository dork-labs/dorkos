import type { DiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import type { DiagnosticsOwner } from '../tabs/diagnostics.js';
import type { PointerLedger } from '../tabs/pointer.js';
import type { BrowserLifetime } from './ownership.js';
import type { BrowserContext, Page } from 'playwright-core';
import type { BrowserBinding, BrowserCommand, BrowserResult } from '../contracts.js';
import type { ProcessIdentity } from '../configuration.js';
import type { ProfileId, BrowserId, TabId } from '../ids.js';
import type { ProfileReservation } from '../profiles/reservation.js';
import type { OwnedDirectory } from '../profiles/owned-directory.js';
import type { FixtureProxy } from '../network/fixture-proxy.js';

/** Internal acquisition ledger, allocated before any owned browser can launch. */
export interface BrowserRecord {
  diagnosticsBudget: DiagnosticsBudget;
  lifetime: BrowserLifetime;
  browserId: BrowserId;
  browserGeneration: number;
  mode: 'persistent' | 'ephemeral';
  profileId?: ProfileId;
  profileDir?: string;
  directory?: OwnedDirectory;
  dataRoot?: OwnedDirectory;
  reservation?: ProfileReservation;
  context?: BrowserContext;
  proxy?: FixtureProxy;
  manager: ProcessIdentity;
  root?: ProcessIdentity;
  rootAttributed: boolean;
  identities: readonly ProcessIdentity[];
  inventoryComplete: boolean;
  launchEntered: boolean;
  setupCleanupUncertain?: boolean;
  status: 'opening' | 'running' | 'stopping' | 'stopped' | 'uncertain';
  tabs: Map<TabId, TabRecord>;
  closePromise?: Promise<CloseOutcome>;
}
/** Private canonical Page and immutable-lifetime capture sequencing. */
export interface TabRecord {
  pointer: PointerLedger;
  diagnostics: DiagnosticsOwner;
  page: Page;
  binding: BrowserBinding;
  stopped: boolean;
  captureSequence: number;
  tail: Promise<void>;
  pending: number;
  initialNavigation?: boolean;
}
/** Applicable opened result, with its initial actual canonical Page binding. */
export type OpenedResult = Extract<BrowserResult, { kind: 'opened' }>;
/** Capture command requiring exact canonical identities and policy approval. */
export type CaptureCommand = Extract<BrowserCommand, { kind: 'capture' }>;
/** Fixed cleanup observations cannot certify unknown process disappearance. */
export type CloseOutcome =
  | { cleanup: 'observed' }
  | {
      cleanup: 'failed' | 'unverified';
      reason: 'processesRemain' | 'observationUnavailable' | 'closeFailed';
    };
