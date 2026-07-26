---
id: 260726-022251
title: An in-session agent's identity comes from its working directory, not a presented token
status: accepted
created: 2026-07-26
spec: agent-trust
superseded-by: null
---

# 260726-022251. An in-session agent's identity comes from its working directory, not a presented token

## Status

Accepted. Written after the fact on 2026-07-26; the decision was made in code during DOR-447.

## Context

Agent identity is delivered as a bearer token: the runtime env seam puts `DORKOS_AGENT_TOKEN` into a spawned session's process env, and surfaces that receive it over the wire resolve it through an `X-DorkOS-Agent` header. That works for the CLI, the HTTP API, and the external MCP server, because in every one of those a caller arrives from outside and has to say who it is.

The in-session `dorkos` MCP server is not that. Its tools run in process, invoked by the agent from inside its own session: there is no HTTP request, no header, and no round trip on which to present anything. Requiring the token here would have meant reading the same env var the session was spawned with and treating it as a credential presented to ourselves, which proves nothing that was not already known.

The caller is instead structurally known. There is exactly one agent whose session this is, and the server instance was built for it.

## Decision

We will derive in-session identity from the session's working directory. `createInSessionContextResolver(agentPath)` (`apps/server/src/services/core/agent-identity/agent-token-env.ts:85-111`) looks the directory up through `describeAgent()` and returns the resulting `CapabilityInvocationContext`. This is the same reasoning Relay already used for `resolveSenderIdentity` (`apps/server/src/services/runtimes/claude-code/mcp-tools/relay-helpers.ts:51`), so the codebase has one story for "the caller is structurally known" rather than two.

Because no secret is presented, this path reads the agent's recorded row directly and is deliberately exempt from token expiry: `describeAgent` does not enforce the idle and absolute clocks that `resolve` does, since a stale clock would silently turn OFF an in-session agent's `tierCeiling` rather than restrict it (ADR 260726-022250). Revocation still applies.

The lookup is memoized for the life of the server instance, which is one per SDK query, so a session making twenty tool calls performs one indexed read. Every failure path resolves to `undefined`, leaving the call unattributed exactly as before identity existed: attribution is a side channel and must never fail an agent's tool call.

The token keeps riding process env rather than the context-builder's prompt block, so it never enters the model's context or the session transcript. It is a credential for the commands the agent runs, not information for the model to read.

## Consequences

### Positive

- In-session tools are attributed with no credential handling at all, and no way for the model to read, log, or leak an identity secret it was never given.
- One read per session instead of one per tool call.
- The reasoning matches Relay's existing sender identity, so a reader meets the same idea twice rather than two competing ones.
- Identity is never load-bearing for availability: everything degrades to unattributed, which is the pre-identity behavior.

### Negative

- **Identity here is an assertion about the process, not a proof.** Anything running in that session's working directory is that agent as far as this path is concerned. That is sound only because in-process code is already inside the trust boundary; it is not a credential check and must not be cited as one.
- A session whose working directory hosts no registered agent is silently unattributed. That is intended, but it means missing attribution has two indistinguishable causes: no agent there, or a lookup that failed.
- The expiry carve-out means one agent can be expired on the bearer path and current in session at the same moment. Both are correct for what they protect, but the asymmetry is real and will surprise anyone who assumes one identity model.
- Memoization is per server instance, so an agent's `tierCeiling` changed mid-session is not seen until the next session. Tightening a ceiling therefore does not take effect immediately on a running agent.
