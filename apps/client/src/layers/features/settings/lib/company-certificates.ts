/**
 * The words Settings → Server → Network shows about company certificates
 * (DOR-3361), worked out from what the desktop app loaded at start-up.
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

/**
 * The one line under the field.
 *
 * Counts come from the start-up record, never a fresh read of the file. When
 * the saved path differs from the one loaded, the line says a restart is due.
 *
 * @param status - What the desktop app recorded when this server started.
 * @param saved - The path the setting holds now, which may be newer.
 * @returns The line and whether it reports a problem, or `null` for none.
 */
export function companyCertificatesStatusLine(
  status: CompanyCertificatesStatus,
  saved: string | null
): { text: string; problem: boolean } | null {
  if (saved !== status.path) {
    return {
      text: saved ? 'Restart DorkOS to use this file.' : 'Restart DorkOS to stop trusting it.',
      problem: false,
    };
  }
  switch (status.outcome) {
    case 'added':
      return {
        text: `Trusting ${status.added} extra ${status.added === 1 ? 'certificate' : 'certificates'} from ${status.path}`,
        problem: false,
      };
    case 'unreadable':
      return { text: 'Couldn’t read this file. Check it, then restart DorkOS.', problem: true };
    case 'empty':
      return { text: 'No certificates found in this file.', problem: true };
    case 'ignored-env':
      return {
        text: 'NODE_EXTRA_CA_CERTS is ignored. Choose the file here instead.',
        problem: false,
      };
    default:
      return null;
  }
}
