# Relay Outbound Awareness -- Task Breakdown

**Spec:** `specs/relay-outbound-awareness/02-specification.md`
**Generated:** 2026-03-24
**Mode:** Full decomposition

---

## Summary

10 tasks across 4 phases. Enables agents to proactively send messages to users on Telegram, Slack, and other platforms via bound adapters -- zero discovery fumbling, zero chat-ID guessing.

| Phase | Name       | Tasks | Parallel?         |
| ----- | ---------- | ----- | ----------------- |
| 1     | Foundation | 2     | Yes (1.1 and 1.2) |
| 2     | Core       | 2     | Yes (2.1 and 2.2) |
| 3     | Tools      | 2     | Yes (3.1 and 3.2) |
| 4     | Testing    | 4     | Yes (all four)    |

---

## Phase 1: Foundation

### 1.1 -- Add BindingRouter public getters for session map access

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Add `getSessionsByBinding(bindingId)` and `getAllSessions()` methods to `BindingRouter` class. These expose the private session map as read-only copies, enabling the context block and MCP tools to discover active chat sessions.

**Files:**

- `apps/server/src/services/relay/binding-router.ts`

**Key details:**

- Returns new arrays (copies), not references to internal state
- Session map keys follow format `{bindingId}:{context}:{chatId}`
- `chatId` parsing uses `parts.slice(2).join(':')` for chat IDs containing colons

---

### 1.2 -- Wire McpToolDeps with bindingRouter and expand buildSystemPromptAppend signature

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Plumbing task that touches 5 files to thread dependencies through the system:

1. Add `bindingRouter` to `McpToolDeps` interface
2. Construct it in `index.ts` from `adapterManager.getBindingRouter()`
3. Register new tool names in `BINDING_TOOLS` array
4. Add `RelayContextDeps` interface to context-builder
5. Expand `buildSystemPromptAppend` signature with 4th parameter
6. Thread relay deps through `MessageSenderOpts` to the call site

**Files:**

- `apps/server/src/services/runtimes/claude-code/mcp-tools/types.ts`
- `apps/server/src/index.ts`
- `apps/server/src/services/runtimes/claude-code/tool-filter.ts`
- `apps/server/src/services/runtimes/claude-code/context-builder.ts`
- `apps/server/src/services/runtimes/claude-code/message-sender.ts`

---

## Phase 2: Core

### 2.1 -- Fix auto-forward instruction and subject convention text

**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.2

Two text fixes in `context-builder.ts` constants:

- **Change A:** Replace ambiguous "When YOU receive a relay message" with message-scoped rules referencing `<relay_context>` as the discriminator
- **Change B:** Add instance IDs (`{adapterId}`) to subject convention patterns, document all adapter types, reference `binding_list_sessions()` for discovery

**Files:**

- `apps/server/src/services/runtimes/claude-code/context-builder.ts` (two constants: `RELAY_TOOLS_CONTEXT` and `ADAPTER_TOOLS_CONTEXT`)

---

### 2.2 -- Implement buildRelayConnectionsBlock

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** 2.1

Replace the stub function with the full implementation that generates the `<relay_connections>` XML block injected into agent system prompts. Follows ADR-0069 dual-gate pattern. Lists bound adapters, their connection state, active chats with pre-computed relay subjects, and usage instructions.

**Files:**

- `apps/server/src/services/runtimes/claude-code/context-builder.ts`

**Token budget:** ~150-200 tokens per block for typical usage (1-2 adapters, 1-3 chats).

---

## Phase 3: Tools

### 3.1 -- Add binding_list_sessions MCP tool

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1, 1.2 | **Parallel with:** 3.2

New MCP tool in `binding-tools.ts` that exposes the session map to agents. Returns enriched session data with pre-computed relay subjects. Supports optional `bindingId` filter parameter.

**Files:**

- `apps/server/src/services/runtimes/claude-code/mcp-tools/binding-tools.ts`

---

### 3.2 -- Add relay_notify_user MCP tool

**Size:** Large | **Priority:** Medium | **Dependencies:** 1.1, 1.2 | **Parallel with:** 3.1

New convenience MCP tool in `relay-tools.ts` that lets agents send messages to users on bound external channels with automatic chat resolution. Three-tier channel matching (exact ID, partial ID, adapter type). Selects the most recently active session via LRU ordering. Six distinct error codes for actionable agent feedback.

**Files:**

- `apps/server/src/services/runtimes/claude-code/mcp-tools/relay-tools.ts`

---

## Phase 4: Testing

### 4.1 -- Unit tests: BindingRouter getters

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 4.2, 4.3, 4.4

Tests for `getSessionsByBinding` and `getAllSessions` in the existing binding-router test file. Populates session map by simulating inbound messages through the captured relay subscription handler.

**Files:**

- `apps/server/src/services/relay/__tests__/binding-router.test.ts`

---

### 4.2 -- Unit tests: buildRelayConnectionsBlock

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.2 | **Parallel with:** 4.1, 4.3, 4.4

Tests the relay connections context block generation through the public `buildSystemPromptAppend` function. Covers gating rules, agent filtering, adapter display, session subjects, and no-sessions fallback.

**Files:**

- `apps/server/src/services/runtimes/claude-code/__tests__/context-builder.test.ts` (new or extended)

---

### 4.3 -- Unit tests: binding_list_sessions tool

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.1 | **Parallel with:** 4.1, 4.2, 4.4

Tests for the handler function with mock deps. Covers enriched session responses, bindingId filtering, error states (BINDINGS_DISABLED), and graceful handling of unknown adapters.

**Files:**

- `apps/server/src/services/runtimes/claude-code/__tests__/mcp-binding-tools.test.ts` (new)

---

### 4.4 -- Unit tests: relay_notify_user tool

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.2 | **Parallel with:** 4.1, 4.2, 4.3

Tests for the handler function with full mock deps. Covers channel-less sending, channel filtering, all six error codes (RELAY_DISABLED, BINDINGS_DISABLED, MISSING_AGENT_ID, NO_BINDING, NO_ACTIVE_SESSIONS, SEND_FAILED), agent isolation, and publish call verification.

**Files:**

- `apps/server/src/services/runtimes/claude-code/__tests__/mcp-relay-notify-tools.test.ts` (new)

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 BindingRouter getters ────────┐
  1.2 Wire deps + signatures ───────┤
                                    │
Phase 2 (parallel, after P1):      │
  2.1 Text fixes ───────────────────┤ (needs 1.2)
  2.2 buildRelayConnectionsBlock ───┤ (needs 1.1 + 1.2)
                                    │
Phase 3 (parallel, after P1):      │
  3.1 binding_list_sessions ────────┤ (needs 1.1 + 1.2)
  3.2 relay_notify_user ────────────┤ (needs 1.1 + 1.2)
                                    │
Phase 4 (parallel, per-dep):       │
  4.1 BindingRouter tests ──────────┤ (needs 1.1)
  4.2 Context block tests ──────────┤ (needs 2.2)
  4.3 binding_list_sessions tests ──┤ (needs 3.1)
  4.4 relay_notify_user tests ──────┘ (needs 3.2)
```

**Critical path:** 1.1 + 1.2 (parallel) -> 2.2 -> 4.2

**Maximum parallelism:**

- Phase 1: 2 tasks in parallel
- Phases 2+3: up to 4 tasks in parallel (2.1, 2.2, 3.1, 3.2 can all start once P1 completes)
- Phase 4: all 4 tests can run in parallel once their respective implementation tasks complete
