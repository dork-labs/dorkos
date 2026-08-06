/**
 * Filtering, pagination, and compact projection for the capability catalog
 * (DOR-940).
 *
 * `list_capabilities` used to return the ENTIRE serialized catalog — every
 * capability with its full model-facing description and both JSON Schemas. On a
 * catalog of a few dozen capabilities that is tens of thousands of characters,
 * enough to blow an agent's context budget on a single discovery call. This
 * module narrows that call: a no-argument invocation returns a COMPACT entry per
 * capability (id, title, tier, one-line summary), bounded by a limit, and the
 * caller opts into detail or pages through with a cursor.
 *
 * The projection is a PURE function over an already-serialized
 * {@link CapabilityCatalog}, so it is the single source of truth shared by the
 * two agent-facing surfaces that must stay byte-identical: the `capabilities.list`
 * capability handler (the `list_capabilities` MCP tool + `dorkos call`) and the
 * `GET /api/capabilities/catalog` HTTP route. Neither surface re-implements the
 * filter; both call {@link projectCatalog}.
 *
 * @module services/core/self-description/catalog-projection
 */
import { z } from 'zod';
import { CAPABILITY_TIERS, type CapabilityCatalog } from '@dorkos/shared/capabilities';

/**
 * Number of capabilities returned when the caller does not set `limit`. Large
 * enough that today's whole catalog fits one compact page, so a no-argument call
 * is complete and not truncated; the cap only bites once the catalog grows.
 */
export const DEFAULT_CAPABILITY_LIMIT = 50;

/**
 * Hard ceiling on `limit`. Bounds the worst case — a `detail:'full'` page — so no
 * single call can re-dump the whole catalog at full schema detail, which is the
 * overflow this feature exists to prevent.
 */
export const MAX_CAPABILITY_LIMIT = 200;

/** Longest a compact entry's one-line summary may be before it is elided. */
const SUMMARY_MAX_LENGTH = 160;

/**
 * A JSON Schema object as produced by `z.toJSONSchema` — a plain object map. The
 * catalog carries one per capability input and output; the schema is left
 * structural (a record) rather than re-describing the whole JSON Schema meta.
 */
const jsonSchema = z.record(z.string(), z.unknown());

/** The serialized surfaces of a capability, mirroring `CapabilitySurfaces`. */
const surfacesSchema = z.object({
  mcp: z
    .object({
      toolName: z.string(),
      servers: z.array(z.enum(['in-session', 'external'])),
      readOnlyCarveOut: z.boolean().optional(),
      annotations: z
        .object({
          openWorldHint: z.boolean().optional(),
          idempotentHint: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  cli: z
    .object({
      verb: z.string(),
      subcommand: z.string().optional(),
    })
    .optional(),
  http: z
    .object({
      method: z.enum(['get', 'post', 'put', 'patch', 'delete']),
      path: z.string(),
    })
    .optional(),
});

/** One FULL serialized capability entry, mirroring `SerializedCapability`. */
export const serializedCapabilitySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tier: z.enum(CAPABILITY_TIERS),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  surfaces: surfacesSchema,
});

/**
 * The full self-description catalog, mirroring the `CapabilityCatalog` type in
 * `@dorkos/shared/capabilities`. This is what {@link CapabilityRegistry.catalog}
 * returns and what {@link projectCatalog} narrows; it is NOT the shape
 * `capabilities.list` returns any more (that is {@link listCapabilitiesResultSchema}).
 */
export const capabilityCatalogSchema = z.object({
  catalogVersion: z.string(),
  generatedAt: z.string(),
  capabilities: z.array(serializedCapabilitySchema),
});

/**
 * One COMPACT catalog entry: the minimum an agent needs to decide whether a
 * capability is the one it wants, and then fetch its schemas by narrowing. Drops
 * the two JSON Schemas and the full description that make the catalog large.
 */
export const compactCapabilitySchema = z.object({
  /** Stable `${domain}.${verb}` id, e.g. `mcp.add`. Run it with `dorkos call`. */
  id: z.string(),
  /** Human-facing title. */
  title: z.string(),
  /** Permission tier: `observe`, `act`, or `destructive`. */
  tier: z.enum(CAPABILITY_TIERS),
  /** First sentence of the description, elided to one line. */
  summary: z.string(),
});

/**
 * The input contract for `list_capabilities` and the `GET /api/capabilities/catalog`
 * query string. Every field is optional (or defaulted), so a no-argument call is
 * valid and returns a bounded, compact, usable page.
 */
export const listCapabilitiesInputSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Return only capabilities in this id domain, e.g. 'mcp' matches every mcp.* id. " +
        'Case-insensitive, exact domain match.'
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Return only capabilities whose id, title, or description contains this text ' +
        '(case-insensitive substring).'
    ),
  detail: z
    .enum(['compact', 'full'])
    .optional()
    .describe(
      "'compact' returns id, title, tier, and a one-line summary; 'full' adds the model-facing " +
        'description and the input and output JSON Schemas. Defaults to compact, or to full when a ' +
        'domain or query filter is set.'
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CAPABILITY_LIMIT)
    .default(DEFAULT_CAPABILITY_LIMIT)
    .describe(
      `Maximum entries to return in this page (1 to ${MAX_CAPABILITY_LIMIT}, default ` +
        `${DEFAULT_CAPABILITY_LIMIT}). When more match, the response carries a nextCursor.`
    ),
  cursor: z
    .string()
    .optional()
    .describe('Opaque token from a previous response’s nextCursor. Omit for the first page.'),
});

