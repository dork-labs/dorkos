/** Fixed original-save evidence endpoints; no draft, pathname or caller authority input. */
import {
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
  FileSaveRecoverBodySchema,
} from '@dorkos/shared/file-save/recovery';
import type { Transport } from '@dorkos/shared/transport';
import { fetchJSON } from '../http-client';
/** Create validated HTTP methods for original-save discovery and proof-only recovery. */
export function createFileSaveRecoveryMethods(
  baseUrl: string
): NonNullable<Transport['originalFileSaveRecovery']> {
  const path = (documentId: string) => `/canvas/docs/${encodeURIComponent(documentId)}/file-saves`;
  return {
    async discover(documentId) {
      return FileSaveDiscoverySchema.parse(await fetchJSON(baseUrl, path(documentId)));
    },
    async recover(documentId, eventId, expectedIncarnation) {
      const body = FileSaveRecoverBodySchema.parse({ expectedIncarnation });
      return FileSaveRecoverResultSchema.parse(
        await fetchJSON(baseUrl, `${path(documentId)}/${encodeURIComponent(eventId)}/recover`, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      );
    },
  };
}
