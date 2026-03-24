---
slug: relay-outbound-awareness
number: 175
created: 2026-03-24
status: ideation
---

# Relay Outbound Awareness — Agent-Initiated Messaging

**Slug:** relay-outbound-awareness
**Author:** Claude Code
**Date:** 2026-03-24
**Branch:** preflight/relay-outbound-awareness

---

## 1) Intent & Assumptions

- **Task brief:** When a user says "message me on Telegram" from any client (console, Obsidian, web UI), the agent should immediately know which adapters are bound to it, which chats are active, and how to send — with zero discovery tool calls and zero questions. Currently agents fumble through 5+ tool calls and still fail, or silently respond to the wrong channel.
- **Assumptions:**
  - The existing relay/adapter/binding infrastructure is sound; the gap is purely in agent awareness and tooling
  - The `BindingRouter.sessionMap` is the authoritative source of active chat-to-session mappings
  - The `context-builder.ts` pattern of XML context blocks is the right mechanism for ambient awareness
  - agentId is available (or can be made available) at the point where `buildSystemPromptAppend()` is called
- **Out of scope:**
  - New adapter types or changes to inbound message flow
  - UI changes to the binding configuration panel
  - Changes to the Telegram adapter's polling/webhook/outbound logic
  - Multi-user chat routing heuristics (this feature assumes single-user-per-agent for now)

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/context-builder.ts`: System prompt builder. Contains `RELAY_TOOLS_CONTEXT` (lines 21-73), `ADAPTER_TOOLS_CONTEXT` (96-114), `buildSystemPromptAppend()` (231-260). The auto-forward instruction at line 64-66 is ambiguous. The `ADAPTER_TOOLS_CONTEXT` subject convention at line 100 omits instance IDs.
- `apps/server/src/services/relay/binding-router.ts`: Owns the `sessionMap` (line 64) with `{bindingId}:chat:{chatId}` → sessionId entries. Fully private — no public getter exists. Has `parseSubject()` (299-330) for extracting adapterId/chatId from subjects.
- `apps/server/src/services/relay/binding-store.ts`: CRUD for bindings. `getAll()`, `getByAdapterId()`, `resolve()`. `AdapterBinding` includes adapterId, agentId, chatId?, channelType?, sessionStrategy.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts`: Three tools: `binding_list`, `binding_create`, `binding_delete`. Pattern: handler factory `createXHandler(deps)` + tool registration in `getBindingTools(deps)`.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`: `McpToolDeps` interface. Has `bindingStore?` and `adapterManager?` but NOT `bindingRouter`.
- `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts`: Composition root. `createDorkOsToolServer(deps)` assembles all tools.
- `apps/server/src/services/runtimes/claude-code/tool-filter.ts`: `BINDING_TOOLS` constant (lines 85-89) and `buildAllowedTools()` logic. New tool names must be registered here.
- `packages/relay/src/lib/thread-id.ts`: `TelegramThreadIdCodec` with instance-ID-aware prefixes. Subject format: `relay.human.telegram.{instanceId}.{chatId}`.
- `packages/relay/src/adapters/claude-code/agent-handler.ts`: `formatPromptWithContext()` (367-394) builds the `<relay_context>` XML block injected into relay-routed messages.
- `apps/server/src/services/relay/adapter-manager.ts`: `AdapterManager` lifecycle management. `initBindingSubsystem()` creates BindingStore + BindingRouter.
- `contributing/architecture.md`: BindingRouter section (864-880), session persistence patterns.
- `apps/server/src/services/core/__tests__/mcp-binding-tools.test.ts`: Test pattern for MCP tools — mock `McpToolDeps`, call handler directly, assert JSON response.
- `apps/server/src/services/core/__tests__/context-builder.test.ts`: Test pattern for context blocks — mock dependencies, call `buildSystemPromptAppend()`, assert string contains expected XML.

## 3) Codebase Map

- **Primary components/modules:**
  - `context-builder.ts` — System prompt XML block builder (text fixes + new block)
  - `binding-router.ts` — Session map owner (expose via public getter)
  - `binding-tools.ts` — MCP tool handlers for bindings (add `binding_list_sessions`)
  - `relay-tools.ts` — MCP tool handlers for relay ops (add `relay_notify_user`)
  - `mcp-tools/types.ts` — `McpToolDeps` interface (add `bindingRouter`)
  - `mcp-tools/index.ts` — Tool composition root (wire new tools)
  - `tool-filter.ts` — Tool name constants + filtering logic (register new tool names)

- **Shared dependencies:**
  - `@dorkos/shared/relay-schemas` — `AdapterBinding` type, `RelayEnvelope`
  - `@dorkos/shared/agent-runtime` — `AgentRegistryPort`
  - `packages/relay/src/lib/thread-id.ts` — Subject codec (reference, not modified)
  - `apps/server/src/services/relay/relay-state.ts` — `isRelayEnabled()` feature flag

- **Data flow:**

  ```
  Agent session starts
    → buildSystemPromptAppend(cwd, meshCore, toolConfig, relayContext)
    → new buildRelayConnectionsBlock(relayContext)
    → queries bindingStore.getAll() for agent's bindings
    → queries bindingRouter.getSessionsByBinding() for active chats
    → queries adapterManager.listAdapters() for connection status
    → produces <relay_connections> XML block
    → agent sees bound adapters + active chat subjects in system prompt
    → agent can relay_send() without discovery OR use relay_notify_user() for convenience
  ```

- **Feature flags/config:**
  - `isRelayEnabled()` gates all relay context blocks
  - `configManager.get('agentContext').adapterTools` toggles adapter context
  - `tool-filter.ts` `ResolvedToolConfig.adapter` gates new tools per-agent

- **Potential blast radius:**
  - Direct: 7 files modified (context-builder, binding-router, binding-tools, relay-tools, types, index, tool-filter)
  - Indirect: Call sites of `buildSystemPromptAppend()` need the new `relayContext` param threaded
  - Tests: 2 existing test files need updates + new test coverage for new functions

## 4) Root Cause Analysis

N/A — This is a feature enhancement, not a bug fix.

However, the two transcripts that motivated this feature reveal two distinct failure modes:

**Transcript 1 (05da5015)** — Agent couldn't discover chat ID. Root cause: no MCP tool exposes the session map. `binding_list` returns bindings without active sessions. `relay_list_endpoints` only shows registered endpoints (not adapter chats). The data existed in `binding-router.ts:sessionMap` but was completely inaccessible.

**Transcript 2 (79accd91)** — Agent responded to console instead of Telegram. Root cause: ambiguous instruction in `RELAY_TOOLS_CONTEXT` line 64: "When YOU receive a relay message, respond naturally." Agent interpreted "you" as "this session" (which had prior Telegram messages) rather than "the current message." The current message had no `<relay_context>` (it came from console), but the agent didn't check.

## 5) Research

Research report saved to `research/20260324_relay_outbound_awareness.md`.

### Potential Solutions

**1. Dynamic `<relay_connections>` Context Block**

- Description: Extend `context-builder.ts` to build a `<relay_connections>` XML block at session start. Fetches live binding/session data for the current agentId — includes pre-computed reply subjects, human-readable channel labels, and a relay_send example template.
- Pros: Zero agent tool calls for >95% of cases; direct extension of existing `<peer_agents>` pattern; ~150-200 tokens
- Cons: Session-scoped (stale for long-lived sessions if new chats start); requires wiring agentId + bindingRouter into context-builder
- Complexity: Medium
- Maintenance: Low

**2. `relay_notify_user` High-Level MCP Tool**

- Description: A new `relay_notify_user(message, channel?)` tool that abstracts the entire outbound flow. Internally resolves the best active chat, calls `relay_send()`, returns confirmation.
- Pros: Handles edge cases (sessions created after context block was built); 1 tool call replaces the 5+ fumble sequence; self-describing name matches user intent language
- Cons: Hides routing decision from agent; adds a 4th relay send variant
- Complexity: Medium
- Maintenance: Medium

**3. `binding_list_sessions` Discovery Tool**

- Description: A new MCP tool that exposes the session map from BindingRouter. Returns active chats with pre-computed subjects per binding.
- Pros: Composable — agent uses existing relay_send; transparent; always live data
- Cons: Requires 2 tool calls (discover + send) vs 1 for relay_notify_user; alone doesn't solve the "agent should just know" problem
- Complexity: Low
- Maintenance: Low

**4. Enhanced `relay_list_endpoints` with Session Metadata**

- Description: Extend existing tool to return adapter type, chatId, last activity.
- Pros: No new tool; always live
- Cons: Still requires discovery tool call; breaks single-responsibility
- Complexity: Low
- Maintenance: Low

**5. CLAUDE.md Contact Book File**

- Description: Write `.dork/contact-book.md` per agent, listing bound channels.
- Pros: User-visible/editable
- Cons: Stale by definition; requires file-write trigger; unreliable for conditional instructions
- Complexity: High
- Maintenance: High

### Recommendation

**Recommended approach:** Solutions 1 + 2 + 3 combined — `<relay_connections>` context block + `relay_notify_user` high-level tool + `binding_list_sessions` discovery tool.

The context block handles the >95% happy path with zero tool calls. The `relay_notify_user` tool provides one-call convenience for the intent "message me on X". The `binding_list_sessions` tool provides transparent discovery when the agent needs to reason about available channels. This layered approach matches the industry pattern (Salesforce Agentforce, OpenClaw) where the routing layer pre-injects the reply channel AND provides explicit tools for edge cases.

Combined with text fixes to the auto-forward instruction and subject convention docs, this eliminates both transcript failure modes completely.

## 6) Decisions

| #   | Decision               | Choice                                                     | Rationale                                                                                                                                                                                                   |
| --- | ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tool strategy          | Both tools (`binding_list_sessions` + `relay_notify_user`) | Maximum flexibility. Discovery tool for transparency (Kai wants to see what happens), high-level tool for convenience (Priya wants zero friction). Context block handles >95% of cases anyway.              |
| 2   | Context block richness | Full with examples (~150-200 tokens)                       | Lists adapters, active chats with subjects, AND a relay_send template. Follows existing `<peer_agents>` pattern which includes inline "To contact a peer..." guidance. Agent can copy the subject directly. |
| 3   | Dependency threading   | Expand signature with optional `relayContext?` param       | Follows the existing pattern where `meshCore` is an optional param. Caller passes when available, function degrades gracefully when absent. No breaking changes to existing call sites.                     |
