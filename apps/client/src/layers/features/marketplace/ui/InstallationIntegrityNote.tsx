/**
 * What an installation's integrity means for the person, on its row
 * (DOR-2197): files changed since install, or an install an older DorkOS made
 * without recording its files. A clean, linked or unverified installation adds
 * nothing.
 *
 * @module features/marketplace/ui/InstallationIntegrityNote
 */
import { FileWarning, History } from 'lucide-react';
import type { InstallIntegrity } from '@dorkos/shared/marketplace-schemas';

/** How many files a modified installation changed, counted the way the note says it. */
export function changedFileCount(
  integrity: Extract<InstallIntegrity, { status: 'modified' }>
): number {
  return integrity.changed.length + integrity.missing.length + integrity.added.length;
}

/** Whether an installation was made by an older DorkOS and can be prepared. */
export function needsPreparing(integrity: InstallIntegrity | undefined): boolean {
  return integrity?.status === 'unknown' && integrity.reason === 'no-record';
}

/**
 * The note under a row's metadata, or nothing.
 *
 * @param props.integrity - The installation's integrity, when verification has answered.
 */
export function InstallationIntegrityNote({ integrity }: { integrity?: InstallIntegrity }) {
  if (integrity?.status === 'modified') {
    const count = changedFileCount(integrity);
    const paths = [...integrity.changed, ...integrity.added, ...integrity.missing];
    return (
      <p
        data-testid="installation-integrity"
        title={paths.join('\n')}
        className="mt-1 flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400"
      >
        <FileWarning className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>
          {count}
          {integrity.truncated ? '+' : ''} {count === 1 ? 'file' : 'files'} changed since install.
          Updating replaces them and keeps your copies beside them.
        </span>
      </p>
    );
  }
  if (needsPreparing(integrity)) {
    return (
      <p
        data-testid="installation-integrity"
        className="text-muted-foreground mt-1 flex items-start gap-1 text-xs"
      >
        <History className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>Installed by an older DorkOS, so DorkOS can’t tell its files from yours yet.</span>
      </p>
    );
  }
  return null;
}
