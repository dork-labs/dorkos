/**
 * HTTP implementation of Settings → Backups (DOR-4253), through the generated
 * API client (DOR-5473).
 */
import type { Transport } from '@dorkos/shared/transport';
import type { BackupCopiesResponse, BackupMoveResponse } from '@dorkos/shared/transport-backups';
import { createTransportApiClient } from './api-client';

/** A Move copies a whole database and checks it, so it may outlast the usual timeout. */
const MOVE_TIMEOUT_MS = 10 * 60_000;

/** Bind the backup list, Remove and Move to this server. */
export function createBackupsMethods(
  baseUrl: string
): Pick<Transport, 'listBackups' | 'removeBackup' | 'moveBackup'> {
  const api = createTransportApiClient(baseUrl);
  const moveApi = createTransportApiClient(baseUrl, MOVE_TIMEOUT_MS);
  return {
    listBackups(): Promise<BackupCopiesResponse> {
      return api.call('config.listBackups', {});
    },
    async removeBackup(name: string): Promise<void> {
      await api.call('config.deleteBackups', { path: { name } });
    },
    moveBackup(name: string, destination: string): Promise<BackupMoveResponse> {
      return moveApi.call('config.moveBackups', { path: { name }, body: { destination } });
    },
  };
}
