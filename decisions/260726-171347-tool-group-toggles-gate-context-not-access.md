---
id: 260726-171347
title: Tool-group toggles gate context, not access
status: accepted
created: 2026-07-26
spec: null
supersedes: 70
superseded-by: null
---

# 260726-171347. Tool-group toggles gate context, not access

## Status

Accepted (2026-07-26, DOR-519). Supersedes ADR-0070 (Per-Agent Tool Filtering via
Domain-Level allowedTools).

## Context

A person can turn four groups of DorkOS MCP tools on or off, per agent via
`enabledToolGroups` on the agent manifest and globally via `agentContext.*Tools`
in config: Scheduling, Messaging, Agent Discovery, External Channels.

ADR-0070 chose to implement those toggles as real access control, using the Agent
SDK's `allowedTools` option to restrict a session's tool set. That premise was
false from the first commit. `allowedTools` is an auto-approval list, not a
restriction, so the implementation did the reverse of what it claimed: turning a
group OFF handed the SDK a 31- to 35-name list whose members then skipped the
approval prompt entirely. DOR-519 deleted that wiring. ADR-0070 carries the full
post-mortem and is superseded by this ADR.

Deleting the wiring left the toggles doing exactly one thing, which is what option
3 of ADR-0070's original three ("context-only gating with no MCP filtering") always
described. That behavior has been what DorkOS actually does since 2026-03-04, but
it survived only as a rejected option inside a dead ADR plus a section of
`contributing/architecture.md`. This ADR is that missing record. It changes no
code.

## Decision

**Tool-group toggles control what an agent is told about, not what it can call.**

Concretely:

1. `resolveToolConfig()` merges the agent manifest, global config, and feature
   flags into a `ResolvedToolConfig`
   (`runtimes/claude-code/tooling/tool-filter.ts`).
2. `buildSystemPromptAppend()` reads that config and leaves a disabled group's
   tool documentation out of the agent's system prompt
   (`runtimes/claude-code/messaging/context-builder.ts`).
3. That is the entire mechanism. Every DorkOS MCP tool stays registered on the
   session's server whatever the toggles say. An agent that names a tool from a
   disabled group still reaches it.

**There is no hard filter, and this is not a security boundary.** Nothing sets
`allowedTools`, `disallowedTools`, or `tools`. The toggles are guidance: they shape
what the agent thinks is available, which is genuinely useful for steering an agent
and for keeping context small, and they are worth nothing against an agent that
decides otherwise.

**Enforcement of consequence lives in the tier gate, not in the toggles.** Every
capability and every hand-registered MCP tool declares a tier: `observe`, `act`, or
`destructive`. `destructive` calls do not run without an approval a person granted,
bound to the capability id and a hash of the exact input. That gate lives inside
`registry.invoke` for registry capabilities (DOR-467) and inside
`gateHandRegisteredMcpTools` / `gatedToolRegistrar` for the 47 hand-registered
tools (DOR-468), which is to say below every caller rather than beside one of them.
See `contributing/agent-operator-surface.md`.

The two layers are independent by construction, and DOR-519 is the evidence. The
`allowedTools` lists contained both of the `destructive` tools that a tool group can
carry, `tasks_delete` and `mesh_unregister`, for three months. Neither was ever
exposed, because `allowedTools` only decides whether the SDK asks before invoking a
tool and cannot reach inside the handler where the tier gate sits. (The third
destructive action, the `marketplace.uninstall` capability, is not in any tool group
and was never in those lists. Three in total, declared across two tables:
`mcp-tool-tiers.ts` and `defineCapability`.)

**A toggle must never be load-bearing for safety.** `enabledToolGroups` and
`agentContext.*Tools` are agent-writable through `config_patch`. That is acceptable
precisely because they gate documentation. Any future change that gives these
toggles real teeth must first move them to `operator-only` in
`config-write-policy.ts`, or an agent can widen its own permissions by editing its
own config. This is the trap ADR-0070 fell into.

## Consequences

### Positive

- The record matches the code. The current behavior is an accepted decision rather
  than a rejected option inside a deprecated ADR.
- One clear answer to "where is this enforced?": the tier gate. Reviewers and docs
  stop treating the toggles as a control they are not.
- Documentation and enforcement can evolve separately. Adding a tool to an
  always-on group is a display change with no security review attached, because it
  cannot widen anything.
- The agent-writable classification of `agentContext.*Tools` is correct and stays
  correct, with the condition on changing it written down.

### Negative

- A person reading "turn off Agent Discovery" may reasonably expect the tools to be
  gone. They are not. The cockpit copy carries that honesty burden, and this ADR
  does not by itself fix any screen that reads otherwise.
- There is still no way to take a tool away from an agent. Some deployments will
  want one.
- Keeping the module named `tool-filter.ts` when it filters nothing is a mild lie
  of the kind this repo dislikes. It is kept deliberately: the registration-time
  work below is expected to land in that file.

### Follow-up

Restricting real access means leaving a disabled group's tools out at MCP
registration time, so the session's server never offers them. That is the shape to
build if DorkOS ever wants a hard per-agent tool boundary. Reaching for
`disallowedTools` instead looks shorter and is worse: it re-centralizes the same
fragile list of tool names in a second SDK option, which is the failure mode
ADR-0070 already paid for. No ticket is open; this is a note for whoever needs it.

### Amendment, 2026-08-28 (DOR-1611)

The Follow-up above now has an answer, and it is not the one it proposed.

ADR `260828-123331` builds the hard per-agent boundary at **invoke time**, inside
`registry.invoke`, rather than by leaving a group's tools out at MCP registration
time. Registration-time omission was the right instinct and the wrong seam: the
external `/mcp` server is stateless and builds its tool list per request with no
per-agent session to omit anything from, so a registration-time filter would have
protected the in-session server and left the other door open. Enforcement inside
`invoke` reaches both, because both converge on it.

**This ADR is otherwise unchanged and still exactly right.** The four keys named
here — `tasks`, `relay`, `mesh`, `adapter` — still shape context and nothing else,
and no edit to `mcp-tool-groups.ts` can make one of them a boundary. What changed
is that one NEW key beside them, `roomsManage`, is a different kind of thing: a
per-agent grant the choke point enforces, absent means off with no global default,
and the agent-reachable manifest write path refuses to set it. If you are reasoning
about the four, read this ADR. If you are adding a fifth, read that one first — it
records the condition on agent-writable grants that makes the difference real.