/** Parsed, validated input for {@link projectCatalog}. */
export type ListCapabilitiesInput = z.infer<typeof listCapabilitiesInputSchema>;

/** The fields every page carries, independent of detail level. */
const pageEnvelope = {
  /** Content hash of the whole catalog; a stable cache key across pages. */
  catalogVersion: z.string(),
  /** ISO-8601 timestamp of when this snapshot was produced. */
  generatedAt: z.string(),
  /** How many capabilities match the active filter, across every page. */
  total: z.number().int().nonnegative(),
  /** How many entries are in this page's `capabilities` array. */
  returned: z.number().int().nonnegative(),
  /** Zero-based index into the filtered set where this page begins. */
  offset: z.number().int().nonnegative(),
  /** Cursor for the next page; present only when more entries remain. */
  nextCursor: z.string().optional(),
  /**
   * Present only when this page is capped: a one-line, agent-facing note stating
   * how many matches were left out and how to reach them (narrow with a filter,
   * or page with the cursor). Never silently truncates.
   */
  guidance: z.string().optional(),
};

/**
 * The result of a `list_capabilities` call: a paginated envelope whose entry
 * shape is tied to the detail level it reports.
 */
export const listCapabilitiesResultSchema = z.discriminatedUnion('detail', [
  z.object({
    ...pageEnvelope,
    detail: z.literal('compact'),
    capabilities: z.array(compactCapabilitySchema),
  }),
  z.object({
    ...pageEnvelope,
    detail: z.literal('full'),
    capabilities: z.array(serializedCapabilitySchema),
  }),
]);

/** The typed result of {@link projectCatalog}. */
export type ListCapabilitiesResult = z.infer<typeof listCapabilitiesResultSchema>;

/** One serialized capability, as it appears in a full catalog page. */
type SerializedEntry = z.infer<typeof serializedCapabilitySchema>;

/**
 * Raised when a `cursor` cannot be decoded into a page offset. The HTTP route
 * maps it to a 400; on the MCP path it surfaces like any input error. A cursor
 * the server itself minted never triggers this — only a hand-edited one does.
 */
export class InvalidCursorError extends Error {
  /**
   * Build the error, echoing the offending cursor in the message.
   *
   * @param cursor - The offending cursor value, echoed so the caller can see it.
   */
  constructor(cursor: string) {
    super(`Invalid cursor ${JSON.stringify(cursor)}; use the nextCursor from a previous response.`);
    this.name = 'InvalidCursorError';
  }
}

/** Encode a page offset into an opaque cursor token. */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/**
 * Decode a cursor token back into its page offset.
 *
 * @param cursor - The opaque token from a previous response.
 * @returns The non-negative integer offset it encodes.
 * @throws {@link InvalidCursorError} when the token is not a server-minted offset.
 */
