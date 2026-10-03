import path from 'path';

import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import type { ExtensionApprovedSource, UserConfig } from '@dorkos/shared/config-schema';
import { isEnabled } from '../extension-enable-resolution.js';

import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';

import { toPublic } from '../extension-manager-types.js';
import { approvedSourceOf, isApprovedCopy } from '../extension-load-policy.js';
import { logger } from '../../../lib/logger.js';

import type { ManagerState } from './state.js';
export type DismissApprovalRefusal = 'not_found' | 'core' | 'stale';
export interface ExpectedCopy {
  /** Absent when the caller does not know it (the Settings card); then not compared. */
  path?: string;
  version: string;
  plugin?: string | null;
}
/** Match an approval decision to the exact advertised copy. */
export function isExpectedCopy(record: ExtensionRecord, expected: ExpectedCopy): boolean {
  if (expected.path !== undefined && path.resolve(expected.path) !== path.resolve(record.path)) {
    return false;
  }
  if (expected.version !== record.manifest.version) return false;
  if (expected.plugin !== undefined && expected.plugin !== (record.sourcePlugin ?? null)) {
    return false;
  }
  return true;
}
function isPathWithin(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** Record trust for the selected source and refresh its copies. */
export async function trustSource(
  state: ManagerState,
  source: string
): Promise<'added' | 'already' | 'unproven'> {
  const known = [...state.extensions.values(), ...state.shadowed].some(
    (rec) => rec.trustedOrigin?.source === source
  );
  const before = configManager.get('extensions');
  const trusted = before.trustedSources ?? [];
  if (trusted.some((entry) => entry.source === source)) return 'already';
  if (!known) return 'unproven';
  configManager.set('extensions', {
    ...before,
    trustedSources: [...trusted, { source, trustedAt: new Date().toISOString() }],
  });
  logConfigWrite('trusting a code source', 'extensions', before, configManager.get('extensions'));
  // Copies from it may run now; the scan that starts them runs after this
  // answer, and clients hear from the `extension_reloaded` broadcast.
  state.operations.emitChanged();
  state.operations.requestRefresh();
  return 'added';
}

/** Withdraw source trust before retiring its active copies. */
export async function untrustSource(state: ManagerState, source: string): Promise<boolean> {
  const before = configManager.get('extensions');
  const trusted = before.trustedSources ?? [];
  if (!trusted.some((entry) => entry.source === source)) return false;
  const approvedToRun = [...before.approvedToRun];
  const approvedSources = { ...(before.approvedSources ?? {}) };
  for (const rec of state.extensions.values()) {
    if (rec.origin !== 'user' || rec.trustedOrigin?.source !== source) continue;
    if (isApprovedCopy(rec, before)) continue;
    if (!isEnabled(rec.id, before, state.coreExtensions)) continue;
    if (!approvedToRun.includes(rec.id)) approvedToRun.push(rec.id);
    // Pinned to this copy's files alone: no origin, so a newer copy from the
    // source does not ride on it, and its digest, so it keeps running from
    // the verified snapshot of exactly those files and any change asks again.
    const { origin: _origin, ...pinned } = approvedSourceOf(rec);
    approvedSources[rec.id] = rec.currentDigest ? { ...pinned, digest: rec.currentDigest } : pinned;
  }
  configManager.set('extensions', {
    ...before,
    approvedToRun,
    approvedSources,
    trustedSources: trusted.filter((entry) => entry.source !== source),
  });
  logConfigWrite(
    'no longer trusting a code source',
    'extensions',
    before,
    configManager.get('extensions')
  );
  state.operations.emitChanged();
  state.operations.requestRefresh();
  return true;
}

/** Find the current source offer eligible for an explicit trust decision. */
export function trustOfferFor(state: ManagerState, id: string): string | null {
  const record = state.extensions.get(id);
  const source = record?.trustedOrigin?.source;
  if (!record || record.origin !== 'user' || !source) return null;
  const trusted = configManager.get('extensions').trustedSources ?? [];
  return trusted.some((entry) => entry.source === source) ? null : source;
}

/** Bind older ID-only approvals to the currently discovered copies. */
export function bindUnsourcedApprovals(
  state: ManagerState,
  records: readonly ExtensionRecord[]
): void {
  const before = configManager.get('extensions');
  const sources = before.approvedSources ?? {};
  const additions: Record<string, ExtensionApprovedSource> = {};
  for (const record of records) {
    if (!before.approvedToRun.includes(record.id) || sources[record.id]) continue;
    if (record.origin === 'core' || record.sourcePlugin) continue;
    const directInstall = path.join(path.resolve(state.dorkHome), 'extensions', record.id);
    if (path.resolve(record.path) !== directInstall) continue;
    additions[record.id] = approvedSourceOf(record);
  }
  if (Object.keys(additions).length === 0) return;
  configManager.set('extensions', {
    ...before,
    approvedSources: { ...sources, ...additions },
  });
  logConfigWrite(
    'recording which copy an earlier extension approval was for',
    'extensions',
    before,
    configManager.get('extensions')
  );
}

/** Approve the exact selected copy and compile its current code. */
export async function approveToRun(
  state: ManagerState,
  id: string
): Promise<ExtensionRecordPublic | null> {
  const record = state.extensions.get(id);
  if (!record) return null;

  // The approval is for THIS copy (DOR-2383): record its directory and carrying
  // plugin beside the id, replacing whatever copy an earlier approval named.
  const extensions = configManager.get('extensions');
  const source = approvedSourceOf(record);
  // A copy whose plugin changed after DorkOS installed it is approved as its
  // files are now, and every compile holds it to exactly those files.
  if (record.originProblem === 'changed' && record.currentDigest) {
    record.pinnedDigest = record.currentDigest;
  }
  const dismissed = extensions.dismissedApprovals ?? {};
  if (!isApprovedCopy(record, extensions) || dismissed[id]) {
    // A "Not now" for this id is answered by the approval, so it goes too
    // (DOR-2517): a later withdrawal plus reinstall asks again rather than
    // staying silenced by a decline the person has since reversed.
    const next = {
      ...extensions,
      approvedToRun: extensions.approvedToRun.includes(id)
        ? extensions.approvedToRun
        : [...extensions.approvedToRun, id],
      approvedSources: { ...(extensions.approvedSources ?? {}), [id]: source },
    };
    if (dismissed[id]) {
      const remainingDismissals = { ...dismissed };
      delete remainingDismissals[id];
      next.dismissedApprovals = remainingDismissals;
    }
    configManager.set('extensions', next);
    logConfigWrite(
      'approving an extension to run',
      'extensions',
      extensions,
      configManager.get('extensions')
    );
  }

  // A yes to these exact files runs them from their verified snapshot,
  // from the first start on.
  await state.operations.placeSnapshots([record]);

  await initializeApprovedServer(state, record);

  state.operations.emitChanged();
  return toPublic(record, configManager.get('extensions'));
}

/** Dismiss a prompt only when its current copy still matches. */
export function dismissApproval(
  state: ManagerState,
  id: string,
  expected: ExpectedCopy
): { ok: true } | { ok: false; reason: DismissApprovalRefusal } {
  const record = state.extensions.get(id);
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.origin === 'core') return { ok: false, reason: 'core' };
  if (!isExpectedCopy(record, expected)) return { ok: false, reason: 'stale' };

  recordDismissal(state, record, 'declining an extension for now');
  state.operations.emitChanged();
  return { ok: true };
}

