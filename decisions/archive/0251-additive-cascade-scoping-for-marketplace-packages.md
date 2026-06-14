---
number: 251
title: Additive Cascade Scoping for Marketplace Packages
status: draft
created: 2026-04-13
spec: marketplace-scoped-installs
superseded-by: null
---

# 251. Additive Cascade Scoping for Marketplace Packages

## Status

Draft (auto-extracted from spec: marketplace-scoped-installs)

## Context

Marketplace packages (plugins, skill-packs, adapters) currently install only to the global `~/.dork/plugins/` directory and are available to all agents indiscriminately. Users need per-agent control — some agents should have skills others don't. Research into npm, VS Code, mise/asdf, Codex CLI, and Obsidian identified two viable models: full isolation (each agent has its own package set, no sharing) and additive cascade (global packages inherited by all, agent-local packages supplement or override).

## Decision

Use an additive cascade model: global packages are automatically available to all agents, and agent-local packages supplement the global set. When the same package name exists at both scopes, the agent-local version wins. Agent-local packages are stored at `{agent.projectPath}/.dork/plugins/<pkg>/`, following the convention established by `.dork/extensions/` in the extension discovery system.

## Consequences

### Positive

- No redundant installs — common packages installed once globally, available everywhere
- Agent-specific customization without affecting other agents
- Follows the same global+local pattern as extension discovery (`extension-discovery.ts`)
- Path-agnostic — works for agents in `~/.dork/agents/`, `~/projects/`, or anywhere else

### Negative

- Users must understand the two-scope model to reason about which version of a package an agent sees
- The scanner must read two directories per request when `projectPath` is provided (minor perf cost)
- Override semantics (local silently wins) may surprise users who don't notice the scope badge
