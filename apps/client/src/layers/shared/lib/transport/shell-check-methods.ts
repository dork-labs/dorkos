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
    getShellCheckStatus(): Promise<ShellCheckStatus> {
      return fetchJSON<ShellCheckStatus>(baseUrl, '/system/shell-check');
    },

    continueWithoutShellCheck(): Promise<ShellCheckStatus> {
      return fetchJSON<ShellCheckStatus>(baseUrl, '/system/shell-check/continue', {
        method: 'POST',
      });
    },
  };
}
