---
number: 239
title: Plugin Runtime Activation via Claude Agent SDK options.plugins
status: draft
created: 2026-04-07
spec: marketplace-05-claude-code-format-superset
superseded-by: null
---

# 239. Plugin Runtime Activation via Claude Agent SDK options.plugins

## Status

Draft (auto-extracted from spec: marketplace-05-claude-code-format-superset)

## Context

A Claude Code plugin includes five component types: skills, commands, agents, hooks, and MCP servers. Each has its own runtime semantics — skills are autonomously invoked by the model, commands are `/slash` entry points, agents are subagent definitions, hooks respond to lifecycle events (PreToolUse, PostToolUse, SessionStart, etc.), and MCP servers are external tool integrations. Reimplementing this runtime inside DorkOS would have doubled the scope of marketplace-05 and introduced a permanent divergence risk from CC's actual runtime semantics.

Research during ideation discovered that the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which DorkOS already uses as its primary agent runtime via `apps/server/src/services/runtimes/claude-code/`, has a `options.plugins: [{ type: "local", path }]` API that was not documented in prior February 2026 research but is confirmed in the current official docs at `platform.claude.com/docs/en/agent-sdk/plugins`. This API loads a plugin directory's skills, commands, agents, hooks, and MCP servers automatically, with plugin skills auto-namespaced as `plugin-name:skill-name`. It does not install plugins (no marketplace.json parsing, no remote fetch), but it fully handles runtime activation of plugins already on disk.

This is the architectural unlock: DorkOS's install pipeline and CC's runtime compose cleanly. DorkOS owns the install half (downloading + materializing plugins to disk via the marketplace pipeline). The Claude Agent SDK owns the runtime half (loading plugin primitives into agent sessions via `options.plugins`).

## Decision

Activate installed plugins at session start by passing their install directories to the Claude Agent SDK via `options.plugins: [{ type: "local", path: "<install_dir>" }]`. The implementation lives in `apps/server/src/services/runtimes/claude-code/plugin-activation.ts` inside the existing ESLint boundary that allows `@anthropic-ai/claude-agent-sdk` imports. At session start, `claude-code-runtime.ts` calls `buildClaudeAgentSdkPluginsArray({ dorkHome, enabledPluginNames, logger })` and passes the resulting array as `options.plugins` to `query()`.

DorkOS does NOT parse, interpret, or execute CC component fields (`commands`, `agents`, `hooks`, `mcpServers`, `lspServers`) itself. Those fields are stored as opaque metadata in the schema (`z.unknown().optional()`) and passed through to the SDK verbatim. The SDK auto-loads them when the plugin path is registered.

## Consequences

### Positive

- Zero CC runtime reimplementation — save weeks of engineering work
- Always current with CC's runtime semantics automatically (the SDK is maintained by Anthropic)
- Clean architectural split: DorkOS owns install, SDK owns runtime
- Plugin skills auto-namespace without custom logic (`code-reviewer:review-pr`, `security-auditor:audit`)
- Future SDK plugin features (new component types, new lifecycle hooks) come for free when the SDK is upgraded
- Minimal code surface — `plugin-activation.ts` is ~50 lines

### Negative

- Plugin runtime works only when the active agent runtime is the Claude Agent SDK — if DorkOS adds support for non-CC runtimes (Codex, OpenAI, etc.), each would need its own plugin activation implementation or accept that CC plugins don't run
- Breaking changes to `options.plugins` API (unlikely but possible) would require a small update to `plugin-activation.ts`
- DorkOS cannot introspect plugin component definitions at install time — we know what's in `plugin.json` but not how the SDK will interpret it
- The Claude Agent SDK version pin in `package.json` becomes load-bearing for plugin runtime correctness
