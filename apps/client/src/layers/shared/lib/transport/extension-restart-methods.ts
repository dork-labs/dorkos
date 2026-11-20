/** HTTP implementation of the stopped app's explicit Restart action. */
import type { Transport } from '@dorkos/shared/transport';
import { fetchJSON } from './http-client';

/** Bind app restarts to this server. */
export function createExtensionRestartMethods(
  baseUrl: string
): Pick<Transport, 'restartExtension'> {
  return {
    async restartExtension(id: string): Promise<void> {
      await fetchJSON(baseUrl, `/extensions/${encodeURIComponent(id)}/restart`, {
        method: 'POST',
        body: '{}',
      });
    },
  };
}
