# Claude Code Adapter Audit

**Date:** 2026-03-06
**Goal:** Identify all Claude Code-specific coupling throughout the application and determine what should be routed through an adapter layer to support future multi-agent backends (OpenCode, Aider, etc.)

## Status: Complete

---

## Executive Summary

DorkOS has **two parallel paths** to Claude Code, and that's the core problem:

1. **Direct path**: `sessions.ts` → `AgentManager` → Claude SDK `query()` — used by the web UI
2. **Relay path**: `sessions.ts` → Relay bus → `ClaudeCodeAdapter` → `AgentManager` → Claude SDK `query()` — used when Relay is enabled

Both paths converge at `AgentManager`, which is a **monolithic Claude SDK wrapper** with no abstraction layer. The `ClaudeCodeAdapter` is well-designed but only covers the Relay path — it's a delivery mechanism, not the single point of contact with Claude Code.

Beyond message sending, Claude Code coupling runs deep: session storage (JSONL files at `~/.claude/projects/`), transcript parsing, file watching, permission modes, tool approval, model lists, command registry, and MCP tools are all hardcoded to Claude SDK specifics.

**The good news:** The Relay adapter pattern is solid. The `AgentManagerLike` interface, `StreamEvent` type, and adapter lifecycle are well-abstracted. The architectural bones are there — they just need to be extended to cover everything, not just Relay messaging.

---

## Checklist

| #   | Area                          | Verdict                                                    | Severity |
| --- | ----------------------------- | ---------------------------------------------------------- | -------- |
| 1   | Claude Code Adapter scope     | Covers Relay path only, not direct API                     | HIGH     |
| 2   | AgentManager SDK coupling     | Monolithic, no abstraction layer                           | CRITICAL |
| 3   | Server routes                 | `sessions.ts` and `models.ts` directly import AgentManager | HIGH     |
| 4   | Session storage (transcripts) | Hardcoded to `~/.claude/projects/` JSONL files             | CRITICAL |
| 5   | Relay message flow            | Well-abstracted via adapter pattern                        | OK       |
| 6   | Client-side assumptions       | Hardcoded Claude models, permission modes, cost tracking   | MEDIUM   |
| 7   | MCP tool server               | Uses SDK's `createSdkMcpServer()` directly                 | HIGH     |
| 8   | Context builder               | XML blocks are DorkOS convention, reusable                 | LOW      |
| 9   | Interactive handlers          | Returns SDK `PermissionResult` type                        | MEDIUM   |
| 10  | Command registry              | Scans `.claude/commands/` — Claude convention              | LOW      |
| 11  | Permission modes              | `bypassPermissions`, `plan`, etc. are SDK concepts         | MEDIUM   |
| 12  | Session sync/broadcaster      | chokidar watches JSONL files — file-based coupling         | HIGH     |
| 13  | Shared schemas/types          | `StreamEvent`, `PermissionMode` embed Claude assumptions   | MEDIUM   |
| 14  | CLI package                   | Hard-requires `claude` CLI binary                          | HIGH     |

---

## Detailed Findings

### 1. Claude Code Adapter — Current Scope

**What it handles:**

- Relay `relay.agent.>` messages → routes to AgentManager
- Relay `relay.system.pulse.>` messages → Pulse scheduler dispatch
- Per-agent concurrency (semaphore + serial queues)
- Session ID mapping (Mesh ULID → SDK UUID) via `AgentSessionStore`
- `<relay_context>` prompt wrapping
- Response republishing to Relay subjects
- Trace recording for delivery observability

**What it does NOT handle:**

- Direct API chat messages (POST `/api/sessions/:id/messages` when Relay disabled)
- Session creation (POST `/api/sessions`)
- Session listing and metadata (GET `/api/sessions`)
- Message history retrieval (GET `/api/sessions/:id/messages`)
- Tool approval/deny (POST `/api/sessions/:id/approve`)
- Model listing (GET `/api/models`)
- Session status updates (PATCH `/api/sessions/:id`)
- SSE sync stream (GET `/api/sessions/:id/stream`)

**Verdict:** The adapter is a Relay delivery mechanism, not an abstraction layer over Claude Code. ~60% of Claude Code interactions bypass it entirely.

---

### 2. AgentManager — SDK Coupling

**File:** `apps/server/src/services/core/agent-manager.ts` (~450 lines)

This is the composition root for all agent execution and is **entirely Claude SDK-specific**:

