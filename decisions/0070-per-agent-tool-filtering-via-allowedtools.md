---
number: 70
title: Per-Agent Tool Filtering via Domain-Level allowedTools
status: superseded
created: 2026-03-04
spec: agent-tools-elevation
superseded-by: '260726-171347'
---

# 70. Per-Agent Tool Filtering via Domain-Level allowedTools

## Status

Superseded (2026-07-26, DOR-519) by ADR-260726-171347 (Tool-group toggles gate
context, not access). The mechanism decided here was removed; see the amendments
under Decision for what was wrong with it and what the removal did. What DorkOS
does today is option 3 from the Context below, context-only gating, and that is now
recorded as an accepted decision in its own right rather than surviving only as a
rejected option inside a dead ADR.

Every bullet under Consequences was written for the mechanism this ADR chose. Two
of them are false and are struck through in place, because an ADR is a record of
what was believed, not a page to be quietly corrected.

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
> **How bad it was.** `buildAllowedTools()` returned `undefined` when every group was on, so nothing reached the SDK and all DorkOS tools went through `canUseTool`, which auto-approves only the 13 names in `DORKOS_AGENT_TOOLS`. Turn a single group off and it returned between 31 and 35 names, depending which one (35 with Scheduling off, that group being the smallest), and every name in the list then skipped the approval prompt. `binding_delete`, which deletes a chat route, and `relay_disable_adapter`, which switches off a connected channel such as Slack or Telegram, are representative of what that exposed. The toggle ran backwards: turning protection off widened auto-approval. And because `config-write-policy.ts` classifies the `agentContext.*Tools` fields as `agent-writable` while defining `operator-only` as "changing it removes or widens a security control", an agent could call `config_patch` with `relayTools: false` and widen its own auto-approval, globally. Deleting the wiring makes that misclassification harmless without touching the policy table.
>
> **What the tier gate held, and why that matters.** The list also carried both of the tools that `services/core/mcp-tool-tiers.ts` classes as `destructive` (`tasks_delete` and `mesh_unregister`), and neither was ever actually exposed by this bug. (Those are the only two in that table, not the only two destructive actions in DorkOS: `marketplace.uninstall` is a `destructive` capability declared on the registry instead, and no tool group ever carried it. The whole set is declared across two tables, and the registry side has grown since — `operator.update_agent_boundaries` joined it in DOR-1698. DOR-509 corrected prose that conflated the two counts.) `allowedTools` only decides whether the SDK asks a person before invoking a tool; it cannot reach inside the tool. Both destructive tools are gated a layer below that, in the handler itself: `handRegisteredInSessionTools` wraps the in-session tool array in `gateHandRegisteredMcpTools` (`runtimes/claude-code/mcp-tools/index.ts`), and that wrapper runs `runGate` and returns `approval_required` before the real handler is ever called. The gate is DOR-468 (`1789f958f`), an ancestor of this fix's base commit, and `services/core/__tests__/mcp-tool-gate.test.ts` asserts that in-session `tasks_delete` and `mesh_unregister` both refuse with nothing run, identified and anonymous alike.
>
> So the blast radius was the `act` and `observe` tools in the list, not the two that destroy a person's data. The list held 29 to 34 of them; 7 to 13 already auto-approved through `canUseTool` regardless of any toggle, so the prompts the toggle actually silenced numbered 16 to 24. This is recorded here as a strengthening of the record, not a softening of it: the first layer failed for three months, the second layer caught exactly what it was built to catch, and that is the argument for keeping enforcement of consequence in the tier gate rather than in a list of names passed to an SDK option. The earlier drafts of this amendment, the changelog fragment, and the `contributing/` prose all led with `tasks_delete` and `mesh_unregister` as the examples. That was wrong in the direction that overstates our own exposure, which is its own kind of dishonest, and it obscured the one part of the system that worked.
>
> **Only claude-code was ever affected.** `supportsMcp` is true for claude-code alone (`runtime-constants.ts`); codex, opencode, and test-mode cannot receive DorkOS MCP tools. None of this was persisted in SQLite, so no migration was needed.
>
> **What survives.** The `enabledToolGroups` field, the cockpit's toggles, and `resolveToolConfig()` all stay, because the second half of the original dual gating is real: `buildSystemPromptAppend` still leaves a disabled group's tool block out of the agent's context, so the agent is not told those tools exist. That is guidance, not a boundary, and the "Dual gating" line under Positive below is now wrong on its first half.
>
> **What is still open.** Taking real access away means leaving a disabled group's tools out at MCP registration time. `disallowedTools` looks like the shorter route and is worse: it re-centralises the same list-of-names fragility in a second SDK option, and the Negative consequence about maintaining explicit name lists applies to it in full.

## Consequences

### Positive

- ~~Uses the SDK's intended mechanism for per-session tool access control~~
  **False (DOR-519).** `allowedTools` is not an access-control mechanism and never
  was. It is an auto-approval list. The SDK's intended mechanism for removing an MCP
  tool is `disallowedTools`, which this ADR did not use.
- No dynamic server creation — avoids resource leak risks and complexity
- ~~Dual gating (allowedTools + context block omission) ensures tools and context stay in sync~~
  **Half false (DOR-519).** There was never dual gating. The context-block omission
  is real and survives; the `allowedTools` half gated nothing, so tools and context
  were never in sync. Disabling a group left every tool callable while hiding its
  documentation.
- Backward-compatible: agents without `enabledToolGroups` get all tools (existing behavior)

### Negative

- Requires maintaining an explicit list of tool names per domain (fragile if tool names change)
- `allowedTools` wildcard behavior with prefixes is not fully documented in the SDK — may need testing
  (**Never actioned, and it would not have helped:** no wildcard syntax turns an
  auto-approval list into a restriction. See the DOR-519 amendment.)
- Tool filtering is advisory, not a hard security boundary — agents can still attempt equivalent actions via Bash
  (**Understated.** There was no filtering at all, advisory or otherwise. What is
  advisory is the context omission. The hard boundary lives in the tier gate,
  `services/core/mcp-tool-gate.ts`, not here.)
