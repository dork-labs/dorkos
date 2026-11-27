/**
 * Shape Transport methods factory (DOR-355).
 *
 * Wraps the `/api/shapes/*` HTTP API. The list and the fork go through the
 * generated API client (DOR-5473); every call encodes the shape name.
 *
 * @module shared/lib/transport/shape-methods
 */
import type {
  InstalledShapeSummary,
  ApplyShapeResult,
  ForkShapeResult,
} from '@dorkos/shared/marketplace-schemas';
import type { ForkShapeRequest } from '@dorkos/shared/schemas';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/** Create all Shape methods bound to a base URL. */
export function createShapeMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async listShapes(): Promise<InstalledShapeSummary[]> {
      return (await api.call('shapes.get', {})).shapes;
    },

    // Stays hand-written: sends no body; the generated client sends {} on every write (DOR-5473).
    applyShape(name: string): Promise<ApplyShapeResult> {
      return fetchJSON<ApplyShapeResult>(baseUrl, `/shapes/${encodeURIComponent(name)}/apply`, {
        method: 'POST',
      });
    },

    forkShape(name: string, request: ForkShapeRequest = {}): Promise<ForkShapeResult> {
      return api.call('shapes.fork', { path: { name }, body: request });
    },
  };
}
