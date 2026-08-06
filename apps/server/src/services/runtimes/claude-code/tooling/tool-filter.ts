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
 * ADR-0070 (superseded by ADR-260726-171347) built this feature on the premise
 * that the SDK's `allowedTools` option RESTRICTS which tools a session can
 * call. It never did. It is an auto-approval
 * list: "List of tool names that are auto-allowed without prompting for permission.
 * These tools will execute automatically without asking the user for approval"
 * (`sdk.d.ts`). The wording is not new — `@anthropic-ai/claude-agent-sdk` 0.2.58,
 * the version pinned when ADR-0070 landed, carried it character-for-character, with
 * `disallowedTools` documented twenty lines below. The SDK did not change; the
 * option was misread on day one.
 *
 * A `buildAllowedTools` function used to turn this config into that list, and the
 * message sender passed it to the SDK. It returned `undefined` when every group was
 * on, and a 31- to 35-name list (depending which group was off) as soon as one was
 * off. Every name in that list then skipped the approval prompt: `binding_delete`,
 * which deletes a chat route, and `relay_disable_adapter`, which switches off a
 * connected integration, are representative of what that exposed. With every group on,
 * only the 13 names in `DORKOS_AGENT_TOOLS` auto-approved. So the toggle ran
 * backwards: switching a group off WIDENED the agent's auto-approval instead of
 * narrowing its access. Since `enabledToolGroups` is agent-writable through
 * `config_patch`, an agent could do that to itself.
 *
 * The two `destructive` tools, `tasks_delete` and `mesh_unregister`, were in those
 * lists but were never actually exposed, and it is worth knowing why before trusting
 * this layer with anything. `allowedTools` only decides whether the SDK asks before
 * invoking a tool; it cannot reach inside the tool. Both are gated in the handler
 * instead, by `gateHandRegisteredMcpTools` (`core/mcp-tool-gate.ts`), which runs
 * `runGate` and returns `approval_required` before the real handler runs (DOR-468).
 * The list therefore held 29 to 34 `act` and `observe` tools. Not all of those were
 * newly exposed: 7 to 13 of them (the overlap with `DORKOS_AGENT_TOOLS`) auto-approve
 * through `canUseTool` no matter what any toggle says, before the bug and after it.
 * The prompts the toggle actually silenced numbered 16 to 24, peaking with Mesh off.
 * State the delta, not the end state, if you cite this again. The
 * lesson for anyone editing this file: enforcement of consequence belongs in the
 * tier gate, which sits below every caller, not in a list of names handed to an SDK
 * option that a config toggle can rewrite.
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
