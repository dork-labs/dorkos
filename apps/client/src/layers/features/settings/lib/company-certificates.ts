/**
 * What Settings → Server → Network shows about company certificates
 * (DOR-3361), worked out from what the desktop app loaded at start-up and the
 * file the setting names now.
 *
 * @module features/settings/lib/company-certificates
 */
import type { ServerConfig } from '@dorkos/shared/types';

/** What the desktop app recorded about company certificates when it started. */
export type CompanyCertificatesStatus = NonNullable<
  NonNullable<ServerConfig['network']>['companyCertificates']
>;

/** A path a person could have meant on any desktop platform: `/…`, `C:\…` or `\\server\…`. */
export const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/** "1 certificate", "3 certificates". */
export function certificateCount(count: number): string {
  return `${count} ${count === 1 ? 'certificate' : 'certificates'}`;
}

/**
 * The state of the company-certificates row, one of:
 *
 * - `loaded`: the chosen file is the one in use, with this many certificates.
 * - `restart`: the choice changed since the app started. `stillUsing` is what is
 *   in use until a restart, when anything is; `stopping` when the file was removed.
 * - `problem`: the chosen file could not be used.
 * - `ignored-env`: no file chosen, and the environment variable was ignored.
 * - `none`: nothing to say.
 */
export type CompanyCertificatesRow =
  | { kind: 'loaded'; count: number; path: string }
  | {
      kind: 'restart';
      stillUsing: { count: number; path: string } | null;
      stopping: boolean;
    }
  | { kind: 'problem'; text: string }
  | { kind: 'ignored-env' }
  | { kind: 'none' };

/**
 * Work out the row's state. Counts come from the start-up record, never a fresh
 * read of the file, so the row says what the app trusts right now.
 *
 * @param status - What the desktop app recorded when this server started.
 * @param saved - The path the setting holds now, which may be newer.
 */
export function companyCertificatesRow(
  status: CompanyCertificatesStatus,
  saved: string | null
): CompanyCertificatesRow {
  const inUse =
    status.outcome === 'added' && status.path ? { count: status.added, path: status.path } : null;
  if (saved !== status.path) {
    // Stopping a file that never loaded changes nothing a restart would undo.
    if (saved === null && !inUse) return { kind: 'none' };
    return { kind: 'restart', stillUsing: inUse, stopping: saved === null };
  }
  switch (status.outcome) {
    case 'added':
      return inUse ? { kind: 'loaded', ...inUse } : { kind: 'none' };
    case 'unreadable':
      return { kind: 'problem', text: 'Couldn’t read this file. Check it, then restart DorkOS.' };
    case 'empty':
      return {
        kind: 'problem',
        text: 'No certificates found in this file. Choose a different one.',
      };
    case 'ignored-env':
      return { kind: 'ignored-env' };
    default:
      return { kind: 'none' };
  }
}

/**
 * The restart line's words. The old path shows only when it differs from the
 * chosen one; the row checks that before calling.
 *
 * @param row - A `restart` row.
 */
export function restartLine(row: Extract<CompanyCertificatesRow, { kind: 'restart' }>): string {
  const next = row.stopping
    ? 'Restart DorkOS to stop using it.'
    : 'Restart DorkOS to use this file.';
  if (!row.stillUsing) return next;
  return `Still using ${certificateCount(row.stillUsing.count)} from ${row.stillUsing.path}. ${next}`;
}