- Imports `query`, `Options`, `SDKMessage`, `McpServerConfig` from `@anthropic-ai/claude-agent-sdk`
- Calls `query()` with `systemPrompt: { type: 'preset', preset: 'claude_code' }`
- Manages SDK session lifecycle via `resume` parameter
- Handles SDK-specific error patterns (`isResumeFailure()`)
- Tracks `sdkSessionId` (UUID assigned by SDK) separately from external session IDs
- Hardcoded default models: `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`, `claude-opus-4-6`
- Caches supported models from `agentQuery.supportedModels()` (SDK method)

**No abstraction layer exists.** AgentManager is imported directly by routes, not via an interface.

---

### 3. Server Routes — Direct SDK Usage

**Critical coupling (directly imports AgentManager):**

| Route         | Coupling               | Details                                                                                |
| ------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `sessions.ts` | 9 AgentManager calls   | ensureSession, sendMessage, approveTool, submitAnswers, getSdkSessionId, updateSession |
| `models.ts`   | 1 AgentManager call    | getSupportedModels()                                                                   |
| `config.ts`   | resolveClaudeCliPath() | Returns Claude CLI binary location                                                     |

**Moderate coupling (SDK concepts):**

| Route         | Coupling                                                  |
| ------------- | --------------------------------------------------------- |
| `agents.ts`   | Defaults `runtime: 'claude-code'`, `personaEnabled: true` |
| `commands.ts` | Scans `.claude/commands/` directory                       |
| `pulse.ts`    | Scheduler dispatches to AgentManager (indirect)           |
| `relay.ts`    | Uses `transcriptReader.getSession()` for label resolution |

**No coupling:** `health.ts`, `directory.ts`, `files.ts`, `git.ts`, `tunnel.ts`, `discovery.ts`

---

### 4. Session Architecture — Transcript Coupling

**The deepest coupling in the codebase.** Sessions are derived entirely from SDK JSONL files:

- **Path:** `~/.claude/projects/{slug}/{sessionId}.jsonl` — hardcoded in `transcript-reader.ts`
- **Slug derivation:** Sanitizes vault root path to create project directory name
- **Session ID:** UUID assigned by Claude SDK, used as JSONL filename
- **Metadata extraction:** Title from first user message, timestamps from file stats, model from assistant messages, permission mode from system/init message, token counts from usage blocks

**Specific SDK assumptions in `transcript-parser.ts`:**

- JSONL line types: `user`, `assistant`, `system` (with `subtype: 'init'`), `file-history-snapshot`
- Content blocks: `text`, `tool_use` (with `id`, `name`, `input`), `tool_result` (with `tool_use_id`)
- Usage fields: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- Permission mode values: `bypassPermissions`, `dangerously-skip`, `plan`, `acceptEdits`, `default`
- Special tool handling: `AskUserQuestion` (questions/answers), `Skill` (command expansion suppression)
- Metadata wrappers: `<relay_context>`, `<command-message>`, `<system-reminder>`, `<task-notification>`

**In `session-broadcaster.ts`:**

- chokidar file watcher on JSONL files with debounce (100ms)
- Byte-offset-based incremental reading for SSE sync
- Head buffer (8KB) and tail buffer (16KB) for metadata extraction

---

### 5. Relay Message Flow

**This is the best-abstracted part of the codebase.**

The Relay path is properly layered:

```
Client → POST /messages → relayCore.publish() → AdapterRegistry → ClaudeCodeAdapter → AgentManager → SDK
```

The adapter implements the standard `RelayAdapter` interface. Other adapters (Telegram, Webhook) follow the same pattern. The `AgentManagerLike` interface in the adapter is clean:

```typescript
interface AgentManagerLike {
  ensureSession(sessionId, opts): void;
  sendMessage(sessionId, content, opts?): AsyncGenerator<StreamEvent>;
  getSdkSessionId(sessionId): string | undefined;
}
```

**One issue:** The direct API path completely bypasses this:

```
Client → POST /messages → AgentManager.sendMessage() → SDK
```

Both paths produce the same `StreamEvent` objects but with different delivery semantics (202+SSE vs 200+streaming body).

---

### 6. Client-Side Assumptions

**Hardcoded Claude models** (`use-session-status.ts`):

```typescript
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MODEL_CONTEXT_WINDOWS = {
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  // ... all claude-* prefix matching
};
```

**Permission modes in UI:**

