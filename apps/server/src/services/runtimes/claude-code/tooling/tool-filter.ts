/**
 * Per-agent MCP tool filtering for DorkOS sessions.
 *
 * Provides two functions for the per-session tool resolution pipeline:
 * - `resolveToolConfig`: merges per-agent `enabledToolGroups` with global
 *   defaults, gated by server feature flags.
 * - `buildAllowedTools`: converts a `ResolvedToolConfig` into the
 *   `allowedTools` array consumed by the SDK `query()` call.
 *
 * The tool names themselves are NOT written down here. Which group each tool
 * belongs to, and which toggle gates that group (including the implicit
 * `trace`-follows-`relay` and `binding`-follows-`adapter` parenting from
 * ADR-0071), is declared once in `@dorkos/shared/mcp-tool-groups` and shared with
 * the cockpit's Settings screens, which used to keep their own hand-copied
 * inventories of the same fact (DOR-499). The arrays below are derived from that
 * table.
 *
 * ## What `allowedTools` actually does, which is not what ADR-0070 assumed
 *
 * Read this before changing which names reach the returned list.
 *
 * ADR-0070 built this feature on the premise that the SDK's `allowedTools`
 * option RESTRICTS which tools a session can call. It does not. In
 * `@anthropic-ai/claude-agent-sdk` 0.3.177 it is an AUTO-APPROVAL list: "List of
 * tool names that are auto-allowed without prompting for permission. These tools
 * will execute automatically without asking the user for approval" (`sdk.d.ts`).
 *
 * That entry goes on to say "To restrict which tools are available, use the `tools`
 * option instead", which is NOT the fix it sounds like: `Options.tools` selects the
 * base set of BUILT-IN tools (Bash, Read, Edit, and so on) and cannot remove an MCP
 * tool. The option that takes an MCP tool out of the model's reach is
 * `disallowedTools`. DorkOS sets none of the three.
 *
 * Two consequences, both load-bearing for anyone editing this file:
 *
 * 1. Turning a group off does not take those tools away from the agent. They stay
 *    registered and callable.
 * 2. Turning a group off makes this function return a non-`undefined` list, which
 *    the sender passes to `sdkOptions.allowedTools` — so the REMAINING tools stop
 *    prompting for approval. Disabling one group therefore widens auto-approval
 *    rather than narrowing access.
 *
 * That is why the always-available set below is deliberately the `core`, `ui`, and
 * `devtools` groups only, and NOT the full set of tools no toggle gates. Adding
 * `create_agent`, the extension tools, or the Capability Registry's tools here
 * would not restore any access they are missing (nothing is being withheld); it
 * would only extend the approval bypass to `marketplace_install`, `config_patch`,
 * and friends. Closing the real gap means moving this pipeline onto
 * `disallowedTools` and amending ADR-0070, which is a behavior change with its own
 * security review, not a list edit.
 *
 * @module services/runtimes/claude-code/tooling/tool-filter
 */
import type { EnabledToolGroups } from '@dorkos/shared/mesh-schemas';
import {
  SESSION_CORE_TOOL_GROUPS,
  toolNamesInGroup,
  type ToolGateGroup,
} from '@dorkos/shared/mcp-tool-groups';

// === Dependency types ===

export interface ToolFilterDeps {
  relayEnabled: boolean;
  tasksEnabled: boolean;
  globalConfig: {
    tasksTools: boolean;
    relayTools: boolean;
    meshTools: boolean;
    adapterTools: boolean;
  };
}

export interface ResolvedToolConfig {
  tasks: boolean;
  relay: boolean;
  mesh: boolean;
  adapter: boolean;
}

// === Tool name constants, derived from the shared group table ===

/** The prefix the SDK gives every tool on the in-session `dorkos` MCP server. */
const TOOL_PREFIX = 'mcp__dorkos__';

/**
 * The prefixed SDK tool names in one group.
 *
 * @param group - The group to list.
 * @returns The names as the SDK sees them, in the shared table's order.
 */
function prefixed(group: ToolGateGroup): string[] {
  return toolNamesInGroup(group).map((name) => `${TOOL_PREFIX}${name}`);
}

/**
 * The tools the session list always includes, whatever the toggles say.
 *
 * The groups are chosen in `@dorkos/shared/mcp-tool-groups`, and the cockpit's
 * "always enabled" row reads the same constant, so the screen and the session
 * cannot disagree. It is narrower than "every tool no toggle gates" on purpose;
 * see the module TSDoc for why widening it would extend an approval bypass rather
 * than restore access.
 */
const CORE_TOOLS = SESSION_CORE_TOOL_GROUPS.flatMap(prefixed);

const TASKS_TOOLS = prefixed('tasks');

const RELAY_TOOLS = prefixed('relay');

const MESH_TOOLS = prefixed('mesh');

const ADAPTER_TOOLS = prefixed('adapter');

/** Follows the adapter toggle — disabled when adapter=false. */
const BINDING_TOOLS = prefixed('binding');

/** Follows the relay toggle — disabled when relay=false. */
const TRACE_TOOLS = prefixed('trace');

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
    tasks: (agent.tasks ?? deps.globalConfig.tasksTools) && deps.tasksEnabled,
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
 * Returns `undefined` when every domain is enabled, which leaves `allowedTools`
 * unset. When any domain is disabled, returns the enabled domains' tools plus the
 * always-on set.
 *
 * Read the module TSDoc before assuming what the caller does with this. Despite the
 * name, the SDK treats the result as an auto-approval list, not a restriction, so
 * this function does not remove a disabled domain's tools from the session. Naming
 * it after the SDK option it feeds is the least confusing of the available options,
 * and the discrepancy is the SDK's rather than ours.
 *
 * Implicit grouping:
 * - Binding tools are included when `config.adapter` is `true`
 * - Trace tools are included when `config.relay` is `true`
 *
 * @param config - The resolved tool configuration produced by `resolveToolConfig`.
 */
export function buildAllowedTools(config: ResolvedToolConfig): string[] | undefined {
  if (config.tasks && config.relay && config.mesh && config.adapter) {
    // All domains enabled — no filtering needed; return undefined to skip allowedTools
    return undefined;
  }

  const allowed: string[] = [...CORE_TOOLS];

  if (config.tasks) allowed.push(...TASKS_TOOLS);

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
