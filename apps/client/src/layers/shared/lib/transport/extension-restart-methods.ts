/**
 * HTTP implementation of the stopped app's explicit Restart action, through the
 * generated API client (`@dorkos/api-client`, DOR-4981).
 *
 * @module shared/lib/transport/extension-restart-methods
 */
import type { Transport } from '@dorkos/shared/transport';
import { createTransportApiClient } from './api-client';

/** Bind app restarts to this server. */
export function createExtensionRestartMethods(
  baseUrl: string
): Pick<Transport, 'restartExtension'> {
  const api = createTransportApiClient(baseUrl);
  return {
    async restartExtension(id: string): Promise<void> {
      await api.call('extensions.restart', { path: { id } });
    },
  };
}
