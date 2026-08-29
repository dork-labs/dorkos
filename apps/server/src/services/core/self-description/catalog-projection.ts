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
 * What keeps a call small is the DEFAULT, not the limit ceiling. A caller that
 * asks for `detail:'full'` at the maximum limit still gets everything, because
 * `dorkos capabilities` and `dorkos call` need the complete set and page for it
 * deliberately. So the default has to be small on its own: entries are compact
 * unless the caller says otherwise, and a `domain`/`query` filter only upgrades
 * the page to full detail when it is selective enough to be worth it
 * ({@link FULL_DETAIL_THRESHOLD}). A filter that matches most of the catalog —
 * `query:'a'`, say — is not a request for every schema in the product.
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
import {
  CAPABILITY_TIERS,
  MAX_CAPABILITY_LIMIT,
  type CapabilityCatalog,
} from '@dorkos/shared/capabilities';

/**
 * Number of capabilities returned when the caller does not set `limit`. Large
 * enough that today's whole catalog fits one compact page, so a no-argument call
 * is complete and not truncated; the cap only bites once the catalog grows.
 */
export const DEFAULT_CAPABILITY_LIMIT = 50;

/**
 * How few matches a `domain`, `query` or `toolGroup` filter must leave before the projection
 * expands the page to full detail without being asked.
 *
 * A filter is a signal that the caller has something specific in mind, and
 * handing back the schemas for a handful of entries saves a second round trip.
 * It is only that signal when it actually narrows: `query:'a'` matches nearly
 * every capability, and auto-expanding it returned MORE characters than the
 * unfiltered dump this whole module exists to replace. Above this many matches
 * the page stays compact and the `guidance` line says how to get the schemas.
 *
 * This bounds the number of ENTRIES, not the size of the payload, and the two
 * come apart: `domain:'capabilities'` matches exactly one capability and expands
 * to ~6.1K characters — larger than the whole catalog served compact (~6.0K),
 * because one entry's two JSON Schemas outweigh thirty one-line summaries. That
 * is the right trade for a caller who narrowed to one thing and is about to call
 * it, and `guidance` names the compact alternative either way. If a byte budget
 * is ever wanted instead of a count, this is the constant it replaces.
 */
export const FULL_DETAIL_THRESHOLD = 8;

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
  /**
   * The per-agent grant this capability requires, when it declares one (absent
   * for the ungated majority).
   *
   * Declared here because it is already SERVED here — `registry.catalog()`
   * spreads it onto the entry — and a field that ships but is not in the schema
   * is a field OpenAPI describes wrongly and the `SerializedEntry` type below
   * cannot see. That gap is not academic: the cockpit's two Tools tabs read the
   * tools behind a grant off this catalog, which is what keeps them from
   * carrying the static list that drifted three times over (DOR-499, DOR-1611).
   */
  toolGroup: z.string().optional(),
});

/**
 * The full self-description catalog, mirroring the `CapabilityCatalog` type in
 * `@dorkos/shared/capabilities`. This is what {@link CapabilityRegistry.catalog}
 * returns and what {@link projectCatalog} narrows; it is NOT the shape
 * `capabilities.list` returns any more (that is {@link listCapabilitiesResultSchema}).
 *
 * @internal Exported so the domain's tests can validate the registry's raw
 *   catalog against the shape this module projects from. No runtime surface
 *   serves it.
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
  toolGroup: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Return only capabilities behind this per-agent grant, e.g. roomsManage — the ones a ' +
        'person has to switch on for an agent before they run at all. Exact match, ' +
        'case-sensitive, and it narrows like the two filters above.'
    ),
  detail: z
    .enum(['compact', 'full'])
    .optional()
    .describe(
      "'compact' returns id, title, tier, and a one-line summary; 'full' adds the model-facing " +
        'description and the input and output JSON Schemas. Defaults to compact, and to full only ' +
        `when a domain, query or toolGroup filter narrows the catalog to ${FULL_DETAIL_THRESHOLD} ` +
        'matches or fewer. A broad filter stays compact — ask for full detail explicitly if you ' +
        'want it.'
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
   * A one-line, agent-facing note about this page: how many matches were left
   * out and how to reach them when it is capped, and how to trade detail for
   * size either way. Present on every capped page, every full-detail page, and
   * every filtered page that came back compact. Absent only from the plain
   * no-argument call, which is already the cheapest answer there is.
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
   * @param remedy - What the caller should do instead, appended to the message.
   */
  constructor(cursor: string, remedy = 'use the nextCursor from a previous response') {
    super(`Invalid cursor ${JSON.stringify(cursor)}; ${remedy}.`);
    this.name = 'InvalidCursorError';
  }
}

/**
 * Encode a page offset into an opaque cursor token, bound to the catalog it was
 * minted against so a cursor cannot be replayed across a catalog that changed
 * underneath it (which would silently skip or repeat entries).
 */
