/**
 * Serializable catalog types for the DorkOS Capability Registry.
 *
 * A capability is declared exactly once in its owning server domain (id,
 * model-facing description, Zod input/output, permission tier, handler) and
 * every agent-facing surface — the two MCP servers, the CLI operator verbs,
 * OpenAPI paths, and the `GET /api/capabilities` self-description — is derived
 * from that single declaration (spec `capability-registry`).
 *
 * This module is the SERIALIZABLE half of that contract: the JSON-shaped
 * catalog an agent, the CLI, or (later) the cockpit consumes over the wire,
 * with Zod schemas already converted to JSON Schema and the handler dropped.
 * It carries no runtime dependencies (no Zod, no Node built-ins) so it is safe
 * to import from any surface — server, CLI, or browser. The runtime half —
 * `CapabilityDefinition`, `composeRegistry`, and the JSON-Schema/hash
 * serialization that produces these shapes — lives server-side in
 * `apps/server/src/services/core/capabilities/`.
 *
 * @module capabilities
 */

/**
 * The ordered permission tiers a capability can declare, widest-blast-radius
 * last. Declared now, enforced in phase 3 — until then these are inert
 * metadata and must never be presented as an active permission gate.
 *
 * - `observe` — pure reads; no state mutation.
 * - `act` — mutates local state (config, agent manifests, installs).
 * - `destructive` — deletes or unregisters a resource.
 */
export const CAPABILITY_TIERS = ['observe', 'act', 'destructive'] as const;

/** A capability's permission tier. One of {@link CAPABILITY_TIERS}. */
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

/** The two MCP servers a capability's tool surface can be advertised on. */
export type McpServerId = 'in-session' | 'external';

/**
 * HTTP methods a capability's `http` surface can project into OpenAPI.
 * Lowercase to match the OpenAPI document's path-item method keys.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * A JSON Schema object (draft 2020-12), as produced from a capability's Zod
 * schema by the server's native `z.toJSONSchema` conversion. Kept structural
 * (a plain object map) so this module stays free of a JSON-Schema dependency.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * The MCP projection of a capability: the stable phase-1 tool name it answers
 * to, which server(s) advertise it, and whether it belongs to the read-only
 * carve-out that stays reachable on the tokenless external surface.
 */
export interface McpSurface {
  /** Registered MCP tool name, e.g. `config_get` (a frozen phase-1 contract). */
  toolName: string;
  /** Which MCP servers advertise this tool. */
  servers: McpServerId[];
  /**
   * When `true`, this tool is derived into `READ_ONLY_MCP_TOOL_NAMES` — the set
   * reachable without the local token in login-off mode. Only ever set on
   * `observe`-tier tools; mutating tools must omit it.
   */
  readOnlyCarveOut?: boolean;
}

/**
 * The CLI projection of a capability: the operator verb (and optional
 * subcommand) whose internals dispatch through this capability's id.
 */
export interface CliSurface {
  /** Top-level operator verb, e.g. `config` or `agent`. */
  verb: string;
  /** Optional subcommand under the verb, e.g. `get` in `config get`. */
  subcommand?: string;
}

/**
 * The HTTP projection of a capability: the method + path auto-registered into
 * the OpenAPI document so the capability appears in `/api/docs`.
 */
export interface HttpSurface {
  /** HTTP method for the projected route. */
  method: HttpMethod;
  /** Route path, e.g. `/api/capabilities`. */
  path: string;
}

/**
 * The surfaces a capability projects onto. Every field is optional: a
 * capability with no `cli` surface has no curated verb (agents still reach it
 * via the generic `dorkos call`), and one with no `http` surface stays off the
 * OpenAPI document.
 */
export interface CapabilitySurfaces {
  /** MCP tool projection (in-session and/or external server). */
  mcp?: McpSurface;
  /** CLI operator-verb projection. */
  cli?: CliSurface;
  /** OpenAPI/HTTP projection. */
  http?: HttpSurface;
}

/**
 * A single capability as it appears in the serialized catalog: everything from
 * its runtime definition except the handler, with the Zod input/output schemas
 * converted to JSON Schema.
 */
export interface SerializedCapability {
  /** Stable `${domain}.${verb}` identifier, e.g. `config.get`. */
  id: string;
  /** Human-facing title. */
  title: string;
  /** Model-facing description (ACI style — what it does, when to use it). */
  description: string;
  /** Permission tier (inert metadata until phase 3). */
  tier: CapabilityTier;
  /** Input contract as JSON Schema. */
  inputSchema: JsonSchema;
  /** Output contract as JSON Schema. */
  outputSchema: JsonSchema;
  /** The surfaces this capability projects onto. */
  surfaces: CapabilitySurfaces;
}

/**
 * The full self-description catalog served by `GET /api/capabilities`,
 * `dorkos capabilities`, and the `list_capabilities` MCP tool.
 *
 * `catalogVersion` is a stable content hash over the capabilities (independent
 * of object key order and capability ordering) so agents can cache; it does NOT
 * fold in `generatedAt`, which changes on every read.
 */
export interface CapabilityCatalog {
  /** Stable content hash of {@link capabilities}; safe as a cache key. */
  catalogVersion: string;
  /** ISO-8601 timestamp of when this snapshot was produced. */
  generatedAt: string;
  /** Every registered capability, in registration order. */
  capabilities: SerializedCapability[];
}

/**
 * Deterministically serialize a JSON-compatible value with object keys sorted
 * recursively, so two structurally-equal values with different key insertion
 * order produce byte-identical output.
 *
 * This is the canonical form the catalog content hash is computed over: it
 * makes `catalogVersion` depend only on the catalog's content, never on the
 * order fields happen to be written in. Array order is preserved (it is
 * meaningful); only object keys are sorted. Pure and dependency-free so any
 * surface can recompute or verify a version.
 *
 * @param value - Any JSON-serializable value.
 * @returns A stable JSON string with all object keys sorted.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Recursively return a structural copy of `value` with every object's keys in
 * sorted order. Arrays keep their order; primitives pass through.
 *
 * @param value - The value to canonicalize.
 * @returns A key-sorted structural copy.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
