/**
 * Per-agent MCP tool filtering for DorkOS sessions.
 *
 * Provides two functions for the per-session tool resolution pipeline:
 * - `resolveToolConfig`: merges per-agent `enabledToolGroups` with global
 *   defaults, gated by server feature flags.
 * - `buildAllowedTools`: converts a `ResolvedToolConfig` into the
 *   `allowedTools` array consumed by the SDK `query()` call.
 *
 * Implicit grouping rules:
 * - `adapter: false` also disables Binding tools
 * - `relay: false` also disables Trace tools
 * - Core tools are always enabled
 *
 * @module services/runtimes/claude-code/tool-filter
 */
import type { EnabledToolGroups } from '@dorkos/shared/mesh-schemas';

// === Dependency types ===

export interface ToolFilterDeps {
  relayEnabled: boolean;
  pulseEnabled: boolean;
  globalConfig: {
    pulseTools: boolean;
    relayTools: boolean;
    meshTools: boolean;
    adapterTools: boolean;
  };
}

export interface ResolvedToolConfig {
  pulse: boolean;
  relay: boolean;
  mesh: boolean;
  adapter: boolean;
}

// === Tool name constants ===

const CORE_TOOLS = [
  'mcp__dorkos__ping',
  'mcp__dorkos__get_server_info',
  'mcp__dorkos__get_session_count',
  'mcp__dorkos__get_agent',
] as const;

const PULSE_TOOLS = [
  'mcp__dorkos__pulse_list_schedules',
  'mcp__dorkos__pulse_create_schedule',
  'mcp__dorkos__pulse_update_schedule',
  'mcp__dorkos__pulse_delete_schedule',
  'mcp__dorkos__pulse_get_run_history',
] as const;

const RELAY_TOOLS = [
  'mcp__dorkos__relay_send',
  'mcp__dorkos__relay_inbox',
  'mcp__dorkos__relay_list_endpoints',
  'mcp__dorkos__relay_register_endpoint',
  'mcp__dorkos__relay_send_and_wait',
  'mcp__dorkos__relay_send_async', // NEW
  'mcp__dorkos__relay_unregister_endpoint', // NEW
] as const;

const MESH_TOOLS = [
  'mcp__dorkos__mesh_discover',
  'mcp__dorkos__mesh_register',
  'mcp__dorkos__mesh_list',
  'mcp__dorkos__mesh_deny',
  'mcp__dorkos__mesh_unregister',
  'mcp__dorkos__mesh_status',
  'mcp__dorkos__mesh_inspect',
  'mcp__dorkos__mesh_query_topology',
] as const;

const ADAPTER_TOOLS = [
  'mcp__dorkos__relay_list_adapters',
  'mcp__dorkos__relay_enable_adapter',
  'mcp__dorkos__relay_disable_adapter',
  'mcp__dorkos__relay_reload_adapters',
] as const;

/** Follows the adapter toggle — disabled when adapter=false. */
const BINDING_TOOLS = [
  'mcp__dorkos__binding_list',
  'mcp__dorkos__binding_create',
  'mcp__dorkos__binding_delete',
] as const;

/** Follows the relay toggle — disabled when relay=false. */
const TRACE_TOOLS = ['mcp__dorkos__relay_get_trace', 'mcp__dorkos__relay_get_metrics'] as const;

// === Public API ===

/**
 * Resolve effective tool config by merging per-agent overrides with global defaults.
 *
 * Resolution order:
 * 1. Per-agent `enabledToolGroups` value (explicit `true`/`false`)
 * 2. Global config value (`agentContext.*Tools`)
 * 3. Server feature flag (hard gate — overrides both above when `false`)
 *
 * An `undefined` agent value means "inherit from global default".
 *
 * @param agentConfig - The `enabledToolGroups` from the agent manifest, or `undefined` when no manifest exists.
 * @param deps - Feature flags and global config values for the current server.
 */
export function resolveToolConfig(
  agentConfig: EnabledToolGroups | undefined,
  deps: ToolFilterDeps
): ResolvedToolConfig {
  const agent = agentConfig ?? {};
  return {
    pulse: (agent.pulse ?? deps.globalConfig.pulseTools) && deps.pulseEnabled,
    relay: (agent.relay ?? deps.globalConfig.relayTools) && deps.relayEnabled,
    // mesh has no server feature flag — always-on subsystem
    mesh: agent.mesh ?? deps.globalConfig.meshTools,
    // adapter depends on relay being enabled at the server level
    adapter: (agent.adapter ?? deps.globalConfig.adapterTools) && deps.relayEnabled,
  };
}

/**
 * Build the `allowedTools` list for an SDK session based on the resolved tool config.
 *
 * Returns `undefined` when all tool domains are enabled, meaning no filtering is needed
 * and the SDK will expose all registered MCP tools. When any domain is disabled, returns
 * an explicit allowlist that always includes core tools.
 *
 * Implicit grouping:
 * - Binding tools are included when `config.adapter` is `true`
 * - Trace tools are included when `config.relay` is `true`
 *
 * @param config - The resolved tool configuration produced by `resolveToolConfig`.
 */
export function buildAllowedTools(config: ResolvedToolConfig): string[] | undefined {
  if (config.pulse && config.relay && config.mesh && config.adapter) {
    // All domains enabled — no filtering needed; return undefined to skip allowedTools
    return undefined;
  }

  const allowed: string[] = [...CORE_TOOLS];

  if (config.pulse) allowed.push(...PULSE_TOOLS);

  if (config.relay) {
    allowed.push(...RELAY_TOOLS);
    // Trace tools follow the relay toggle (implicit grouping)
    allowed.push(...TRACE_TOOLS);
  }

  if (config.mesh) allowed.push(...MESH_TOOLS);

  if (config.adapter) {
    allowed.push(...ADAPTER_TOOLS);
    // Binding tools follow the adapter toggle (implicit grouping)
    allowed.push(...BINDING_TOOLS);
  }

  return allowed;
}