function encodeCursor(catalogVersion: string, offset: number): string {
  return Buffer.from(`${catalogVersion}:${offset}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor token back into its page offset.
 *
 * Validates the decoded text rather than trusting `Number()`, which turns both
 * `''` and `'  '` into 0 — so before this check any string at all decoded to a
 * silent "start from the beginning" instead of an error.
 *
 * @param cursor - The opaque token from a previous response.
 * @param catalogVersion - The version of the catalog now being paged.
 * @returns The non-negative integer offset it encodes.
 * @throws {@link InvalidCursorError} when the token is not a server-minted
 *   offset, or was minted against a different catalog version.
 */
function decodeCursor(cursor: string, catalogVersion: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf(':');
  if (separator === -1) throw new InvalidCursorError(cursor);
  const offset = decoded.slice(separator + 1);
  if (!/^\d+$/.test(offset)) throw new InvalidCursorError(cursor);
  if (decoded.slice(0, separator) !== catalogVersion) {
    throw new InvalidCursorError(
      cursor,
      'the catalog changed since it was issued, so start paging again without a cursor'
    );
  }
  return Number(offset);
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

/**
 * Build the one-line "here's what this page costs you and how to shrink it"
 * note, or `undefined` for a page that costs nothing to explain.
 *
 * Three shapes get a note: a CAPPED page (matches were left out, and the caller
 * needs the cursor to reach them); a FULL-detail page (every entry carries both
 * JSON Schemas, which is where a context budget actually goes); and a FILTERED
 * page that came back compact, because the caller asked something specific and
 * should be told the schemas are one request away rather than left guessing.
 *
 * The one silent case is the plain no-argument call: compact, complete, and
 * already the cheapest answer there is.
 *
 * A zero-match page is answered FIRST and separately. It reaches here reporting
 * `detail:'full'` — nothing matched, so nothing exceeded the selectivity
 * threshold — and every sentence below would then be a lie told to an agent that
 * got an empty array: entries carrying full schemas that do not exist, and an
 * instruction to narrow a filter that already matches nothing.
 */
function buildGuidance(args: {
  total: number;
  shown: number;
  detail: 'compact' | 'full';
  filtered: boolean;
  nextCursor?: string;
}): string | undefined {
  if (args.total === 0) {
    return args.filtered
      ? 'Nothing matched. Broaden the query, drop the domain filter, or call with no arguments to see everything.'
      : 'The catalog is empty; no capabilities are registered.';
  }
  const silent = args.nextCursor === undefined && args.detail === 'compact' && !args.filtered;
  if (silent) return undefined;
  const capped =
    args.nextCursor === undefined
      ? ''
      : `Showing ${args.shown} of ${args.total} capabilities; ${args.total - args.shown} not shown. ` +
        `Page the rest with cursor:'${args.nextCursor}'. `;
  const sizing =
    args.detail === 'compact'
      ? "Each entry is compact; set detail:'full', or narrow until few enough match, for descriptions and schemas."
      : "Each entry carries its full description and both JSON Schemas; set detail:'compact' for id, title, tier, and a one-line summary instead.";
  const narrow = args.filtered
    ? 'Narrow further with a more specific domain, query or toolGroup.'
    : "Narrow with domain (e.g. domain:'mcp') or a query substring.";
  return `${capped}${sizing} ${narrow}`;
}

/**
 * Filter, sort, paginate, and (by default) compact a serialized catalog into a
 * bounded, usable page.
 *
 * Matching is AND across the two filters: `domain` keeps ids in that exact domain
 * segment, `query` keeps entries whose id, title, or description contains the text
 * (both case-insensitive). Survivors are sorted by id so pagination is stable, then
 * the `[offset, offset + limit)` window is returned. Detail defaults to compact and
 * rises to full only when a filter left {@link FULL_DETAIL_THRESHOLD} matches or
 * fewer; an explicit `detail` always wins. When the window does not reach the end,
 * `nextCursor` and `guidance` say so — nothing is ever dropped silently — and any
 * page served at full detail carries `guidance` too, naming the cheaper request.
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
  // Exact and case-SENSITIVE, unlike the two above, because a grant key is an
  // identifier the caller already holds rather than text it is searching for —
  // `roomsManage` is the string the manifest stores and the capability declares,
  // and matching it loosely would invent a second spelling of a key that has
  // exactly one.
  if (input.toolGroup !== undefined) {
    matches = matches.filter((c) => c.toolGroup === input.toolGroup);
  }

  const sorted = [...matches].sort((a, b) => a.id.localeCompare(b.id));
  const total = sorted.length;

  // A filter earns full detail only when it is SELECTIVE. Upgrading on any
  // filter at all meant `query:'a'` — which matches nearly everything — served
  // more characters than the unfiltered dump this module replaced, under the
  // default limit, so with no cursor and no guidance to say so.
  const filtered = domain !== undefined || query !== undefined || input.toolGroup !== undefined;
  const detail = input.detail ?? (filtered && total <= FULL_DETAIL_THRESHOLD ? 'full' : 'compact');

  const offset = input.cursor
    ? clamp(decodeCursor(input.cursor, catalog.catalogVersion), 0, total)
    : 0;
  const page = sorted.slice(offset, offset + input.limit);
  const returned = page.length;
  const end = offset + returned;
  const nextCursor = end < total ? encodeCursor(catalog.catalogVersion, end) : undefined;
  const guidance = buildGuidance({ total, shown: end, detail, filtered, nextCursor });

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
