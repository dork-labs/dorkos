/**
 * Fixed original-save evidence endpoints; no draft, pathname or caller authority input.
 * Both go through the generated API client (DOR-5473).
 */
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
  FileSaveRecoverBodySchema,
} from '@dorkos/shared/file-save/recovery';
import type { Transport } from '@dorkos/shared/transport';
import { createTransportApiClient } from '../api-client';
/** Create validated HTTP methods for original-save discovery and proof-only recovery. */
export function createFileSaveRecoveryMethods(
  baseUrl: string
): NonNullable<Transport['originalFileSaveRecovery']> {
  const api = createTransportApiClient(baseUrl);
  return {
    async discover(documentId) {
      return FileSaveDiscoverySchema.parse(
        await api.call('canvas.getDocsFileSaves', { path: { id: documentId } })
      );
    },
    async recover(documentId, eventId, expectedIncarnation) {
      const body = FileSaveRecoverBodySchema.parse({ expectedIncarnation });
      return FileSaveRecoverResultSchema.parse(
        await api.call('canvas.createDocsFileSavesRecover', {
          path: { id: documentId, eventId },
          body,
        })
      );
    },
  };
}
