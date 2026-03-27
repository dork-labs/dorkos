---
number: 51
title: Inject Agent Persona via Context Builder System Prompt
status: proposed
created: 2026-02-26
spec: agents-first-class-entity
superseded-by: null
---

# 51. Inject Agent Persona via Context Builder System Prompt

## Status

Proposed

## Context

DorkOS agents need a mechanism to influence Claude's behavior per-project. The `context-builder.ts` already injects runtime context (`<env>`, `<git_status>`) into the SDK's `systemPrompt.append`. Industry patterns (CrewAI's role+goal+backstory, GitHub Copilot's agent instructions, OpenCode's markdown frontmatter) show that system-prompt-level persona injection is the standard approach for agent customization.

## Decision

Add a `buildAgentBlock(cwd)` function to `context-builder.ts` that reads `.dork/agent.json` and injects two XML blocks: `<agent_identity>` (always, when manifest exists) containing name, ID, description, and capabilities; and `<agent_persona>` (only when `personaEnabled` is true and `persona` is non-empty) containing the user-authored persona text. A `personaEnabled` boolean field (default true) on the manifest gives users control.

## Consequences

### Positive

- Agents meaningfully differ from plain directories — Claude "knows" its identity and role
- Follows established CrewAI/Copilot patterns for agent customization
- Per-agent toggle (`personaEnabled`) gives users granular control
- Zero-cost for unregistered directories (readManifest returns null immediately)

### Negative

- Adds one filesystem read to session creation (runs in parallel via Promise.allSettled, negligible latency)
- Persona text is unconstrained natural language (max 4000 chars) — users could write conflicting or harmful instructions
- System prompt grows longer with agent context, consuming more input tokens