- `SessionItem.tsx` checks `session.permissionMode === 'bypassPermissions'`
- Session creation defaults to `permissionMode: 'default'`
- Status bar shows permission mode indicator

**Tool approval UI:**

- `ToolApproval.tsx` — approve/deny buttons with keyboard shortcuts (Cmd+Enter/Esc)
- `QuestionPrompt.tsx` — handles `AskUserQuestion` tool (Claude SDK-specific)
- These assume Claude Code's interactive approval model

**Transport interface** (`transport.ts`) embeds Claude assumptions:

- `createSession()` takes `permissionMode`
- `approveTool()` and `submitAnswers()` are Claude-specific methods
- `getModels()` returns Claude models
- JSDoc: "Create a new Claude agent session"

**Cost tracking:** `SessionStatusData.costUsd` — Claude-specific concern

---

### 7. MCP Tool Server

**File:** `apps/server/src/services/core/mcp-tools/index.ts`

All 7 tool modules use SDK's `createSdkMcpServer()` and `tool()` functions directly:

- `core-tools.ts`, `pulse-tools.ts`, `relay-tools.ts`, `mesh-tools.ts`, `adapter-tools.ts`, `binding-tools.ts`, `trace-tools.ts`

Tool naming follows SDK convention: `mcp__dorkos__{tool-name}`. The `tool-filter.ts` hardcodes these names for allowlisting.

---

### 8. Context Builder

**File:** `apps/server/src/services/core/context-builder.ts`

Builds XML blocks (`<env>`, `<git_status>`, `<agent_identity>`, `<agent_persona>`, `<peer_agents>`, tool blocks) appended to SDK's `systemPrompt.append`.

**This is actually well-designed.** The context-gathering logic (git status, agent manifests, peer agents) is reusable. The XML format is a DorkOS convention, not SDK-specific. Any LLM backend that accepts system prompts could use this with minor format changes.

---

### 9. Interactive Handlers

**File:** `apps/server/src/services/core/interactive-handlers.ts`

Imports `PermissionResult` from `@anthropic-ai/claude-agent-sdk`. Returns `{ behavior: 'allow'|'deny', ... }` — SDK contract.

The pattern (event queue → promise → UI resolve) is generic and reusable. Only the `PermissionResult` type and tool name list are SDK-specific.

---

### 10–14. Other Areas (Summary)

| Area                    | Finding                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Command Registry**    | Scans `.claude/commands/` — convention-specific but not deeply coupled                                                                 |
| **Permission Modes**    | 4 values (`default`, `plan`, `acceptEdits`, `bypassPermissions`) used in session creation, filtering, UI display, and context building |
| **Session Broadcaster** | File watcher + byte offsets on JSONL — tightly coupled to file-based storage                                                           |
| **Shared Schemas**      | `StreamEvent`, `PermissionMode`, `ModelOption`, `SDK_TOOL_NAMES` all embed Claude assumptions                                          |
| **CLI Package**         | `check-claude.ts` hard-requires `claude` CLI binary; `resolveClaudeCliPath()` resolves SDK CLI path                                    |

---

## What We Got Right

1. **Relay adapter pattern** — `RelayAdapter` interface, `AdapterRegistry`, and `ClaudeCodeAdapter` are well-designed. The adapter is pluggable, stateful, and testable. ADR-0029 was a good decision.

2. **`AgentManagerLike` interface** — The adapter doesn't import the concrete AgentManager. It depends on an interface, making it swappable.

3. **`StreamEvent` as the universal event type** — Both Relay and direct paths produce the same event type. This is a solid wire format that could serve as the abstraction boundary.

4. **Context builder separation** — The context-gathering logic is cleanly separated from SDK integration. Reusable with any backend.

5. **Adapter lifecycle management** — `AdapterManager` handles start/stop, config hot-reload, and catalog management generically.

---

## What Needs to Change

### The Core Problem

There is no **runtime abstraction** between DorkOS and Claude Code. `AgentManager` is both the abstraction and the implementation. Everything outside Relay talks to Claude Code directly.

### Specific Issues (Ordered by Impact)

**1. AgentManager is a god object, not an interface** (CRITICAL)

Every service that needs to send a message imports the concrete AgentManager singleton. There's no `AgentRuntime` interface that other backends could implement.

**2. Session storage is hardcoded to JSONL files** (CRITICAL)

