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
 * last. Enforced server-side at every agent-facing choke point (spec
 * `agent-trust` §3.2): `observe` and `act` proceed, and a `destructive`
 * capability reached by an identified agent needs a person's approval first.
 *
 * - `observe` — pure reads; no state mutation.
 * - `act` — mutates local state (config, agent manifests, installs).
 * - `destructive` — deletes or unregisters a resource.
 */
export const CAPABILITY_TIERS = ['observe', 'act', 'destructive'] as const;

/** A capability's permission tier. One of {@link CAPABILITY_TIERS}. */
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

/**
 * How wide each tier's blast radius is, as a comparable number — the machine
 * reading of {@link CAPABILITY_TIERS}'s stated order.
 *
 * Two places compare tiers and they must never disagree: the gate that refuses a
 * capability above a caller's ceiling, and the guard that decides whether a
 * change to a per-agent ceiling widens it (and so belongs to a person). Derived
 * from the ordered list rather than written out, so a tier added there cannot be
 * forgotten here.
 */
export const CAPABILITY_TIER_RANK: Record<CapabilityTier, number> = Object.fromEntries(
  CAPABILITY_TIERS.map((tier, index) => [tier, index])
) as Record<CapabilityTier, number>;

/**
 * What an agent with no recorded ceiling is allowed to reach: everything.
 *
 * The migration guarantee for {@link CAPABILITY_TIERS} as a per-agent limit
 * (DOR-486). Every agent that existed before ceilings were settable has no value
 * on its manifest, and none of them may quietly lose capability — so absent
 * reads as the widest rung, and a narrower one is only ever something somebody
 * chose.
 */
export const DEFAULT_AGENT_TIER_CEILING: CapabilityTier = 'destructive';

/**
 * How each tier reads as a LIMIT on an agent, in the words a person sees.
 *
 * A ceiling's sentence is not its tier's sentence — "changes things" describes a
 * capability, "changes that can be undone" describes the fence around an agent.
 * Shared because three surfaces say it and must say it identically: the gate's
 * refusal, the refusal an agent gets for trying to widen its own fence, and the
 * control a person sets it with.
 */
export const CAPABILITY_CEILING_PHRASE: Record<CapabilityTier, string> = {
  observe: 'reading only',
  act: 'changes that can be undone',
  destructive: 'anything',
};

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
 * The two MCP tool-annotation hints that vary WITHIN a permission tier and so
 * cannot be regenerated from {@link CapabilityTier} alone.
 *
 * In the phase-1 descriptor tables both hints split tier-siblings apart:
 * `check_update` / `marketplace_search` / `marketplace_get` /
 * `marketplace_recommend` / `marketplace_install` are `openWorldHint: true`
 * while their tier-mates are `false`; `update_agent` / `config_patch` are
 * `idempotentHint: true` while `marketplace_install` / `marketplace_create_package`
 * are `false`. A capability carries only these two overrides — the other two
 * MCP hints are derived from tier by the adapter (see {@link McpSurface}).
 */
export interface McpToolHints {
  /** Whether the tool touches an external, open world (e.g. a remote fetch). */
  openWorldHint?: boolean;
  /** Whether repeat calls with the same args converge (no cumulative effect). */
  idempotentHint?: boolean;
}

/**
 * The MCP projection of a capability: the stable phase-1 tool name it answers
 * to, which server(s) advertise it, whether it belongs to the read-only
 * carve-out that stays reachable on the tokenless external surface, and the
 * per-tool annotation hints that a tier cannot express.
 *
 * The MCP `readOnlyHint` and `destructiveHint` are NOT declared here: the
 * transport adapter (task 2.2) derives them from {@link CapabilityTier}
 * (`observe` → `readOnlyHint: true`; `destructive` → `destructiveHint: true`).
 * Because the MCP SDK defaults `destructiveHint` to `true`, that adapter must
 * emit `destructiveHint: false` EXPLICITLY for every non-`destructive` tool —
 * otherwise `observe`/`act` tools would be mislabeled destructive.
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
  /**
   * The two MCP hints that vary within a tier and so can't be derived from it.
   * Omit when both match the tier defaults the adapter applies (open-world and
   * idempotent both `false`). See {@link McpToolHints}.
   */
  annotations?: McpToolHints;
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
  /** Permission tier. Enforced at the choke points, not advisory. */
  tier: CapabilityTier;
  /** Input contract as JSON Schema. */
  inputSchema: JsonSchema;
  /** Output contract as JSON Schema. */
  outputSchema: JsonSchema;
  /** The surfaces this capability projects onto. */
  surfaces: CapabilitySurfaces;
  /**
   * The per-agent grant this capability requires, when it declares one.
   *
   * Absent for the ungated majority. Present means the call is REFUSED for an
   * agent that does not hold this grant on its manifest — a real boundary,
   * unlike the four documentation keys that share the `enabledToolGroups`
   * object (see `mcp-tool-groups.ts`).
   *
   * It rides the catalog so the one declaration on the capability has one
   * answer everywhere: the server enforces it, the cockpit's per-agent Tools
   * tab reads it off the live catalog rather than a static list that could
   * drift, and the docs projection reports it from the same place.
   *
   * A bare string rather than the server's `CapabilityToolGroup` union: this
   * package is the wire contract and must not narrow ahead of the server.
   */
  toolGroup?: string;
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
 * Hard ceiling on how many capabilities one page of the catalog may carry.
 *
 * It lives here, not on either side, because two independent surfaces have to
 * agree on it: the server clamps the `limit` query parameter to it, and the
 * CLI's pager asks for exactly this many per request. When they disagreed the
 * CLI silently asked for more than the server would give, so the two now read
 * the same number.
 */
export const MAX_CAPABILITY_LIMIT = 200;

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
 * ## Plain data only
 *
 * Canonicalization rebuilds every object from its own enumerable keys, which
 * bypasses `toJSON` and sees nothing inside a `Set` or `Map`. So a `Date` loses
 * its instant and `new Set(['a'])` serializes the same as `new Set(['b'])`. That
 * is fine for the catalog (plain serialized schemas) and NOT fine for anything
 * security-relevant: `hashApprovalInput` therefore rejects non-plain values
 * before calling this, rather than hashing a value it would silently flatten.
 *
 * @param value - Any plain JSON value. Dates, Sets, Maps, and class instances
 *   lose information here; do not pass them.
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

/**
 * Capability input field names whose VALUE is credential material, matched
 * case-insensitively against the whole key.
 *
 * `confirmationToken` on `marketplace.uninstall` is the live example: its own
 * description tells a model to re-call with a token, so a model that puts the
 * token in the wrong place would publish it.
 */
const SECRET_INPUT_KEY_PATTERN =
  /token|secret|password|passphrase|credential|cookie|authorization|apikey|api[-_]key|private[-_]?key/i;

/**
 * Whether a capability input field name says its value is a secret.
 *
 * Lives here, in the dependency-free capability spine, so the ONE definition is
 * shared by the two places that must agree: the server's approval-card renderer,
 * which drops such a field, and the conformance suite, which fails a capability
 * that names one in its `approvalDisplayFields`. Two copies of this list would
 * drift, and the drift would be silent — the renderer would keep a field off the
 * card while the checker waved it through, or vice versa.
 *
 * @param key - The input field name (or the last segment of a dotted path).
 * @returns True when the field's value must be withheld from an approval card.
 */
export function isSecretInputKey(key: string): boolean {
  return SECRET_INPUT_KEY_PATTERN.test(key);
}
