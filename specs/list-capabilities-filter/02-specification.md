# list_capabilities filtering, pagination, and compact-by-default (DOR-940)

## Problem

`mcp__dorkos__list_capabilities` returned the entire serialized capability catalog
on every call — every capability with its full model-facing description and both
input/output JSON Schemas. Measured this week at 89,439 chars / 2,737 lines for
~30 capabilities, that is enough to blow an agent's context budget on a single
discovery call. The registry `catalog()` builds this payload; the
`list_capabilities` MCP tool, the `GET /api/capabilities/catalog` HTTP route, and
the `dorkos://capabilities` MCP resource all served it verbatim.

## Approach

A single pure projection, `projectCatalog(catalog, input)`, narrows an
already-serialized `CapabilityCatalog` into one bounded page. It lives in
`apps/server/src/services/core/self-description/catalog-projection.ts` and is the
one filter both agent-facing surfaces share:

- the `capabilities.list` capability handler (`invoke`), which the
  `list_capabilities` MCP tool and `dorkos call capabilities.list` reach; and
- the `GET /api/capabilities/catalog` route, which parses the same query string
  through the same Zod schema and calls the same projection.

`registry.catalog()` is unchanged, so the `dorkos://capabilities` resource (a
deliberately full, cacheable pin) and every other `catalog()` caller stay green.
Because OpenAPI derives the route's query parameters and response schema from the
capability's `input`/`output`, the route had to apply the projection to stay
honest with its own generated docs; `docs/api/openapi.json` and the catalog MDX
were regenerated.

## Final input design

```ts
z.object({
  domain: z.string().trim().min(1).optional(), // exact id-domain match, e.g. "mcp" -> mcp.*
  query: z.string().trim().min(1).optional(), // case-insensitive substring over id + title + description
  detail: z.enum(['compact', 'full']).optional(), // default compact; full when a filter is set; explicit wins
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(), // opaque base64url page offset from a prior nextCursor
});
```

## Output design

A discriminated union on `detail`, both branches sharing the page envelope
`{ catalogVersion, generatedAt, total, returned, offset, nextCursor?, guidance? }`:

- `detail: 'compact'` → `capabilities: { id, title, tier, summary }[]` (summary is
  the first sentence of the description, elided to 160 chars).
- `detail: 'full'` → `capabilities: SerializedCapability[]` (the pre-existing full
  entry with both JSON Schemas).

## Behavior

1. Filter: `domain` keeps ids in that exact domain segment (case-insensitive);
   `query` keeps entries whose id, title, or description contains the text
   (case-insensitive). Both together are AND.
2. Sort survivors by id, so pagination is stable.
3. Effective detail = explicit `detail`, else `full` when a filter is present,
   else `compact`.
4. Page the `[offset, offset + limit)` window. `offset` comes from `cursor`
   (clamped to `[0, total]`); an undecodable cursor is a 400 / `InvalidCursorError`.
5. When the window does not reach the end, emit `nextCursor` and a one-line
   `guidance` stating how many matches were left out and how to reach them. Never
   truncate silently.

## CLI impact

`GET /api/capabilities/catalog` is now paginated, so `dorkos call` (id validation)
and `dorkos capabilities` (full listing) page it to completion via a new
`fetchFullCatalog()` helper (`detail=full`, follow `nextCursor`) rather than
assuming one response holds everything.

## Acceptance criteria

- A no-argument `list_capabilities` call returns a compact, id-sorted, bounded
  page (≤ `limit`), never the full schema dump, and never an error.
- `domain: 'mcp'` returns exactly the `mcp.*` capabilities and nothing else.
- Paging with a small `limit` and following `nextCursor` reaches every capability
  exactly once, in stable id order.
- A capped page reports `total`, `nextCursor`, and human-readable `guidance` with
  the omitted count — no silent truncation.
- An explicit `detail: 'compact'` overrides the filter-implied full detail.
- The MCP tool and the HTTP route return identical projections; the
  `dorkos://capabilities` resource and all other `catalog()` callers are unchanged.
- `docs/api/openapi.json` and the catalog MDX carry the updated schema and
  description verbatim.

## Verification

- `apps/server/.../__tests__/catalog-projection.test.ts` — pure `projectCatalog`
  over a synthetic 6-capability catalog (exact, independent counts) and the real
  composed docs catalog (`domain:'mcp'` picks exactly the live `mcp.*` set).
- `apps/server/.../__tests__/capabilities-domain.test.ts` — the five DOR-940 cases
  run through `registry.invoke('capabilities.list', ...)`; reverting the handler to
  the raw catalog reddens exactly those five and nothing else.
- CLI `call.test.ts` / `capabilities.test.ts` — updated for the paged fetch.
