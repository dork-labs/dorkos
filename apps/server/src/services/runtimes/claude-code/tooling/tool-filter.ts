/**
 * Per-agent MCP tool-group resolution for DorkOS sessions.
 *
 * Exports `resolveToolConfig`, which merges an agent's `enabledToolGroups` with the
 * global defaults and the server's feature flags into one `ResolvedToolConfig`.
 *
 * ## What the toggles actually do
 *
 * Exactly one thing: `buildSystemPromptAppend` (`../messaging/context-builder.ts`)
 * reads the resolved config and leaves a disabled group's tool block out of the
 * agent's context, so the agent is never told those tools exist. That is the whole
 * mechanism. The tools stay registered on the session's MCP server and an agent that
 * names one anyway can still call it, subject to the normal approval prompt.
 *
 * ## Why there is no `allowedTools` list here any more (DOR-519)
 *
 * ADR-0070 built this feature on the premise that the SDK's `allowedTools` option
 * RESTRICTS which tools a session can call. It never did. It is an auto-approval
 * list: "List of tool names that are auto-allowed without prompting for permission.
 * These tools will execute automatically without asking the user for approval"
 * (`sdk.d.ts`). The wording is not new — `@anthropic-ai/claude-agent-sdk` 0.2.58,
 * the version pinned when ADR-0070 landed, carried it character-for-character, with
 * `disallowedTools` documented twenty lines below. The SDK did not change; the
 * option was misread on day one.
 *
 * A `buildAllowedTools` function used to turn this config into that list, and the
 * message sender passed it to the SDK. Because it returned `undefined` when every
 * group was on and a 31-name list as soon as any group was off, turning a group off
 * made 31 tools skip the approval prompt, including `tasks_delete`,
 * `mesh_unregister`, `binding_delete`, and `relay_disable_adapter`. With every group
 * on, only the 13 names in `DORKOS_AGENT_TOOLS` auto-approved. So the toggle ran
 * backwards: switching a group off WIDENED the agent's auto-approval instead of
 * narrowing its access. Since `enabledToolGroups` is agent-writable through
 * `config_patch`, an agent could do that to itself.
 *
 * The function and its tool-name arrays are gone. Nothing in this file feeds
 * `allowedTools`, and nothing should: every DorkOS tool now routes through
 * `canUseTool`, which is the one place that decides what skips a prompt.
 *
 * Restricting real access is a separate, still-open piece of work: leave the tools
 * out at MCP registration time so a disabled group is never offered. Reaching for
 * `disallowedTools` instead looks shorter and is worse, because it re-centralises the
 * same list-of-names problem in a second SDK option. That work is expected to land in
 * this file, which is why the module keeps its name.
 *
 * @module services/runtimes/claude-code/tooling/tool-filter
 */
import type { EnabledToolGroups } from '@dorkos/shared/mesh-schemas';

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
 * The result gates context blocks and nothing else; see the module TSDoc.
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
