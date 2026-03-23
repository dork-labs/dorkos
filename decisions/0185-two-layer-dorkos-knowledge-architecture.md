---
number: 185
title: Two-Layer DorkOS Knowledge Architecture (System Prompt + CLAUDE.md)
status: draft
created: 2026-03-23
spec: agent-creation-and-templates
superseded-by: null
---

# 0185. Two-Layer DorkOS Knowledge Architecture (System Prompt + CLAUDE.md)

## Status

Draft (auto-extracted from spec: agent-creation-and-templates)

## Context

Agents running through DorkOS need to understand DorkOS concepts (Pulse, Relay, Mesh, Console) to respond intelligently to requests like "schedule this every 6 hours" or "send a message to my other agent." The question is where this knowledge lives. CLAUDE.md is user-editable — putting DorkOS knowledge there creates mixed ownership and fragility. But CLAUDE.md is the only mechanism that works when users run `claude` directly in an agent's directory outside the DorkOS runtime.

## Decision

Use a two-layer architecture: (1) **System prompt injection** as the primary mechanism — a new `dorkosKnowledge` convention toggle (default ON for all agents) injects a `<dorkos_context>` block into the system prompt, following the same pattern as SOUL.md/NOPE.md injection. This is durable, ships with the server, can't be accidentally deleted, and stays current with upgrades. (2) **Compact CLAUDE.md** (~15 lines) as a CLI fallback for DorkBot only — provides agent identity and llms.txt URL for when users run Claude Code outside the DorkOS runtime.

## Consequences

### Positive

- CLAUDE.md remains the user's space — they can edit freely without losing DorkOS knowledge
- Works for ALL agents, not just DorkBot — any agent can understand DorkOS commands
- Knowledge updates automatically with server upgrades
- Follows established convention file injection pattern (SOUL.md, NOPE.md)

### Negative

- System prompt injection only works through DorkOS runtime, not direct CLI usage
- Two mechanisms to maintain and explain to users
- DorkBot's CLAUDE.md content may drift from the injected system prompt content
