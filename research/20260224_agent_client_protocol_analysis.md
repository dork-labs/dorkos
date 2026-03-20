---
title: 'Agent Client Protocol (ACP) Analysis for DorkOS'
date: 2026-02-24
type: internal-architecture
status: archived
tags: [acp, protocol, agent-client, relay, messaging]
feature_slug: relay-server-client-integration
---

# Agent Client Protocol (ACP) Analysis for DorkOS

**Date:** 2026-02-24
**Author:** Research Agent (Claude Opus 4.6)
**Status:** Complete

---

## Table of Contents

1. [How DorkOS Currently Interacts with Claude Code/Agents](#1-how-dorkos-currently-interacts-with-claude-codeagents)
2. [Litepaper Vision vs. Current Implementation](#2-litepaper-vision-vs-current-implementation)
3. [What is the Agent Client Protocol?](#3-what-is-the-agent-client-protocol)
4. [Should DorkOS Adopt ACP?](#4-should-dorkos-adopt-acp)
5. [Recommendation](#5-recommendation)
6. [Sources](#6-sources)

---

## 1. How DorkOS Currently Interacts with Claude Code/Agents

### Architecture Summary

DorkOS uses a **tightly-coupled, SDK-first integration** with Claude Code via the `@anthropic-ai/claude-code` Agent SDK. The integration has three layers:

```
┌──────────────────────────────────────────────────────────┐
│  Console (React 19 SPA)                                  │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Transport Interface (27 methods)                   │ │
│  │  ├─ HttpTransport (standalone web → Express API)    │ │
│  │  └─ DirectTransport (Obsidian → in-process)         │ │
│  └─────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│  Engine (Express Server)                                 │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  REST/SSE API (9 route groups, ~30 endpoints)       │ │
│  ├─────────────────────────────────────────────────────┤ │
│  │  AgentManager                                       │ │
│  │  ├─ SDK query() calls with streaming                │ │
│  │  ├─ canUseTool callback (tool approval)             │ │
│  │  ├─ SDK event mapping (sdk-event-mapper.ts)         │ │
│  │  ├─ Context injection (context-builder.ts)          │ │
│  │  ├─ MCP tool server (mcp-tool-server.ts)            │ │
│  │  └─ Session locking (session-lock.ts)               │ │
│  ├─────────────────────────────────────────────────────┤ │
│  │  TranscriptReader (JSONL files as source of truth)  │ │
│  │  SessionBroadcaster (chokidar file watching)        │ │
│  │  SchedulerService (cron-based Pulse dispatch)       │ │
│  └─────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│  Claude Agent SDK (@anthropic-ai/claude-code)            │
│  ├─ query() — streaming async generator                  │
│  ├─ SDKMessage — union type for all events               │
│  ├─ canUseTool — permission callback                     │
│  ├─ createSdkMcpServer — in-process MCP tools            │
│  └─ JSONL transcripts at ~/.claude/projects/{slug}/      │
└──────────────────────────────────────────────────────────┘
```

### Server-Side Integration Points

**SDK Entry Point:** A single import in `agent-manager.ts` provides `query`, `Options`, and `SDKMessage` from `@anthropic-ai/claude-code`. Every agent interaction flows through the `AgentManager.sendMessage()` async generator.

**Session Lifecycle:**

1. `POST /api/sessions` creates an in-memory session (no SDK call yet)
2. First `POST /api/sessions/:id/messages` triggers `query()` with `systemPrompt: { type: 'preset', preset: 'claude_code', append: runtimeContext }`
3. Subsequent messages use `resume: sdkSessionId` for continuity
4. The SDK writes JSONL transcripts to disk; DorkOS reads them for history

**Streaming Architecture:** The `sendMessage()` method uses a dual-source event loop — `Promise.race()` between the SDK's async iterator and an internal event queue. This lets tool approval events be yielded to the SSE stream while the SDK iterator is blocked waiting for the `canUseTool` callback to resolve.

**Event Mapping:** `sdk-event-mapper.ts` is a pure async generator that transforms SDK message types into DorkOS `StreamEvent` types:

| SDK Message                      | DorkOS StreamEvent                       |
| -------------------------------- | ---------------------------------------- |
| `system/init`                    | `session_status`                         |
| `content_block_start` (tool_use) | `tool_call_start`                        |
| `content_block_delta` (text)     | `text_delta`                             |
| `content_block_delta` (json)     | `tool_call_delta`                        |
| `content_block_stop`             | `tool_call_end` + optional `task_update` |
| `tool_use_summary`               | `tool_result`                            |
| `result`                         | `session_status` + `done`                |

**Tool Approval:** The SDK's `canUseTool(toolName, input, context)` callback is intercepted by `interactive-handlers.ts`. For `AskUserQuestion` tools it pushes a `question_prompt` event; for other tools in `default` permission mode it pushes `approval_required`. Both create pending promises that resolve when the client calls `POST /approve` or `POST /submit-answers`.

**MCP Tools:** An in-process MCP server exposes DorkOS capabilities to the agent (ping, session count, Pulse schedule CRUD). Agent-created schedules enter `pending_approval` status.

**Transcript Reading:** `TranscriptReader` reads SDK JSONL files directly — no separate database. It uses head reads (8KB) for metadata, tail reads (16KB) for latest state, and full reads for complete history. `SessionBroadcaster` watches files via chokidar for cross-client sync.

### Client-Side Integration Points

**Transport Abstraction:** The React client never calls `fetch()` directly. All 27 API methods go through the `Transport` interface, with `HttpTransport` (web) and `DirectTransport` (Obsidian) as adapters.

**SSE Stream Consumption:** `HttpTransport.sendMessage()` manually parses the SSE wire protocol from a `ReadableStream`, calling an `onEvent` callback for each event. `stream-event-handler.ts` dispatches events into React state using a mutable `currentPartsRef` accumulator.

**Session Sync:** A persistent `EventSource` connection at `GET /api/sessions/:id/stream` receives `sync_update` notifications when JSONL files change. On sync events, TanStack Query caches are invalidated, triggering background refetches.

**Adaptive Polling:** Message history polls at 3s (active tab), 10s (background tab), or not at all (during streaming). The ETag cache avoids redundant JSON parsing on 304 responses.

### Key Characteristics of the Current Architecture

1. **Tight SDK coupling** — DorkOS is purpose-built for `@anthropic-ai/claude-code`. The `SDKMessage` type, `canUseTool` callback, `systemPrompt.preset`, and JSONL transcript format are all Claude Agent SDK-specific.
2. **Server-mediated** — The client never talks to the agent directly. Everything goes through Express → AgentManager → SDK.
3. **File-based truth** — JSONL transcripts on disk are the single source of truth. No database for sessions.
4. **Custom streaming protocol** — DorkOS defines its own SSE event types (`text_delta`, `tool_call_start`, `approval_required`, etc.) that differ from both the SDK's raw events and ACP's specification.
5. **Process-coupled** — The agent runs as a subprocess managed by the SDK within the same Node.js server process.

---

## 2. Litepaper Vision vs. Current Implementation

### What's Built (Engine + Console)

| Litepaper Promise                    | Current Status  | Notes                                                                                                                                                    |
| ------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST + SSE API with OpenAPI docs     | **Implemented** | 9 route groups, Scalar docs UI, auto-generated from Zod                                                                                                  |
| JSONL transcripts as source of truth | **Implemented** | TranscriptReader reads SDK files directly                                                                                                                |
| Pluggable agent adapters             | **Partially**   | Architecture supports it (Transport interface, adapter pattern), but only Claude Code adapter exists. No `AgentAdapter` abstraction layer on the server. |
| Optional tunnel for remote access    | **Implemented** | ngrok integration with auth                                                                                                                              |
| Directory boundary enforcement       | **Implemented** | BoundaryError with symlink resolution                                                                                                                    |
| MCP tool server                      | **Implemented** | In-process SDK MCP server with DorkOS tools                                                                                                              |
| Browser-based command center         | **Implemented** | React 19 SPA with chat, approvals, session management                                                                                                    |
| Tool approval flows                  | **Implemented** | Full approve/deny/question lifecycle                                                                                                                     |
| Session sync across clients          | **Implemented** | chokidar file watching + SSE broadcast                                                                                                                   |
| Slash command palette                | **Implemented** | Scans .claude/commands/, fuzzy search                                                                                                                    |

### What's Coming (Pulse — "Coming Soon")

| Litepaper Promise               | Current Status  | Notes                                    |
| ------------------------------- | --------------- | ---------------------------------------- |
| Cron-based scheduling           | **Implemented** | croner with overrun protection           |
| Isolated agent sessions per run | **Implemented** | Each run gets its own session ID + JSONL |
| Run history and retention       | **Implemented** | SQLite (better-sqlite3) with WAL mode    |
| Configurable concurrency        | **Implemented** | maxConcurrentRuns cap                    |
| API for CRUD and triggering     | **Implemented** | Full REST API + UI                       |

Pulse is further along than the litepaper suggests — it's functional, not just "coming soon."

### What's Not Built (Relay, Mesh, Wing)

| Module    | Litepaper Promise                                                                                                    | Current Reality                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Relay** | Universal message bus with Maildir+SQLite, NATS-style subjects, budget envelopes, dead letter queue, plugin adapters | **Not started.** Specs exist (`specs/relay-core-library/`), ADRs written (0010-0013), research done. No code. |
| **Mesh**  | Agent discovery via `.dork/agent.json` manifests, network topology, namespace isolation, access control              | **Not started.** Litepaper written. No specs or code.                                                         |
| **Wing**  | Persistent memory, life coordination, proactive context                                                              | **Not started.** Litepaper written. No specs or code.                                                         |

### The "Agent-Agnostic" Gap

The litepaper's core promise is: "Bring your agent, we make it autonomous." The adapter architecture is declared but not fully realized:

- **Console side**: The `Transport` interface is agent-agnostic. `HttpTransport` talks to the Express API with generic `StreamEvent` types. Nothing in the client assumes Claude Code.
- **Engine side**: The `AgentManager` is tightly coupled to `@anthropic-ai/claude-code`. There is no `AgentAdapter` interface. The `query()` call, `SDKMessage` handling, `canUseTool` callback, `systemPrompt.preset: 'claude_code'`, and JSONL format are all Claude-specific.
- **Pulse**: The scheduler calls `agentManager.sendMessage()` directly — it can only dispatch to Claude Code.

To add a second agent (Codex, OpenCode, etc.), DorkOS would need to extract an `AgentAdapter` interface from `AgentManager` and implement it for each agent runtime. This is the gap where ACP becomes relevant.

---

## 3. What is the Agent Client Protocol?

### Overview

The Agent Client Protocol (ACP) is a JSON-RPC 2.0-based protocol that standardizes communication between code editors (clients) and AI coding agents (servers). It was created by Anthropic and is led by Ben Brandt (Zed Industries) and Sergey Ignatov (JetBrains).

ACP is to coding agents what LSP (Language Server Protocol) is to language servers — a universal interface that lets any client work with any agent.

### Protocol Architecture

```
Client (Editor/IDE)          Agent (Coding Agent)
    │                              │
    │── initialize ───────────────►│  Capabilities negotiation
    │◄── InitializeResponse ───────│
    │                              │
    │── session/new ──────────────►│  Create session
    │◄── NewSessionResponse ───────│
    │                              │
    │── session/prompt ───────────►│  Send user message
    │                              │
    │◄── session/update ───────────│  Streaming: text chunks,
    │◄── session/update ───────────│  tool calls, plan entries,
    │◄── session/update ───────────│  mode changes
    │                              │
    │◄── session/request_permission│  Tool approval request
    │── PermissionResponse ───────►│
    │                              │
    │◄── fs/read_text_file ────────│  File system access
    │── FileContents ─────────────►│
    │                              │
    │◄── terminal/create ──────────│  Terminal command execution
    │── TerminalId ───────────────►│
    │                              │
    │◄── session/update (done) ────│  Turn complete
    │                              │
    │── session/cancel ───────────►│  Interrupt (notification)
    │── session/load ─────────────►│  Resume session (optional)
```

### Transport

- **Current**: JSON-RPC 2.0 over stdio (subprocess model)
- **In development**: HTTP/WebSocket for remote agents

### Key Protocol Elements

**Methods (Agent-side, client → agent):**

- `initialize` — Negotiate capabilities, protocol version
- `authenticate` — Optional authentication
- `session/new` — Create a new session (cwd, MCP servers, config)
- `session/prompt` — Send user message with content blocks
- `session/cancel` — Interrupt processing (notification, no response)
- `session/load` — Resume existing session (capability-gated)
- `session/set_mode` — Switch operating mode

**Methods (Client-side, agent → client):**

- `session/request_permission` — Ask user to approve tool call
- `fs/read_text_file` — Read file contents (capability-gated)
- `fs/write_text_file` — Write file contents (capability-gated)
- `terminal/create` — Execute command in terminal
- `terminal/output` — Get terminal output
- `terminal/wait_for_exit` — Wait for command completion
- `terminal/kill` — Kill running command
- `terminal/release` — Release terminal resources

**Notifications (Agent → Client):**

- `session/update` — Streams progress: message chunks, tool calls with live status, plan entries, command updates, mode changes

**Content Block Types:** text, image, audio, resource, resource_link — reuses MCP types where possible.

**Capabilities System:** Both sides advertise capabilities during `initialize`. Optional features (session loading, file system access, terminal access) are capability-gated. Clients adapt behavior based on what the agent supports.

**Plan Entries:** Agents communicate task decomposition via plan entries with priority (high/medium/low) and status (pending/in_progress/completed).

### Ecosystem

- **40+ compatible clients**: Zed, JetBrains IDEs, VS Code extensions, Neovim, Obsidian, etc.
- **25+ compatible agents**: Claude Agent, Cline, GitHub Copilot, Junie, Gemini CLI, goose, etc.
- **4 official SDKs**: TypeScript, Python, Rust, Kotlin
- **Latest release**: v0.10.8 (Feb 2026)
- **Repository**: 2.1k stars, 159 forks, 73 contributors

### ACP vs. MCP Relationship

ACP and MCP are **complementary**, not competing:

- **MCP** handles the "what" — what tools and data can agents access (vertical: agent ↔ tools/databases/APIs)
- **ACP** handles the "where" — how agents and editors/clients communicate (horizontal: client ↔ agent)

ACP reuses MCP's JSON representations for content blocks where possible.

### Claude Code + ACP Status

GitHub issue [#6686](https://github.com/anthropics/claude-code/issues/6686) requested native ACP support in Claude Code. It was **closed as "not planned"** by Anthropic, despite 440 thumbs up and significant community interest. Community workarounds exist:

- `@zed-industries/claude-code-acp` — npm package published by Zed
- Third-party implementations for Neovim and other editors
- Known stability issues (crashes, "prompt too long" errors, path resolution bugs)

The implication: Anthropic does not plan to make Claude Code a native ACP server. The community bridges Claude Code to ACP via wrapper processes.

---

## 4. Should DorkOS Adopt ACP?

### Analysis Framework

I'll evaluate ACP through three lenses:

1. **As a replacement** for the current Claude Agent SDK integration
2. **As an addition** alongside the SDK integration
3. **As the agent-agnostic abstraction layer** the litepaper promises

### Lens 1: ACP as Replacement for Agent SDK — NO

ACP cannot replace the Claude Agent SDK for DorkOS's current use case. Here's why:

**ACP is designed for editors, not orchestrators.** The protocol assumes a human is sitting in an editor, invoking an agent for a specific task. DorkOS is an orchestration layer that schedules unattended agent runs (Pulse), manages sessions across multiple clients, and exposes programmatic APIs. ACP's stdio subprocess model doesn't support:

- Multiple concurrent sessions dispatched by a scheduler
- Persistent session state across server restarts
- Session sharing across multiple connected clients
- Programmatic tool approval (Pulse runs in `bypassPermissions` mode)
- MCP tool injection (DorkOS exposes its own tools to the agent)

**ACP's transport is wrong for DorkOS.** ACP uses stdio (subprocess per agent), while DorkOS needs:

- A persistent server process managing many agent sessions
- SSE streaming to multiple browser clients simultaneously
- Session locking for concurrent client access
- File-watching for cross-client sync

**The current SDK integration is deeper than ACP allows.** DorkOS uses:

- `systemPrompt: { type: 'preset', preset: 'claude_code', append }` — ACP has no equivalent for injecting runtime context into a preset system prompt
- `canUseTool` callback with programmable approval logic — ACP's `session/request_permission` is simpler (binary approve/deny, no input modification)
- `includePartialMessages: true` for streaming content block deltas — ACP's streaming is at the `session/update` notification level
- `resume: sessionId` for session continuity backed by JSONL files — ACP's `session/load` is capability-gated and agent-dependent
- In-process MCP server injection via `mcpServers` option — ACP passes MCP server configs, not in-process servers

**Verdict: ACP is not a viable replacement.** The SDK gives DorkOS deep control over the agent runtime that ACP abstracts away by design.

### Lens 2: ACP as Additional Interface — MAYBE (Lower Priority)

DorkOS could expose an ACP server interface, making itself appear as an "agent" to ACP-compatible editors. This would let Zed, JetBrains, Neovim, etc. connect to DorkOS instead of directly to Claude Code.

**What this would look like:**

```
Zed Editor ──ACP (stdio)──► DorkOS Engine ──SDK──► Claude Code
```

The user opens Zed, configures DorkOS as their ACP agent, and gets the DorkOS experience (Pulse scheduling, Relay messaging, session history, MCP tools) through their editor.

**Pros:**

- DorkOS becomes discoverable in the ACP agent registry (25+ agents, 40+ clients)
- Users who prefer Zed/JetBrains/Neovim get DorkOS capabilities without the browser Console
- Aligns with the litepaper's "developer-first" principle
- Doesn't require changing the current architecture — just adds a new entry point

**Cons:**

- ACP's current transport is stdio only — DorkOS is a persistent server, not a subprocess
- The most valuable DorkOS features (Pulse, Relay, session management) don't map to ACP's editor-focused protocol
- ACP assumes the agent has direct file system access; DorkOS mediates all file access through boundaries
- Low ROI until DorkOS has more features that differentiate it from raw Claude Code
- The community already bridges Claude Code to ACP via `@zed-industries/claude-code-acp` — DorkOS would compete with direct Claude Code access in ACP clients

**Verdict: Not now. Revisit when HTTP transport ships and DorkOS has unique value (Relay, Mesh) that ACP clients would benefit from.**

### Lens 3: ACP as the Agent-Agnostic Abstraction Layer — PARTIALLY

This is the most interesting lens. The litepaper promises "bring your agent, we make it autonomous." Today, only Claude Code is supported. ACP could serve as the abstraction layer for multi-agent support.

**The idea:** Instead of implementing a custom `AgentAdapter` interface for each agent runtime (Claude Code SDK, Codex CLI, OpenCode, etc.), DorkOS could use ACP as the universal agent interface:

```
                    ┌─ ACP ─► Claude Code (via @zed-industries/claude-code-acp)
DorkOS Engine ──────┤─ ACP ─► Codex CLI (via codex-acp)
                    ├─ ACP ─► Gemini CLI (native ACP)
                    └─ ACP ─► goose (native ACP)
```

**What works:**

- ACP standardizes the core loop: create session → send prompt → stream updates → handle tool approvals → get result
- ACP's capabilities system handles per-agent feature detection (does this agent support session resumption? file system access?)
- Many agents already have ACP support (Gemini CLI, goose, Cline) or community bridges (Claude Code, Codex)
- ACP handles the "how to talk to an agent" problem generically

**What doesn't work:**

- **Loss of Claude Code-specific features:** DorkOS's deep SDK integration (preset system prompts, `canUseTool` with input modification, in-process MCP servers, JSONL transcript access) would be lost. ACP is a lowest-common-denominator interface.
- **ACP's file/terminal model inverts DorkOS's architecture:** In ACP, the agent calls the client for file access (`fs/read_text_file`) and terminal access (`terminal/create`). In DorkOS, the agent has direct file system access (it runs on the same machine). DorkOS would need to implement ACP's client-side methods even though the agent doesn't need mediated access.
- **Stdio subprocess model vs. persistent sessions:** DorkOS needs session persistence across server restarts. ACP agents are subprocesses that die when the connection closes. Session resumption requires explicit `session/load` and agent support.
- **No system prompt injection:** ACP's `session/prompt` sends user messages. There's no mechanism for DorkOS to inject runtime context (git status, env info, Pulse metadata) into the agent's system prompt the way `systemPrompt.append` does.
- **No programmatic tool approval:** ACP's `session/request_permission` is designed for human-in-the-loop approval. Pulse's unattended mode (`bypassPermissions`) has no ACP equivalent.

**A hybrid approach could work:**

```
DorkOS Engine
  ├── ClaudeCodeAdapter (native SDK — deep integration, preferred)
  ├── AcpAdapter (ACP client — generic, works with any ACP agent)
  │     ├── Wraps ACP agent subprocess
  │     ├── Maps ACP session/update → DorkOS StreamEvent
  │     ├── Handles session/request_permission → DorkOS approval flow
  │     └── Passes MCP server configs via session/new
  └── (future) DirectAdapter (for agents with direct Node.js APIs)
```

In this model:

- Claude Code keeps its native SDK adapter (best experience, full feature set)
- Other agents get ACP support via a generic `AcpAdapter` (reduced feature set, but functional)
- The `AgentAdapter` interface is DorkOS-defined, with ACP as one implementation strategy

**Verdict: ACP is useful as ONE implementation strategy for the agent adapter interface, but it should not BE the adapter interface. DorkOS needs its own abstraction that can accommodate both deep SDK integrations and generic ACP connections.**

### Critical Insight: ACP Solves a Different Problem

ACP's core value proposition is **editor portability** — any editor can use any agent. DorkOS's core value proposition is **agent orchestration** — scheduling, communication, memory, and coordination for autonomous agents.

These are complementary but orthogonal concerns:

| Concern                         | ACP Solves? | DorkOS Needs?                   |
| ------------------------------- | ----------- | ------------------------------- |
| Editor ↔ agent communication    | Yes         | No (DorkOS has its own Console) |
| Agent-agnostic interface        | Partially   | Yes (litepaper promise)         |
| Session management at scale     | No          | Yes (Pulse, multi-client)       |
| Inter-agent communication       | No          | Yes (Relay)                     |
| Agent discovery & topology      | No          | Yes (Mesh)                      |
| Unattended autonomous execution | No          | Yes (Pulse + Loop)              |
| Tool injection / MCP extension  | Partially   | Yes (MCP tool server)           |
| Budget & safety enforcement     | No          | Yes (Relay budget envelopes)    |

ACP and DorkOS overlap only on "agent-agnostic interface" — and even there, ACP's interface is optimized for interactive editor use, while DorkOS needs programmatic orchestration.

---

## 5. Recommendation

### Do Not Adopt ACP as a Core Protocol

ACP solves editor-agent interoperability. DorkOS is not an editor — it's an orchestration layer. Adopting ACP as the core agent interface would:

- Force DorkOS into a lowest-common-denominator integration with Claude Code (losing deep SDK features)
- Add complexity for a protocol designed around editor UX patterns (file mediation, terminal abstraction) that DorkOS doesn't need
- Not address DorkOS's actual needs (scheduling, messaging, agent discovery)

### Do Design a DorkOS `AgentAdapter` Interface

The litepaper's "agent-agnostic" promise requires an abstraction layer. This should be a DorkOS-defined interface that captures DorkOS's specific needs:

```typescript
interface AgentAdapter {
  // Session lifecycle
  createSession(opts: { cwd: string; systemPromptAppend?: string }): Promise<string>;
  resumeSession(sessionId: string): Promise<boolean>;

  // Message exchange (async generator for streaming)
  sendMessage(
    sessionId: string,
    content: string,
    opts?: {
      permissionMode?: PermissionMode;
      systemPromptAppend?: string;
      mcpServers?: Record<string, unknown>;
    }
  ): AsyncGenerator<StreamEvent>;

  // Tool approval (programmable)
  setToolApprovalHandler(handler: ToolApprovalHandler): void;

  // Capabilities
  capabilities(): AdapterCapabilities;

  // Cleanup
  destroy(): Promise<void>;
}
```

This interface would have multiple implementations:

- `ClaudeCodeSdkAdapter` — current deep integration, first-class experience
- `AcpClientAdapter` — wraps any ACP agent via subprocess, generic but functional
- Future: `OpenCodeAdapter`, `CodexAdapter`, etc. (either native or via ACP)

### Consider ACP as a Secondary Entry Point (Future)

When ACP's HTTP transport ships and DorkOS has differentiated features (Relay, Mesh), exposing DorkOS as an ACP agent server becomes interesting. Users in Zed/JetBrains could connect to DorkOS and get Relay messaging, Pulse scheduling, and Mesh discovery through their editor. This is a feature, not an architecture decision — it can be added later without changing the core.

### Immediate Next Steps

1. **Define `AgentAdapter` interface** — Extract from current `AgentManager` code
2. **Implement `ClaudeCodeSdkAdapter`** — Wrap current SDK integration behind the new interface
3. **Build Relay first** — The universal message bus is higher priority than multi-agent support. Relay enables inter-agent communication regardless of which adapter an agent uses.
4. **Revisit ACP when HTTP transport is stable** — Monitor [agentclientprotocol.com](https://agentclientprotocol.com) for HTTP/WebSocket support

### Priority Order

```
1. Relay (universal message bus)        ← Enables the vision
2. AgentAdapter interface               ← Enables multi-agent
3. AcpClientAdapter implementation      ← Enables ACP agents
4. ACP server exposure (DorkOS-as-agent)← Nice-to-have
```

Relay is higher priority than ACP because Relay enables agent-to-agent communication (the core DorkOS differentiator), while ACP only enables agent-to-editor communication (which DorkOS already handles with its own Console).

---

## 6. Sources

### Agent Client Protocol

- [Agent Client Protocol — Official Site](https://agentclientprotocol.com/)
- [ACP Protocol Overview](https://agentclientprotocol.com/protocol/overview)
- [ACP GitHub Repository](https://github.com/agentclientprotocol/agent-client-protocol) — 2.1k stars, v0.10.8
- [ACP Python SDK Overview (DeepWiki)](https://deepwiki.com/agentclientprotocol/python-sdk/4.1-agent-client-protocol-overview)
- [ACP Rust Schema (docs.rs)](https://docs.rs/agent-client-protocol-schema)
- [Claude Code ACP Issue #6686](https://github.com/anthropics/claude-code/issues/6686) — Closed as "not planned", 440 upvotes
- [Intro to ACP — Goose Blog](https://block.github.io/goose/blog/2025/10/24/intro-to-agent-client-protocol-acp/)
- [A Developer's Intro to ACP — Calum Murray](https://www.calummurray.ca/blog/intro-to-acp)
- [ACP: The LSP for AI Coding Agents — PromptLayer](https://blog.promptlayer.com/agent-client-protocol-the-lsp-for-ai-coding-agents/)

### DorkOS Internal

- `meta/dorkos-litepaper.md` — DorkOS vision, architecture, design principles
- `meta/modules/relay-litepaper.md` — Relay universal message bus specification
- `apps/server/src/services/agent-manager.ts` — Claude Agent SDK integration
- `apps/server/src/services/sdk-event-mapper.ts` — SDK → StreamEvent transformation
- `apps/server/src/services/interactive-handlers.ts` — Tool approval flow
- `apps/server/src/services/mcp-tool-server.ts` — In-process MCP tools
- `apps/server/src/services/transcript-reader.ts` — JSONL transcript reading
- `apps/server/src/services/scheduler-service.ts` — Pulse scheduler dispatch
- `packages/shared/src/transport.ts` — Transport interface (27 methods)
- `apps/client/src/layers/shared/lib/http-transport.ts` — HTTP adapter
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Chat state machine
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — SSE event dispatch

### Disambiguation

**Note:** There are two protocols with "ACP" in the name:

1. **Agent Client Protocol** (agentclientprotocol.com) — By Anthropic/Zed/JetBrains, for editor-to-agent communication. **This is the protocol analyzed in this document.**
2. **Agent Communication Protocol** (Linux Foundation/IBM) — For agent-to-agent communication over HTTP REST. This is a different protocol with different goals, more analogous to what Relay aims to be.
