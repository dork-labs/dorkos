/**
 * The Transport methods for DorkOS's check on agents' shell commands (DOR-3300).
 *
 * @module shared/lib/transport/shell-check-methods
 */
import type { ShellCheckStatus } from '@dorkos/shared/notification-schemas';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createShellCheckMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async getShellCheckStatus(): Promise<ShellCheckStatus> {
      return (await api.call('system.shell_check', {})) as ShellCheckStatus;
    },

    // Stays hand-written: `POST /api/system/shell-check/continue` has no operationId (DOR-5473).
    continueWithoutShellCheck(): Promise<ShellCheckStatus> {
      return fetchJSON<ShellCheckStatus>(baseUrl, '/system/shell-check/continue', {
        method: 'POST',
      });
    },
  };
}
