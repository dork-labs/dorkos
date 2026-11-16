---
slug: agent-tool-context-injection
number: 88
created: 2026-03-03
status: ideation
---

# Agent Tool Context Injection

**Slug:** agent-tool-context-injection
**Author:** Claude Code
**Date:** 2026-03-03
**Branch:** preflight/agent-tool-context-injection

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS provides 28 MCP tools to agents across relay, mesh, adapter, binding, and trace domains — but agents receive zero instructions on _how_ to use them. No subject hierarchy docs, no workflow examples, no routing conventions. We need to inject `<relay_tools>`, `<mesh_tools>`, and `<adapter_tools>` context blocks into the system prompt with usage instructions, and add configurable settings so power users can see and control what context their agents receive.
- **Assumptions:**
  - `context-builder.ts` is the correct injection point (extends existing `<env>`, `<git_status>`, `<agent_identity>` pattern)
  - Static string blocks are sufficient — relay subjects and mesh workflows don't change at runtime
  - ~600-1000 tokens total overhead is negligible against Claude's 200K context window
  - Settings should be independent from feature flags (you can have relay enabled but suppress the context block)
  - The Agent SDK's `systemPrompt.append` concatenates after all preset content
- **Out of scope:**
  - Custom user-provided context blocks (future extension — users adding their own `<custom>` blocks)
  - Changes to MCP tool `tool()` description strings
  - New MCP tools
  - Pulse tool context (separate concern, lower priority)
  - Dynamic/per-session context (live agent lists, current endpoints)

## 2) Pre-reading Log

- `apps/server/src/services/core/context-builder.ts`: Builds `<env>`, `<git_status>`, `<agent_identity>`, `<agent_persona>` blocks via `Promise.allSettled()`. Never throws. Returns joined string for `systemPrompt.append`.
- `apps/server/src/services/core/mcp-tools/index.ts`: Composition root for all 28 MCP tools. Factory `createDorkOsToolServer(deps)` accepts `McpToolDeps` with optional services.
- `apps/server/src/services/core/mcp-tools/relay-tools.ts`: 4 tools — `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`. Guarded by `requireRelay()`.
- `apps/server/src/services/core/mcp-tools/mesh-tools.ts`: 8 tools — discover, register, list, deny, unregister, status, inspect, query_topology. Guarded by `requireMesh()`.
- `apps/server/src/services/core/mcp-tools/adapter-tools.ts`: 4 tools — list, enable, disable, reload adapters. Only registered when `adapterManager` provided.
- `apps/server/src/services/core/mcp-tools/binding-tools.ts`: 3 tools — list, create, delete bindings. Only registered when `bindingStore` provided.
- `apps/server/src/services/core/mcp-tools/trace-tools.ts`: 2 tools — get_trace, get_metrics.
- `apps/server/src/services/core/agent-manager.ts`: Calls `buildSystemPromptAppend(cwd)` and passes result to SDK `query()` as `systemPrompt: { type: 'preset', preset: 'claude_code', append }`. MCP servers injected via `setMcpServerFactory()`.
- `packages/shared/src/config-schema.ts`: Zod-validated config schema with sections for server, tunnel, ui, logging, relay, scheduler, mesh, onboarding. Config persisted to `~/.dork/config.json`.
- `apps/server/src/services/config-manager.ts`: Singleton `ConfigManager` with `get()`, `set()`, `getDot()`, `setDot()`. Validates with Zod before writes.
- `apps/server/src/routes/config.ts`: GET returns full config + feature flags; PATCH deep-merges with validation.
- `packages/relay/src/adapters/claude-code-adapter.ts`: Injects `<relay_context>` block when messages arrive via relay. Precedent for XML context injection into agent sessions.
- `apps/client/src/layers/features/agent-settings/`: Agent settings dialog with Identity, Persona, Capabilities, Connections tabs. Natural home for a new "Context" tab.
- `research/20260303_agent_tool_context_injection.md`: Full research report with token budgets, XML patterns, content templates, and implementation recommendations.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/core/context-builder.ts` — Context block generation, system prompt append
- `apps/server/src/services/core/agent-manager.ts` — Session orchestration, calls context builder
- `packages/shared/src/config-schema.ts` — UserConfig Zod schema
- `apps/server/src/services/config-manager.ts` — Config persistence and validation
- `apps/server/src/routes/config.ts` — Config REST API
- `apps/client/src/layers/features/agent-settings/` — Agent settings dialog UI

**Shared Dependencies:**

- `apps/server/src/services/relay/relay-state.ts` — `isRelayEnabled()` feature flag
- `apps/server/src/services/mesh/mesh-state.ts` — Mesh state holder (always-on)
- `apps/server/src/services/core/mcp-tools/types.ts` — `McpToolDeps` interface

**Data Flow:**
Config settings (config.json) → context-builder reads config → builds XML blocks → agent-manager passes to SDK `systemPrompt.append` → Agent receives blocks in system prompt → Agent uses blocks to inform tool usage

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` / `isRelayEnabled()` — Controls relay tool registration
- Mesh is always-on (no feature flag)
- New: `agentContext.relayTools`, `agentContext.meshTools`, `agentContext.adapterTools` config toggles