function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number(decoded);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InvalidCursorError(cursor);
  }
  return offset;
}

/** The domain segment of a capability id (`mcp.add` -> `mcp`). */
function domainOf(id: string): string {
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.slice(0, dot);
}

/** Reduce a full description to a single elided sentence for a compact entry. */
function summarize(description: string): string {
  const trimmed = description.trim();
  const stop = trimmed.indexOf('. ');
  const firstSentence = stop === -1 ? trimmed : trimmed.slice(0, stop + 1);
  if (firstSentence.length <= SUMMARY_MAX_LENGTH) return firstSentence;
  return `${firstSentence.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Project one full entry down to its compact form. */
function toCompact(entry: SerializedEntry): z.infer<typeof compactCapabilitySchema> {
  return {
    id: entry.id,
    title: entry.title,
    tier: entry.tier,
    summary: summarize(entry.description),
  };
}

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Build the one-line "here's what was left out and how to narrow" note. */
function buildGuidance(args: {
  total: number;
  shown: number;
  detail: 'compact' | 'full';
  filtered: boolean;
  nextCursor: string;
}): string {
  const remaining = args.total - args.shown;
  const narrow = args.filtered
    ? 'Narrow further with a more specific query.'
    : "Narrow with domain (e.g. domain:'mcp') or a query substring.";
  const fuller =
    args.detail === 'compact'
      ? " Each entry is compact; set detail:'full' or add a filter to get descriptions and schemas."
      : '';
  return (
    `Showing ${args.shown} of ${args.total} capabilities; ${remaining} not shown. ` +
    `Page the rest with cursor:'${args.nextCursor}'. ${narrow}${fuller}`
  );
}

/**
 * Filter, sort, paginate, and (by default) compact a serialized catalog into a
 * bounded, usable page.
 *
 * Matching is AND across the two filters: `domain` keeps ids in that exact domain
 * segment, `query` keeps entries whose id, title, or description contains the text
 * (both case-insensitive). Survivors are sorted by id so pagination is stable, then
 * the `[offset, offset + limit)` window is returned. Detail defaults to compact, or
 * to full when a filter is present, and an explicit `detail` always wins. When the
 * window does not reach the end, `nextCursor` and `guidance` say so — nothing is
 * ever dropped silently.
 *
 * @param catalog - The full serialized catalog from `registry.catalog()`.
 * @param input - The validated filter, detail, and pagination request.
 * @returns A single bounded page of the catalog.
 * @throws {@link InvalidCursorError} when `input.cursor` is not decodable.
 */
export function projectCatalog(
  catalog: CapabilityCatalog,
  input: ListCapabilitiesInput
): ListCapabilitiesResult {
  const domain = input.domain?.toLowerCase();
  const query = input.query?.toLowerCase();

  let matches: readonly SerializedEntry[] = catalog.capabilities;
  if (domain !== undefined) {
    matches = matches.filter((c) => domainOf(c.id).toLowerCase() === domain);
  }
  if (query !== undefined) {
    matches = matches.filter((c) =>
      `${c.id}\n${c.title}\n${c.description}`.toLowerCase().includes(query)
    );
  }

  const sorted = [...matches].sort((a, b) => a.id.localeCompare(b.id));
  const total = sorted.length;

  const filtered = domain !== undefined || query !== undefined;
  const detail = input.detail ?? (filtered ? 'full' : 'compact');

  const offset = input.cursor ? clamp(decodeCursor(input.cursor), 0, total) : 0;
  const page = sorted.slice(offset, offset + input.limit);
  const returned = page.length;
  const end = offset + returned;
  const nextCursor = end < total ? encodeCursor(end) : undefined;
  const guidance = nextCursor
    ? buildGuidance({ total, shown: end, detail, filtered, nextCursor })
    : undefined;

  const envelope = {
    catalogVersion: catalog.catalogVersion,
    generatedAt: catalog.generatedAt,
    total,
    returned,
    offset,
    ...(nextCursor ? { nextCursor } : {}),
    ...(guidance ? { guidance } : {}),
  };

  if (detail === 'compact') {
    return { ...envelope, detail: 'compact', capabilities: page.map(toCompact) };
  }
  return { ...envelope, detail: 'full', capabilities: page };
}
