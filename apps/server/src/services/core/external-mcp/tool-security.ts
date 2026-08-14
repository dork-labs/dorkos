/**
 * The read-only carve-out for the login-off `/mcp` surface (DOR-278).
 *
 * When login is off and no `MCP_API_KEY` override is set, the external MCP
 * endpoint requires the per-instance local token on every mutating call. The one
 * exception is tools annotated `readOnlyHint: true` — health checks,
 * introspection, and listings stay tokenless so a `curl` demo still works with no
 * config. {@link READ_ONLY_MCP_TOOL_NAMES} is the single source of truth the
 * `mcp-auth` middleware consults for that carve-out.
 *
 * **Fail-closed by construction:** any tool name NOT in this set is treated as
 * GUARDED. A newly added tool therefore defaults to token-required until it is
 * both annotated `readOnlyHint: true` AND admitted to this set — and the
 * drift-guard test (`__tests__/tool-security.test.ts`) fails the build if this
 * set ever diverges from the live `tools/list` annotations.
 *
 * **Read-only is necessary and not sufficient.** A tool may be annotated
 * `readOnlyHint: true` and still require a token, and the ones that do are named
 * in {@link GUARDED_READ_ONLY_TOOL_NAMES} rather than left as a silent gap; the
 * drift guard checks `carve-out ∪ deliberately-guarded === live read-only`, so
 * neither set can drift and no tool can fall between them.
 *
 * The set has two sources, unioned here:
 *
 * - Registry capabilities (operator, marketplace, connector, MCP-management,
 *   rooms, self-description — spec `capability-registry`) contribute their
 *   carve-out tool names by DERIVATION: a capability opts in with
 *   `surfaces.mcp.readOnlyCarveOut: true`, and {@link readOnlyCarveOutToolNames}
 *   reads that flag. There is no second place to keep in sync. **Every domain is
 *   listed whether or not it contributes a name today** — the rooms domain
 *   contributes none on purpose — because listing is what puts a domain under the
 *   drift guard, and an unlisted domain could later opt a tool in without this
 *   set, or its test, ever noticing.
 * - Domains not yet migrated onto the registry (core, tasks, binding,
 *   agent-extension, mesh, relay) still hand-register their read-only tools, so
 *   their names are listed literally in {@link LEGACY_READ_ONLY_TOOL_NAMES}
 *   until those domains migrate.
 *
 * @module services/core/external-mcp/tool-security
 */
import { readOnlyCarveOutToolNames } from '../capabilities/index.js';
import { operatorDomain } from '../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../marketplace-mcp/marketplace-capabilities.js';
import { connectorDomain } from '../../connectors/connector-capabilities.js';
import { mcpDomain } from '../../mesh/mcp-capabilities.js';
import { roomsDomain } from '../../rooms/room-capabilities.js';
import { capabilitiesDomain } from '../self-description/capabilities-domain.js';

/**
 * Read-only tool names from domains NOT yet migrated onto the Capability
 * Registry (core, tasks, binding, agent-extension, mesh, relay). Each is still
 * hand-registered with `readOnlyHint: true` on the external server; they move
 * out of this list and into a `readOnlyCarveOut` capability flag as their
 * domains migrate. Mirrors the `readOnlyHint` audit in
 * `specs/mcp-local-auth-posture`.
 *
 * ## Why this list is written out rather than derived (DOR-499)
 *
 * These 18 names are exactly the `observe`-tier tools that reach the external
 * server, so deriving them from `MCP_TOOL_TIERS` would produce an identical set
 * today. That was considered and rejected, because the two lists mean different
 * things and only one of them is a security boundary:
 *
 * - A tier answers "does calling this need a person's approval". `observe` is
 *   chosen freely, and it is the DEFAULT-ish choice for anything that mostly
 *   reads.
 * - This list answers "may this be called with NO CREDENTIAL AT ALL when login
 *   is off". That is a much stronger claim, and it must be made deliberately,
 *   one tool at a time.
 *
 * Deriving it would convert the module's fail-closed property into a fail-open
 * one: the next `observe` tool anybody adds would join the tokenless carve-out on
 * its own, silently, as a side effect of picking a tier. A list that must be
 * edited by hand is the point here — the cost of one extra line is what buys the
 * guarantee that nothing reaches the unauthenticated surface by accident.
 *
 * The relationship is still pinned, in the safe direction: `mcp-tool-gate.test.ts`
 * asserts that every name here is `observe` tier and that no `destructive` tool
 * appears. That catches a mistake without letting the tier table grant anything.
 */
const LEGACY_READ_ONLY_TOOL_NAMES: readonly string[] = [
  // core
  'ping',
  'get_server_info',
  'get_session_count',
  'get_agent',
  // tasks
  'tasks_list',
  'tasks_get_run_history',
  // binding
  'binding_list',
  // agent + extension
  'get_extension_api',
  'list_extensions',
  'get_extension_errors',
  // mesh
  'mesh_list',
  'mesh_status',
  'mesh_inspect',
  'mesh_query_topology',
  // relay
  'relay_list_endpoints',
  'relay_list_adapters',
  'relay_get_trace',
  'relay_get_metrics',
];

/**
 * The exact set of externally-registered MCP tools annotated `readOnlyHint:
 * true` — the tokenless read-only carve-out for the login-off `/mcp` surface.
 *
 * Composed from the two sources above: the migrated operator + marketplace
 * capabilities' `readOnlyCarveOut` flags plus the legacy hand-registered
 * read-only tools. Kept in lock-step with the live server by the drift-guard
 * test. Any tool NOT in this set is guarded (token required).
 */
/**
 * Tools that ARE read-only and are deliberately kept OUT of the tokenless
 * carve-out — the one place a `readOnlyHint: true` tool may still require a
 * token, written down so it is a decision rather than an oversight.
 *
 * `readOnlyHint` answers "does this change anything?" and the carve-out answers
 * "may a caller with no credential reach it?", and those are not the same
 * question. Every entry here is read-only and, until this list existed, the drift
 * guard's equality forced them to be tokenless too.
 *
 * The rooms history tools (room-participation spec §10.3) are the first and only
 * members: they return **other members' messages**, which is the same content the
 * HTTP room routes serve behind `sessionGate`. A `curl` demo that works with no
 * config is worth a health check and a listing; it is not worth somebody's
 * conversations. Membership still gates them on every surface — this decides
 * only whether an unauthenticated local caller may ask at all.
 *
 * **Adding a name here needs an argument, and removing one needs a better one.**
 * The drift guard reads this list, so a tool that quietly acquires
 * `readOnlyCarveOut: true` still fails the build.
 */
export const GUARDED_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'read_room_history',
  'search_room_history',
]);

export const READ_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...LEGACY_READ_ONLY_TOOL_NAMES,
  ...readOnlyCarveOutToolNames([
    ...operatorDomain.capabilities,
    ...marketplaceDomain.capabilities,
    ...connectorDomain.capabilities,
    ...mcpDomain.capabilities,
    // The rooms domain contributes NOTHING today, and is listed anyway. Its two
    // reads are `observe` and deliberately withhold `readOnlyCarveOut`, because
    // what they return is other people's messages; naming the domain here is what
    // puts them under the drift guard, so a later edit that adds the flag has to
    // move this set — and be argued for — rather than widening the tokenless
    // surface in silence. A domain nobody lists is a domain nobody checks.
    ...roomsDomain.capabilities,
    ...capabilitiesDomain.capabilities,
  ]),
]);