`TranscriptReader`, `TranscriptParser`, `SessionBroadcaster` all assume `~/.claude/projects/{slug}/{sessionId}.jsonl`. A different backend (OpenCode, Aider) would have completely different storage.

**3. Direct API path bypasses the adapter** (HIGH)

When Relay is disabled (or for session creation, history, approval, etc.), the code goes `route → AgentManager → SDK` with no adapter in between. The adapter only covers ~40% of Claude Code interactions.

**4. MCP tools use SDK's server factory** (HIGH)

`createSdkMcpServer()` is Claude SDK-specific. Other backends may use different tool protocols or not support MCP at all.

**5. Client embeds Claude assumptions** (MEDIUM)

Hardcoded model names, permission modes, cost tracking, and tool approval UX. These should be driven by backend capabilities.

---

## Recommended Architecture

### The Key Insight

DorkOS already has the right pattern in Relay — the `AgentManagerLike` interface. The fix is to **promote that interface to be the universal abstraction** and route everything through it, not just Relay messages.

### Target Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────────┐
│   Client     │────▸│  Server API  │────▸│   RuntimeRegistry  │
│  (React SPA) │     │  (Express)   │     │                    │
└─────────────┘     └──────────────┘     │  ┌──────────────┐  │
                                          │  │ ClaudeCode   │  │
┌─────────────┐     ┌──────────────┐     │  │ Runtime      │  │
│ Relay Bus   │────▸│ Adapter      │────▸│  │ (SDK+JSONL)  │  │
│             │     │ Registry     │     │  └──────────────┘  │
└─────────────┘     └──────────────┘     │  ┌──────────────┐  │
                                          │  │ OpenCode     │  │
┌─────────────┐     ┌──────────────┐     │  │ Runtime      │  │
│ Pulse       │────▸│ Scheduler    │────▸│  │ (future)     │  │
│ (cron)      │     │ Service      │     │  └──────────────┘  │
└─────────────┘     └──────────────┘     └────────────────────┘
```

### `AgentRuntime` Interface (Extracted from AgentManagerLike + AgentManager)

```typescript
interface AgentRuntime {
  readonly type: string; // 'claude-code' | 'opencode' | 'aider'

  // Session lifecycle
  ensureSession(sessionId: string, opts: SessionOpts): void;
  sendMessage(sessionId: string, content: string, opts?: MessageOpts): AsyncGenerator<StreamEvent>;

  // Session queries
  listSessions(projectDir: string): Promise<SessionSummary[]>;
  getSession(projectDir: string, sessionId: string): Promise<Session | null>;
  getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]>;

  // Interactive flows
  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean;
  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean;

  // Capabilities
  getSupportedModels(): Promise<ModelOption[]>;
  getCapabilities(): RuntimeCapabilities;

  // Sync
  watchSession(
    sessionId: string,
    projectDir: string,
    callback: (event: SyncEvent) => void
  ): Unsubscribe;
}

interface RuntimeCapabilities {
  supportsPermissionModes: boolean;
  supportedPermissionModes?: string[];
  supportsToolApproval: boolean;
  supportsCostTracking: boolean;
  supportsResume: boolean;
  supportsMcp: boolean;
}
```

### What This Gives Us

1. **Routes import the interface, not the implementation** — `sessions.ts` calls `runtime.sendMessage()` instead of `agentManager.sendMessage()`
2. **Session storage is runtime-specific** — `ClaudeCodeRuntime` reads JSONL, `OpenCodeRuntime` reads whatever it uses
3. **Capabilities drive the UI** — Client checks `runtime.getCapabilities()` to show/hide permission modes, cost, etc.
4. **Relay adapter wraps the same interface** — `ClaudeCodeAdapter` already does this; it just becomes one of many consumers
5. **MCP tools are optional** — Only injected when `capabilities.supportsMcp` is true

### Migration Path

This is not a rewrite. It's an extraction:

1. Extract `AgentRuntime` interface from existing `AgentManager` public API
2. Rename `AgentManager` to `ClaudeCodeRuntime implements AgentRuntime`
3. Move `TranscriptReader`/`TranscriptParser`/`SessionBroadcaster` into the runtime (they're Claude-specific)
4. Create `RuntimeRegistry` that holds the active runtime (initially always `ClaudeCodeRuntime`)
5. Update routes to import from registry instead of singleton
6. Add `getCapabilities()` to drive client-side feature detection
7. Client replaces hardcoded model lists with `transport.getCapabilities()`

This can be done incrementally — each step is backward-compatible.
