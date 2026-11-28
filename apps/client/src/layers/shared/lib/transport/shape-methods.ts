/**
 * Shape Transport methods factory (DOR-355).
 *
 * Wraps the `/api/shapes/*` HTTP API. Every call goes through the generated API
 * client (DOR-5473) and encodes the shape name.
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

/** Create all Shape methods bound to a base URL. */
export function createShapeMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async listShapes(): Promise<InstalledShapeSummary[]> {
      return (await api.call('shapes.get', {})).shapes;
    },

    applyShape(name: string): Promise<ApplyShapeResult> {
      return api.call('shapes.apply', { path: { name } });
    },

    forkShape(name: string, request: ForkShapeRequest = {}): Promise<ForkShapeResult> {
      return api.call('shapes.fork', { path: { name }, body: request });
    },
  };
}
