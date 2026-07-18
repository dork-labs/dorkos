/**
 * Shape Transport methods factory (DOR-355).
 *
 * Wraps the `/api/shapes/*` HTTP API with typed fetch calls. Shape names are
 * kebab-case slugs but still `encodeURIComponent`'d as defense in depth — the
 * server rejects non-slug names with a 400.
 *
 * @module shared/lib/transport/shape-methods
 */
import type { InstalledShapeSummary, ApplyShapeResult } from '@dorkos/shared/marketplace-schemas';
import { fetchJSON } from './http-client';

/** Create all Shape methods bound to a base URL. */
export function createShapeMethods(baseUrl: string) {
  return {
    listShapes(): Promise<InstalledShapeSummary[]> {
      return fetchJSON<{ shapes: InstalledShapeSummary[] }>(baseUrl, '/shapes').then(
        (r) => r.shapes
      );
    },

    applyShape(name: string): Promise<ApplyShapeResult> {
      return fetchJSON<ApplyShapeResult>(baseUrl, `/shapes/${encodeURIComponent(name)}/apply`, {
        method: 'POST',
      });
    },
  };
}
