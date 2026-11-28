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
import { LIST_PAGE_LIMIT, readAllPages } from '../read-all-pages';

/** Create all Shape methods bound to a base URL. */
export function createShapeMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // The list comes in pages, A to Z (DOR-4982); the switcher shows it whole.
    async listShapes(): Promise<InstalledShapeSummary[]> {
      const read = (cursor?: string) =>
        api.call('shapes.list', { query: { limit: LIST_PAGE_LIMIT, ...(cursor && { cursor }) } });
      return (await readAllPages(read, (page) => page.shapes, '/shapes')).rows;
    },

    applyShape(name: string): Promise<ApplyShapeResult> {
      return api.call('shapes.create_application', { path: { name } });
    },

    forkShape(name: string, request: ForkShapeRequest = {}): Promise<ForkShapeResult> {
      return api.call('shapes.fork', { path: { name }, body: request });
    },
  };
}