/** Record the dismissal for the exact copy and source identity. */
export function recordDismissal(
  state: ManagerState,
  record: ExtensionRecord,
  subsystem: string
): void {
  const id = record.id;
  const before = configManager.get('extensions');
  configManager.set('extensions', {
    ...before,
    dismissedApprovals: {
      ...(before.dismissedApprovals ?? {}),
      [id]: {
        path: path.resolve(record.path),
        ...(record.sourcePlugin ? { plugin: record.sourcePlugin } : {}),
        version: record.manifest.version,
        dismissedAt: new Date().toISOString(),
      },
    },
  });
  logConfigWrite(subsystem, 'extensions', before, configManager.get('extensions'));
}

/** Withdraw run approval and retire the current server lifetime. */
export async function revokeRunApproval(
  state: ManagerState,
  id: string
): Promise<ExtensionRecordPublic | null> {
  const record = state.extensions.get(id);
  if (!record) return null;

  if (record.origin === 'user') recordDismissal(state, record, 'stopping an extension');
  await forgetRunApproval(state, id);

  return toPublic(record, configManager.get('extensions'));
}

/** Forget replaced-copy approval while preserving an eligible same-source heir. */
export async function forgetRunApproval(
  state: ManagerState,
  id: string,
  installRoot?: string
): Promise<void> {
  // A "Not now" (or "Stop it") recorded for a copy inside the package being
  // removed goes with it (DOR-2517): a reinstall is a new decision, even at
  // the same version and path. One recorded for a copy elsewhere is about
  // another package and stays. `revokeRunApproval` passes no install root,
  // so the dismissal it just recorded is never undone here.
  forgetRemovedDismissal(id, installRoot);

  const extensions = configManager.get('extensions');
  const sources = extensions.approvedSources ?? {};
  const recorded = sources[id];
  // The approval was given to a trusted origin (§9.1), and another copy of
  // that origin stays installed elsewhere: the person's decision is about the
  // origin, so it moves to that copy instead of being lost with this one.
  const heir =
    installRoot && recorded?.origin && isPathWithin(recorded.path, installRoot)
      ? [...state.extensions.values(), ...state.shadowed].find(
          (rec) =>
            rec.id === id &&
            !isPathWithin(rec.path, installRoot) &&
            rec.trustedOrigin?.plugin === recorded.origin?.plugin &&
            rec.trustedOrigin?.source === recorded.origin?.source
        )
      : undefined;
  if (heir) {
    moveApprovalToHeir(id, heir, extensions);
    await state.serverLifecycle.shutdown(id);
    state.operations.emitChanged();
    return;
  }
  if (installRoot && recorded && !isPathWithin(recorded.path, installRoot)) {
    logger.info(
      `[Extensions] Kept the run approval for ${id}: it is for the copy at ${recorded.path}, ` +
        `not the one being removed from ${installRoot}`
    );
    return;
  }
  withdrawRunApproval(id, extensions);

  await state.serverLifecycle.shutdown(id);
  state.operations.emitChanged();
}

