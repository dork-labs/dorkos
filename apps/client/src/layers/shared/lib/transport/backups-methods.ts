/** HTTP implementation of Settings → Backups (DOR-4253). */
import type { Transport } from '@dorkos/shared/transport';
import type { BackupCopiesResponse, BackupMoveResponse } from '@dorkos/shared/transport-backups';
import { fetchJSON } from './http-client';

/** A Move copies a whole database and checks it, so it may outlast the usual timeout. */
const MOVE_TIMEOUT_MS = 10 * 60_000;

/** Bind the backup list, Remove and Move to this server. */
export function createBackupsMethods(
  baseUrl: string
): Pick<Transport, 'listBackups' | 'removeBackup' | 'moveBackup'> {
  const at = (name: string) => `/config/backups/${encodeURIComponent(name)}`;
  return {
    listBackups(): Promise<BackupCopiesResponse> {
      return fetchJSON(baseUrl, '/config/backups');
    },
    async removeBackup(name: string): Promise<void> {
      await fetchJSON(baseUrl, at(name), { method: 'DELETE' });
    },
    moveBackup(name: string, destination: string): Promise<BackupMoveResponse> {
      return fetchJSON(baseUrl, `${at(name)}/move`, {
        method: 'POST',
        body: JSON.stringify({ destination }),
        timeout: MOVE_TIMEOUT_MS,
      });
    },
  };
}