**Potential Blast Radius:**

- Direct: 4 files (context-builder, config-schema, agent-manager signature, agent settings UI)
- Indirect: config route (returns new section), config-manager (validates new schema)
- Tests: context-builder tests, config schema tests, agent settings component tests

## 5) Research

Full research report: `research/20260303_agent_tool_context_injection.md`

**Potential Solutions:**

1. **Static XML blocks in context-builder.ts (Recommended)** — Add `buildRelayToolsBlock()`, `buildMeshToolsBlock()`, `buildAdapterToolsBlock()` as pure functions. Wire into `buildSystemPromptAppend()` alongside existing blocks. Gate on config settings + feature availability.
   - Pros: Zero new abstractions, extends existing pattern, testable as pure functions, co-located with all context logic
   - Cons: Content updates require code changes (not user-editable)
   - Complexity: Low | Maintenance: Low

2. **AGENTS.md injection via tool instructions file** — Write `.claude/tool-instructions.md` and let SDK load it.
   - Pros: User-editable, follows AGENTS.md conventions
   - Cons: No feature-flag awareness, less precise than XML tags, users must manually maintain
   - Complexity: Low | Maintenance: Medium

3. **Self-describing tool descriptions** — Bloat `tool()` description strings with workflow guidance.
   - Pros: No new mechanism
   - Cons: Wrong layer — tool descriptions are per-tool, can't document cross-tool workflows or subject hierarchy
   - Complexity: Low | Maintenance: High (duplicated info)

**Recommendation:** Solution 1. Static XML blocks in context-builder.ts, gated by a dedicated `agentContext` config section. The blocks are ~250-350 tokens each (~0.5% of 200K window). Research shows Claude responds best to XML-tagged, numbered workflow steps with subject conventions documented first.

**Key Research Insights:**

- Tool `tool()` descriptions answer "what does this tool do?"; system prompt blocks answer "when and how to use tools together"
- Claude 4.x doesn't need aggressive `CRITICAL: YOU MUST` language — calm, direct prose works
- The relay subject hierarchy is the single most critical missing context (agents literally can't guess `relay.agent.{sessionId}`)
- Static blocks win over dynamic discovery — no chicken-and-egg problem, no per-message overhead

## 6) Decisions

| #   | Decision                 | Choice                                                           | Rationale                                                                                                                                                    |
| --- | ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Settings location        | Dedicated `agentContext` config section in `~/.dork/config.json` | Independent from feature flags — users can have relay enabled but suppress context. Exposes what we inject and gives power users control.                    |
| 2   | Scope of context blocks  | Include adapter/binding context alongside relay and mesh         | Enables the "Send me a Telegram message" use case. Adapters and bindings are closely related to relay and agents need to understand the routing conventions. |
| 3   | UI location for settings | Agent Settings dialog, new "Context" tab                         | Natural home — it's about what the agent knows. Lives alongside Identity, Persona, Capabilities, Connections.                                                |