function forgetRemovedDismissal(id: string, installRoot?: string): void {
  const dismissal = configManager.get('extensions').dismissedApprovals?.[id];
  if (installRoot && dismissal && isPathWithin(dismissal.path, installRoot)) {
    const before = configManager.get('extensions');
    const remaining = { ...(before.dismissedApprovals ?? {}) };
    delete remaining[id];
    configManager.set('extensions', { ...before, dismissedApprovals: remaining });
    logConfigWrite(
      'forgetting a "Not now" for an extension being removed',
      'extensions',
      before,
      configManager.get('extensions')
    );
  }
}

async function initializeApprovedServer(
  state: ManagerState,
  record: ExtensionRecord
): Promise<void> {
  const id = record.id;
  if (state.operations.needsServer(record)) {
    const result = await state.serverLifecycle.initialize(id, record);
    if (!result.ok) {
      logger.warn(`[Extensions] Server init after approval failed for ${id}: ${result.error}`);
    }
  }
}

function withdrawRunApproval(id: string, extensions: UserConfig['extensions']): void {
  const sources = extensions.approvedSources ?? {};
  if (extensions.approvedToRun.includes(id) || sources[id]) {
    const remainingSources = { ...sources };
    delete remainingSources[id];
    configManager.set('extensions', {
      ...extensions,
      approvedToRun: extensions.approvedToRun.filter((eid) => eid !== id),
      approvedSources: remainingSources,
    });
    logConfigWrite(
      'withdrawing an extension run approval',
      'extensions',
      extensions,
      configManager.get('extensions')
    );
    logger.info(`[Extensions] Forgot the run approval for ${id} — its code is being replaced`);
  }
}

function moveApprovalToHeir(
  id: string,
  heir: ExtensionRecord,
  extensions: UserConfig['extensions']
): void {
  const sources = extensions.approvedSources ?? {};
  configManager.set('extensions', {
    ...extensions,
    approvedSources: { ...sources, [id]: approvedSourceOf(heir) },
  });
  logConfigWrite(
    'moving an extension approval to another copy from the same source',
    'extensions',
    extensions,
    configManager.get('extensions')
  );
}
