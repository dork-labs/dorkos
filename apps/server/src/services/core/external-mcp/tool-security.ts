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
 * both annotated `readOnlyHint: true` AND added here — and the drift-guard test
 * (`__tests__/tool-security.test.ts`) fails the build if this set ever diverges
 * from the live `tools/list` annotations in either direction.
 *
 * @module services/core/external-mcp/tool-security
 */

/**
 * The exact set of externally-registered MCP tools annotated `readOnlyHint:
 * true` — the tokenless read-only carve-out for the login-off `/mcp` surface.
 *
 * Mirrors the `readOnlyHint` audit in `specs/mcp-local-auth-posture`: 23 tools
 * (core, tasks, binding, agent-extension, mesh, relay, marketplace). Kept in
 * lock-step with the live server by the drift-guard test. Any tool NOT listed
 * here is guarded (token required).
 */
export const READ_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
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
  // marketplace
  'marketplace_search',
  'marketplace_get',
  'marketplace_recommend',
  'marketplace_list_marketplaces',
  'marketplace_list_installed',
]);
