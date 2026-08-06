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

/** Page size requested per fetch; matches the server's `MAX_CAPABILITY_LIMIT`. */
const PAGE_LIMIT = 200;

/** Loop ceiling, so a malformed cursor chain can never spin forever. */
const MAX_PAGES = 10_000;

/**
 * Fetch every capability by paging `GET /api/capabilities/catalog` until the
 * server stops returning a `nextCursor`.
 *
 * @returns The reassembled full catalog.
 * @throws Propagates the underlying {@link apiCall} error when the server is
 *   unreachable or returns a non-2xx status.
 */
export async function fetchFullCatalog(): Promise<FullCatalog> {
  const capabilities: CatalogCapability[] = [];
  let cursor: string | undefined;
  let catalogVersion = '';
  let generatedAt = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ detail: 'full', limit: String(PAGE_LIMIT) });
    if (cursor) params.set('cursor', cursor);
    const body = await apiCall<CatalogPage>(
      'GET',
      `/api/capabilities/catalog?${params.toString()}`
    );
    capabilities.push(...body.capabilities);
    catalogVersion = body.catalogVersion;
    generatedAt = body.generatedAt;
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }

  return { catalogVersion, generatedAt, capabilities };
}
