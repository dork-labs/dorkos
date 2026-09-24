/**
 * What every install flow hands its transaction so the install keeps the
 * person's files (DOR-2245), and how the flow reports what happened.
 *
 * One helper for all five flows, so none can drift: {@link flowOwnership}
 * builds the transaction's `ownership` from the manifest and the installer's
 * hand-off, and returns a `finish` that copies the notices and warnings the
 * transaction reported onto the flow's {@link InstallResult}, each notice also
 * as one plain sentence on `warnings`.
 *
 * @module services/marketplace/lib/flow-ownership
 */
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import type { PackageFileNotice } from '@dorkos/shared/marketplace-schemas';
import type { TransactionOwnership } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

/** How many notices are listed one sentence each before they collapse into one. */
export const NOTICE_SENTENCE_LIMIT = 4;

/**
 * One plain sentence per notice, or a single summary when there are more than
 * {@link NOTICE_SENTENCE_LIMIT} (the full list stays on `fileNotices`).
 *
 * @param notices - What the install did with files the person may have changed.
 */
export function describeFileNotices(notices: readonly PackageFileNotice[]): string[] {
  if (notices.length > NOTICE_SENTENCE_LIMIT) {
    return [
      `${notices.length} files you had changed or added were kept, or saved beside the new version's copies. The install result lists each one.`,
    ];
  }
  return notices.map((n) => {
    switch (n.outcome) {
      case 'replaced-edit':
        return `You had changed ${n.path}. The new version replaced it; your copy is at ${n.savedAs}.`;
      case 'kept-edit':
        return `Kept your changes to ${n.path}. The new version's default is at ${n.savedAs}.`;
      case 'kept-no-longer-shipped':
        return `Kept your ${n.path}. The new version no longer includes it.`;
      case 'late-write':
        return n.savedAs
          ? `${n.path} changed while the update ran. Your copy is at ${n.savedAs}.`
          : `${n.path} changed while the update ran; kept the newest copy.`;
      case 'skipped-special':
        return `Skipped ${n.path}: it is a special file (a socket or pipe), so it was not copied.`;
    }
  });
}

/**
 * The transaction `ownership` for one flow's install, and the step that reports
 * its outcome on the flow's result.
 *
 * @param manifest - The package being installed.
 * @param req - The install request; its server-internal `ownership` hand-off
 *   carries the recorded source and the legacy-record rebuild.
 */
export function flowOwnership(
  manifest: MarketplacePackageManifest,
  req: Pick<InstallRequest, 'ownership'>
): { ownership: TransactionOwnership; finish: <R extends InstallResult>(result: R) => R } {
  let notices: PackageFileNotice[] = [];
  let warnings: string[] = [];
  const ownership: TransactionOwnership = {
    identity: {
      name: manifest.name,
      type: manifest.type,
      ...(req.ownership?.source && { source: req.ownership.source }),
    },
    userEditable: manifest.userEditable ?? [],
    ...(req.ownership?.rebuildLegacy && { rebuildLegacy: req.ownership.rebuildLegacy }),
    onNotices: (n, w) => {
      notices = n;
      warnings = w;
    },
  };
  const finish = <R extends InstallResult>(result: R): R => {
    if (notices.length === 0 && warnings.length === 0) return result;
    return {
      ...result,
      warnings: [...result.warnings, ...warnings, ...describeFileNotices(notices)],
      ...(notices.length > 0 && { fileNotices: notices }),
    };
  };
  return { ownership, finish };
}
