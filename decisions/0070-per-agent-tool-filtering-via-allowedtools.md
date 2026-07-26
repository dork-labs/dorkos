---
number: 70
title: Per-Agent Tool Filtering via Domain-Level allowedTools
status: deprecated
created: 2026-03-04
spec: agent-tools-elevation
superseded-by: null
---

# 70. Per-Agent Tool Filtering via Domain-Level allowedTools

## Status

Deprecated (2026-07-26, DOR-519) — the mechanism decided here was removed. See the
amendments under Decision. What DorkOS does today is option 3 from the Context
above, context-only gating, documented in `contributing/architecture.md`
(Per-Session Tool Groups). No replacement ADR exists yet; one is due with the work
that restricts real tool access at MCP registration time.

## Context

DorkOS injects MCP tools into agent sessions via `createDorkOsToolServer`. Until now, all tools were available to all agents — the same tool set regardless of agent role. Spec #88 introduced global config toggles for context blocks, but no per-agent MCP tool filtering. Three approaches were considered: (1) per-session `allowedTools` filtering on a single shared MCP server, (2) dynamic per-agent MCP server creation, (3) context-only gating with no MCP filtering.

## Decision

Use the SDK's `allowedTools` option to filter MCP tools per session based on the agent's `enabledToolGroups` manifest field. A single MCP server registers all tools globally. Per session, `buildAllowedTools()` computes the allowed tool name list from the intersection of the agent's manifest config and global feature flags. Core tools (ping, get_server_info, get_session_count, get_agent) are always included.

> **Amendment (2026-07-26, DOR-499): the central premise above is false.** `allowedTools` does not filter anything. In `@anthropic-ai/claude-agent-sdk` 0.3.177 it is an AUTO-APPROVAL list: the tools named in it execute without asking the person for approval. The option that removes an MCP tool from the model's reach is `disallowedTools`, and DorkOS sets neither it nor `tools` (which selects built-in tools only and cannot remove an MCP tool).
>
> So turning a tool group off does not take those tools away from the agent. It makes `buildAllowedTools()` return a non-`undefined` list, which stops the REMAINING tools from prompting. Disabling a group therefore widens auto-approval rather than narrowing access.
>
> The "Negative" consequence below already suspected this: "`allowedTools` wildcard behavior with prefixes is not fully documented in the SDK — may need testing". That testing did not happen. Whether the SDK's semantics changed under us or were always this way is not established.
>
> Nothing was changed in this pipeline by DOR-499, which was a consolidation: the tool-name lists behind it were collapsed into one source, deliberately without touching behavior. Moving onto `disallowedTools` is a behavior change needing its own security review, tracked as DOR-519. Until then the current reading of the code, not this Decision, is authoritative; see the module TSDoc on `services/runtimes/claude-code/tooling/tool-filter.ts`.

> **Amendment (2026-07-26, DOR-519): the `allowedTools` wiring is deleted.** `message-sender.ts` no longer passes anything to that option, and `buildAllowedTools()` and its tool-name arrays are gone with it. A test in `claude-code-runtime.test.ts` fails if anything sets `allowedTools` again.
>
> Two things the previous amendment left open are now settled.
>
> **The SDK never changed.** Version 0.2.58, the one pinned when this ADR landed, described `allowedTools` as "List of tool names that are auto-allowed without prompting for permission" — character for character the same sentence as 0.3.177 carries today, with `disallowedTools` documented twenty lines below it. The option was misread on day one. Nothing drifted underneath us.
>
> **The wildcard homework was never done.** The Negative consequence "may need testing" was never actioned in the three months this shipped, and the testing would not have helped: no wildcard syntax makes an auto-approval list into a restriction.
>
> **How bad it was.** `buildAllowedTools()` returned `undefined` when every group was on, so nothing reached the SDK and all DorkOS tools went through `canUseTool`, which auto-approves only the 13 names in `DORKOS_AGENT_TOOLS`. Turn a single group off and it returned 31 names, all of which then skipped the approval prompt, including `tasks_delete`, `mesh_unregister`, `binding_delete`, and `relay_disable_adapter`. The toggle ran backwards: turning protection off widened auto-approval. And because `config-write-policy.ts` classifies the `agentContext.*Tools` fields as `agent-writable` while defining `operator-only` as "changing it removes or widens a security control", an agent could call `config_patch` with `relayTools: false` and widen its own auto-approval, globally. Deleting the wiring makes that misclassification harmless without touching the policy table.
>
> **Only claude-code was ever affected.** `supportsMcp` is true for claude-code alone (`runtime-constants.ts`); codex, opencode, and test-mode cannot receive DorkOS MCP tools. None of this was persisted in SQLite, so no migration was needed.
>
> **What survives.** The `enabledToolGroups` field, the cockpit's toggles, and `resolveToolConfig()` all stay, because the second half of the original dual gating is real: `buildSystemPromptAppend` still leaves a disabled group's tool block out of the agent's context, so the agent is not told those tools exist. That is guidance, not a boundary, and the "Dual gating" line under Positive below is now wrong on its first half.
>
> **What is still open.** Taking real access away means leaving a disabled group's tools out at MCP registration time. `disallowedTools` looks like the shorter route and is worse: it re-centralises the same list-of-names fragility in a second SDK option, and the Negative consequence about maintaining explicit name lists applies to it in full.

## Consequences

### Positive

- Uses the SDK's intended mechanism for per-session tool access control
- No dynamic server creation — avoids resource leak risks and complexity
- Dual gating (allowedTools + context block omission) ensures tools and context stay in sync
- Backward-compatible: agents without `enabledToolGroups` get all tools (existing behavior)

### Negative

- Requires maintaining an explicit list of tool names per domain (fragile if tool names change)
- `allowedTools` wildcard behavior with prefixes is not fully documented in the SDK — may need testing
- Tool filtering is advisory, not a hard security boundary — agents can still attempt equivalent actions via Bash
