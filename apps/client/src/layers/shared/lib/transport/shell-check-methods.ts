/**
 * The Transport methods for DorkOS's check on agents' shell commands (DOR-3300).
 *
 * @module shared/lib/transport/shell-check-methods
 */
import type { ShellCheckStatus } from '@dorkos/shared/notification-schemas';
import { fetchJSON } from './http-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createShellCheckMethods(baseUrl: string) {
  return {
    // Stays hand-written: `GET /api/system/shell-check` has no operationId (DOR-5473).
    getShellCheckStatus(): Promise<ShellCheckStatus> {
      return fetchJSON<ShellCheckStatus>(baseUrl, '/system/shell-check');
    },

    // Stays hand-written: `POST /api/system/shell-check/continue` has no operationId (DOR-5473).
    continueWithoutShellCheck(): Promise<ShellCheckStatus> {
      return fetchJSON<ShellCheckStatus>(baseUrl, '/system/shell-check/continue', {
        method: 'POST',
      });
    },
  };
}
