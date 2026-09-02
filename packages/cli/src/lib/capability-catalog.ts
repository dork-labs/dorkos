/**
 * Fetch the COMPLETE capability catalog from a running DorkOS server.
 *
 * `GET /api/capabilities/catalog` filters, compacts, and paginates by default
 * (DOR-940) so an agent's `list_capabilities` call cannot overflow its context.
 * The CLI needs the opposite: `dorkos call` validates an id against the whole set
 * and `dorkos capabilities` lists every one. So it asks for full detail and
 * follows `nextCursor` to the end, reassembling the pages into one catalog —
 * never relying on a single response holding everything, which would silently
 * truncate once the catalog outgrows one page.
 *
 * @module lib/capability-catalog
 */
import { MAX_CAPABILITY_LIMIT } from '@dorkos/shared/capabilities';

import { apiCall } from './api-client.js';

/** One full capability entry as returned by `GET /api/capabilities/catalog?detail=full`. */
export interface CatalogCapability {
  /** Stable `${domain}.${verb}` id, e.g. `mcp.add`. */
  id: string;
  /** Human-facing title. */
  title: string;
  /** Model-facing description. */
  description: string;
  /** Permission tier: `observe`, `act`, or `destructive`. */
  tier: string;
}

/** The reassembled full catalog: every capability, plus the stable version hash. */
export interface FullCatalog {
  /** Content hash of the whole catalog; stable across pages. */
  catalogVersion: string;
  /** ISO-8601 timestamp of the snapshot. */
  generatedAt: string;
  /** Every registered capability. */
  capabilities: CatalogCapability[];
}

/** One page of the paginated catalog response. */
interface CatalogPage {
  catalogVersion: string;
  generatedAt: string;
  nextCursor?: string;
  capabilities: CatalogCapability[];
}

/**
 * Page size requested per fetch. Imported rather than restated: the server
 * rejects anything above its own ceiling, and a local copy of the number is a
 * copy that can drift out of agreement with the server it is talking to.
 */
const PAGE_LIMIT = MAX_CAPABILITY_LIMIT;

/** Loop ceiling, so a malformed cursor chain can never spin forever. */
const MAX_PAGES = 10_000;

/**
 * Fetch every capability by paging `GET /api/capabilities/catalog` until the
 * server stops returning a `nextCursor`.
 *
 * @returns The reassembled full catalog.
 * @throws Propagates the underlying {@link apiCall} error when the server is
 *   unreachable or returns a non-2xx status, and throws when the page ceiling is
 *   reached — see below for why that is not a silent stop.
 */
export async function fetchFullCatalog(): Promise<FullCatalog> {
  const capabilities: CatalogCapability[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ detail: 'full', limit: String(PAGE_LIMIT) });
    if (cursor) params.set('cursor', cursor);
    const body = await apiCall<CatalogPage>(
      'GET',
      `/api/capabilities/catalog?${params.toString()}`
    );
    capabilities.push(...body.capabilities);
    if (!body.nextCursor) {
      return { catalogVersion: body.catalogVersion, generatedAt: body.generatedAt, capabilities };
    }
    cursor = body.nextCursor;
  }

  // Falling out of the loop means the server still had more to give. Returning
  // the partial catalog here would be worse than failing: `dorkos call` checks
  // the id it was handed against this set, so a truncated catalog tells the
  // person a perfectly valid capability does not exist.
  throw new Error(
    `Capability catalog paging exceeded ${MAX_PAGES} pages — the server kept returning a ` +
      'cursor, so this build of the CLI and the server it is talking to disagree. Upgrade ' +
      'both to the same version.'
  );
}
