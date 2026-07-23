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
 * set ever diverges from the live `tools/list` annotations in either direction.
 *
 * The set has two sources, unioned here:
 *
 * - Registry capabilities (operator + marketplace, spec `capability-registry`)
 *   contribute their carve-out tool names by DERIVATION — a capability opts in
 *   with `surfaces.mcp.readOnlyCarveOut: true`, and
 *   {@link readOnlyCarveOutToolNames} reads that flag. There is no second place
 *   to keep in sync.
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
import { capabilitiesDomain } from '../self-description/capabilities-domain.js';

/**
 * Read-only tool names from domains NOT yet migrated onto the Capability
 * Registry (core, tasks, binding, agent-extension, mesh, relay). Each is still
 * hand-registered with `readOnlyHint: true` on the external server; they move
 * out of this list and into a `readOnlyCarveOut` capability flag as their
 * domains migrate. Mirrors the `readOnlyHint` audit in
 * `specs/mcp-local-auth-posture`.
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
export const READ_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...LEGACY_READ_ONLY_TOOL_NAMES,
  ...readOnlyCarveOutToolNames([
    ...operatorDomain.capabilities,
    ...marketplaceDomain.capabilities,
    ...capabilitiesDomain.capabilities,
  ]),
]);
