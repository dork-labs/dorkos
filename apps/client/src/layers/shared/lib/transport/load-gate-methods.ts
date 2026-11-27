/**
 * The Transport methods for the load gate's waiting line (DOR-4209).
 *
 * @module shared/lib/transport/load-gate-methods
 */
import type { LoadGateJobAction, LoadGateWaitingLine } from '@dorkos/shared/load-gate-queue';
import { fetchJSON } from './http-client';

/**
 * The methods.
 *
 * @param baseUrl - The API's base URL.
 */
export function createLoadGateMethods(baseUrl: string) {
  return {
    // Stays hand-written: `GET /api/system/load-gate/waiting` has no operationId (DOR-5473).
    getLoadGateWaitingLine(): Promise<LoadGateWaitingLine> {
      return fetchJSON<LoadGateWaitingLine>(baseUrl, '/system/load-gate/waiting');
    },

    // Stays hand-written: `POST /api/system/load-gate/jobs/{id}/{action}` has no operationId (DOR-5473).
    actOnLoadGateJob(id: string, action: LoadGateJobAction): Promise<LoadGateWaitingLine> {
      return fetchJSON<LoadGateWaitingLine>(
        baseUrl,
        `/system/load-gate/jobs/${encodeURIComponent(id)}/${action}`,
        { method: 'POST' }
      );
    },
  };
}
