---
slug: claude-code-webui-api
---

# Claude Code WebUI & Reusable API

**Slug:** claude-code-webui-api
**Author:** Claude Code
**Date:** 2026-02-06
**Branch:** preflight/claude-code-webui-api

---

## 1) Intent & Assumptions

- **Task brief:** Build a web-based UI that mirrors the major features of the Claude Code CLI (chat, tool call visualization, slash commands with auto-complete, `--dangerously-skip-permissions` mode, session continuity) backed by a reusable REST/streaming API. The API should be channel-agnostic so it can serve the WebUI, Slack bots, mobile clients, or other frontends.

- **Assumptions:**
  - The Anthropic Claude Code TypeScript SDK (`@anthropic-ai/claude-code` or similar) provides programmatic access to the same agent loop, tools, and context management that powers the CLI
  - The server runs locally on the same machine as the vault (single-user, localhost)
  - No auth/user management needed initially (single user, local network)
  - The `gateway/` directory is the designated home for this project (already scaffolded with `.gitkeep` files)
  - Claude Code sessions can be spawned and managed as child processes or via SDK embedding
  - The existing `.claude/commands/`, `.claude/skills/`, `.claude/agents/`, and `.claude/hooks/` systems should be accessible through the API

- **Out of scope:**
  - Multi-user authentication and authorization
  - Cloud deployment / hosting infrastructure
  - Mobile-native apps (API supports it, but no mobile UI)
  - Replacing the CLI (WebUI is an alternative interface, not a replacement)
  - MCP server management UI (future enhancement)
  - Real-time collaboration (multi-user editing)

---

## 2) Pre-reading Log

### Codebase Files
- `workspace/0-System/README.md`: LifeOS v0.11.0 architecture overview; confirms `gateway/` is designated as "Node.js API server (future)"
- `workspace/0-System/architecture.md`: References `gateway/` as "REST API + WebSocket" location
- `.claude/commands/` (30+ namespaces): Command files are markdown with YAML frontmatter (`description`, `allowed-tools`, `argument-hint`, `category`)
- `.claude/skills/` (54+ skills): Model-invoked knowledge modules with `SKILL.md` files
- `.claude/agents/` (19+ agents): Autonomous task executors with session resumption support
- `.claude/hooks/` (18 hooks): Lifecycle automation with JSON I/O protocol, some blocking
- `.claude/settings.json`: Hook configuration, generated from `.user/integrations.yaml`
- `.user/` directory: User configuration (identity, companies, coaching, integrations, health, calendars)
- `gateway/src/server/middleware/.gitkeep`: Empty scaffold confirming directory structure
- `gateway/src/channels/.gitkeep`: Empty scaffold for future channel adapters
- `package.json`: Currently empty (`{}`) at project root

### External Research
- **Claude Agent SDK** (renamed from Claude Code SDK late 2025): Package is `@anthropic-ai/claude-agent-sdk`. Provides `query()` function with streaming, session resume/fork, tool definitions, and `bypassPermissions` option. Sessions stored in `$HOME/.claude` as line-delimited JSON.
- **SDK Memory Warning**: Memory grows from 400-700MB idle to 1-4GB during active use. Known memory leak after ~30 min. Workaround: kill and resume session to restore performance.
- **SDK V2 API (Preview)**: Simplified `createAgent()` / `agent.send()` / `agent.receive()` pattern for multi-turn. Not stable yet - use V1 `query()`.
- `coder/agentapi` (GitHub): HTTP server wrapping Claude Code with OpenAPI schema, port 3284
- `dzhng/claude-agent-server` (GitHub): WebSocket server wrapping Claude Agent SDK for real-time bidirectional communication
- `rivet-dev/sandbox-agent` (GitHub): Runs coding agents in sandboxes, HTTP control, supports Claude Code
- **Vercel AI SDK 6** (`ai` + `@ai-sdk/react`): React hooks (`useChat`, `useCompletion`) for AI chat UIs with streaming. Tool call states: `'call'` (pending) and `'result'` (complete).
- **Vercel AI Elements**: New open-source library of 20+ React components built on shadcn/ui for AI interfaces. Includes `<MessageThread>`, `<InputBox>`, `<ToolDisplay>`, `<ReasoningPanel>`, `<StreamingText>`.
- **Vercel Streamdown**: Drop-in replacement for react-markdown optimized for AI streaming (memoized rendering, 2-10x faster)
- **Incremark**: Alternative streaming markdown renderer with O(n) incremental parsing (vs O(n^2) for traditional parsers). Up to 46x faster for large documents.
- **cmdk** (by Pacocoursey/shadcn): Command palette component with fuzzy search, keyboard navigation, grouping. Used by shadcn/ui's command component. Ideal for slash command auto-complete.
- TanStack Virtual: Virtualization library for rendering only visible items in long lists. Note: bidirectional infinite scroll (load old messages up, new messages down) requires manual scroll restoration.
- TanStack Query: Server state management with caching, background refetching
- TanStack Store: Primarily internal to TanStack libraries, not widely adopted for app state. **Zustand** is the more practical choice for client state.
- TanStack DB: Still in **beta** - skip for v1, revisit when stable

---

## 3) Codebase Map

### Primary Components/Modules

| Path | Role |
|------|------|
| `gateway/src/server/` | Designated API server location (empty scaffold) |
| `gateway/src/channels/` | Channel adapters location (empty scaffold) |
| `.claude/commands/**/*.md` | 80+ slash commands with frontmatter metadata |
| `.claude/skills/*/SKILL.md` | 54+ model-invoked knowledge modules |
| `.claude/agents/*.md` | 19+ autonomous task executor definitions |
| `.claude/hooks/*.py` | 18 lifecycle automation scripts |
| `.claude/settings.json` | Hook configuration and tool permissions |
| `.user/*.yaml` | User configuration (6 files) |

### Shared Dependencies
- `.claude/scripts/inject_placeholders.py` - Configuration injection system
- `.claude/scripts/configure_hooks.py` - Hook setup from integrations config
- `CLAUDE.md` / `CLAUDE.template.md` - AI instruction files (generated)
- `.claude/rules/*.md` - Coaching, components, questioning rules

### Data Flow (Current CLI)
```
User Input → Claude Code CLI → Anthropic API → Tool Execution → Hook Lifecycle → Response
                    ↓                                    ↑
              .claude/commands/                   .claude/hooks/
              .claude/skills/                     .claude/settings.json
              .claude/agents/
```

### Data Flow (Proposed WebUI)
```
Browser → WebUI React App → API Server (Express) → Claude Code SDK → Anthropic API
   ↑              ↓                    ↓                    ↓              ↓
   └── SSE/WS ────┘         Command Registry      Tool Execution    Hook Lifecycle
                             Session Manager        Agent Spawner
```

### Feature Flags/Config
- `.user/integrations.yaml` controls which integrations are enabled
- `--dangerously-skip-permissions` is a CLI flag that bypasses permission checks
- Hook exit code 2 = block operation

### Potential Blast Radius
- **New code only** - This is a greenfield project in `gateway/`
- No existing code to modify (empty scaffolds)
- Root `package.json` will need dependencies added
- Potential new monorepo structure (server + client packages)

---

## 4) Root Cause Analysis

*Not applicable - this is a new feature, not a bug fix.*

---

## 5) Research

### 5.1 Claude Code SDK Integration

**Approach A: Claude Agent SDK (Direct Embedding)**
- Use `@anthropic-ai/claude-agent-sdk` (renamed from `@anthropic-ai/claude-code` in late 2025) to embed the agent loop directly in the server process
- Pros: Native integration, full control, streaming support, no subprocess overhead
- Cons: SDK maturity/stability unknown; tight coupling to SDK API changes
- Complexity: Medium

**Approach B: Claude Code CLI Subprocess Wrapper**
- Spawn `claude` CLI as a child process, communicate via stdin/stdout
- Similar to `coder/agentapi` approach
- Pros: Uses battle-tested CLI, no SDK dependency, supports all CLI features including `--dangerously-skip-permissions`
- Cons: Process management complexity, parsing CLI output, harder to get structured data
- Complexity: Medium-High

**Approach C: Hybrid (SDK + CLI Fallback)**
- Use SDK for primary operations, fall back to CLI subprocess for features not yet in SDK
- Pros: Best of both worlds, graceful degradation
- Cons: Two integration paths to maintain
- Complexity: High

**Recommendation:** **Approach A (Direct SDK Embedding)** - The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is the officially supported programmatic interface. It provides the same agent loop, tools, and context management as the CLI via the `query()` function with `includePartialMessages: true` for real-time streaming. Starting with SDK-first keeps the architecture clean.

**Critical caveat:** The SDK has a known memory leak in long-running sessions (400MB idle growing to 1-4GB). The server must implement session timeout/restart logic - kill and resume sessions after ~30-60 minutes of continuous use. The SDK's built-in `resume` parameter makes this seamless.

### 5.2 Server Framework

**Option 1: Express.js**
- Pros: Most ecosystem support, massive middleware library, well-understood, TypeScript support
- Cons: Older architecture, callback-based (though async/await works), not the fastest
- Complexity: Low

**Option 2: Fastify**
- Pros: 2-3x faster than Express, schema-based validation, TypeScript-first, plugin architecture
- Cons: Smaller ecosystem, less familiar to most developers
- Complexity: Low-Medium

**Option 3: Hono**
- Pros: Ultra-fast, edge-ready, tiny bundle, TypeScript-first, Express-compatible middleware
- Cons: Newer, smaller community, less battle-tested for long-running server processes
- Complexity: Low

**Recommendation:** **Express.js** - Given this is a local single-user server, performance differences are negligible. Express has the largest ecosystem, best SSE/WebSocket library support, and lowest friction for integration with the Claude Code SDK. The server's bottleneck will be Claude API latency, not framework overhead.

### 5.3 Real-time Communication

**Option 1: Server-Sent Events (SSE)**
- Pros: Simple, HTTP-based, auto-reconnect, works through proxies, one-way streaming (perfect for AI responses)
- Cons: Unidirectional (server→client only), limited to ~6 concurrent connections per domain in HTTP/1.1
- Best for: Streaming AI responses, tool call updates

**Option 2: WebSocket**
- Pros: Full-duplex, low latency, binary support, no connection limit
- Cons: More complex, doesn't auto-reconnect, proxy issues, requires separate protocol handling
- Best for: Interactive tool approval flows, real-time collaboration

**Option 3: Hybrid (REST + SSE)**
- REST for commands (send message, list sessions, get commands)
- SSE for streaming responses (chat completions, tool call progress)
- Pros: Simple client implementation, browser-native, easy debugging
- Cons: Two communication patterns to manage

**Recommendation:** **Hybrid REST + SSE** - Use REST endpoints for discrete operations (create session, send message, list commands) and SSE streams for real-time response streaming. This aligns with how the Vercel AI SDK works (`useChat` uses SSE under the hood) and keeps the architecture simple. WebSocket can be added later if bidirectional needs arise (e.g., tool approval prompts).

### 5.4 Frontend Chat UI

**Option 1: Vercel AI SDK (`ai` + `@ai-sdk/react`)**
- `useChat` hook handles message state, streaming, error handling
- Built-in SSE support, automatic message management
- Works with any backend that follows the AI SDK stream protocol
- Pros: Production-tested, handles streaming complexity, React 19 compatible
- Cons: Opinionated about data format, may need customization for tool calls

**Option 2: Custom Chat Implementation**
- Build chat state management from scratch with TanStack Query + Store
- Pros: Full control, no external dependencies for chat logic
- Cons: Significant boilerplate, need to handle streaming, reconnection, message management

**Option 3: shadcn Chat Components**
- shadcn/ui has a chat component pattern (not official, community)
- Combine with Vercel AI SDK hooks for state management
- Pros: Consistent design system, copy-paste customizable
- Cons: Not a maintained library, just patterns/examples

**Option 4: Vercel AI Elements**
- New open-source library of 20+ React components built on shadcn/ui specifically for AI interfaces
- Includes `<MessageThread>`, `<InputBox>`, `<ToolDisplay>`, `<ReasoningPanel>`, `<StreamingText>`
- Designed to work with Vercel AI SDK hooks
- Pros: Production-ready AI-specific components, handles streaming/tool calls out of the box, shadcn-based styling
- Cons: New library, may not cover all our custom needs (slash commands, permission modes)

**Recommendation:** **Vercel AI SDK (`@ai-sdk/react`) + AI Elements + custom shadcn components** - Use `useChat` for state management, AI Elements for standard chat components (`<MessageThread>`, `<ToolDisplay>`, `<StreamingText>`), and custom shadcn components for LifeOS-specific features (slash command palette, permission toggle, session sidebar). This gives us production-tested streaming + AI-optimized components while retaining full control.

### 5.5 Long Chat Performance

**Strategy: TanStack Virtual + Memoized Markdown Rendering**

1. **TanStack Virtual** for message list virtualization
   - Only render messages in/near the viewport
   - Dynamic row heights (messages vary in length)
   - Smooth scrolling with overscan
   - Critical for sessions with 100+ messages

2. **Vercel Streamdown** (or similar) for markdown rendering
   - Incremental parsing (O(n) vs O(n^2) for traditional parsers)
   - Memoized block rendering (only re-render changed blocks)
   - 2-10x faster than react-markdown for streaming

3. **Message Chunking**
   - Split long messages into blocks for granular virtualization
   - Each code block, paragraph, list rendered as separate virtual item
   - Enables partial message rendering during streaming

4. **TanStack Query** for session/message data
   - Cache session lists and message history
   - Background refetch for session updates
   - Optimistic updates for sent messages

### 5.6 Slash Command Auto-complete

**Implementation Strategy:**
1. Server-side: API endpoint that scans `.claude/commands/` and returns structured command metadata
2. Client-side: Trigger on `/` keystroke in chat input using `cmdk` library (same component that powers shadcn/ui's Command component)
3. UI: Inline floating dropdown (similar to Discord's slash menu) with grouped commands by namespace
4. Filtering: `cmdk`'s built-in fuzzy search on command name + description
5. Metadata: Show description, argument hints, category
6. Keyboard: Arrow keys to navigate, Enter to select, Escape to dismiss (all built into cmdk)

**Command Registry API Response:**
```typescript
interface CommandEntry {
  namespace: string;       // e.g., "daily"
  command: string;         // e.g., "plan"
  fullCommand: string;     // e.g., "/daily:plan"
  description: string;     // From frontmatter
  argumentHint?: string;   // e.g., "[date]"
  category?: string;       // e.g., "planning"
}
```

### 5.7 Session Continuity

**Strategy:**
- The Claude Agent SDK has **built-in session persistence** in `$HOME/.claude` (line-delimited JSON)
- Sessions can be resumed via `query({ options: { resume: sessionId, fork: false } })`
- The `fork: true` option creates a branch from an existing session (useful for "what-if" scenarios)
- Server maintains a session registry mapping WebUI session IDs to SDK session IDs
- Client stores current session ID in localStorage for page reload recovery
- API: `GET /api/sessions` (list), `POST /api/sessions` (create), `POST /api/sessions/:id/messages` (resume + send)
- Session metadata (title, created date, last message preview) stored server-side for the session list UI

### 5.8 TanStack Library Usage

| Library | Use Case | Verdict |
|---------|----------|---------|
| **TanStack Query** | API data fetching, session caching, command list caching | **Use** - Essential for server state |
| **TanStack Virtual** | Virtualizing long message lists | **Use** - Critical for performance |
| **TanStack Store** | Client-side state (UI state, preferences, theme) | **Skip** - Primarily internal to TanStack libs, not widely adopted. Use **Zustand** instead (lightweight, simple API, large community) |
| **TanStack DB** | Client-side reactive database | **Skip for now** - Still in beta, overkill for this use case. Revisit if we need complex client-side data relationships |

### Security Considerations
- Server runs on localhost only (no external exposure by default)
- `--dangerously-skip-permissions` should require explicit opt-in per session
- Tool calls should be logged and visible in the UI
- Hook blocking behavior should be respected and surfaced in the UI
- No auth initially, but API should be designed to add auth later (Bearer token header)

### Performance Considerations
- Claude API latency is the primary bottleneck (~1-3s for first token)
- SSE streaming keeps perceived latency low
- TanStack Virtual prevents DOM bloat from long conversations
- Streamdown/memoized markdown prevents re-parsing overhead
- Message history should be paginated server-side for very long sessions

---

## 6) Clarification

1. **SDK vs CLI:** Should we start with the Claude Code TypeScript SDK (cleaner integration) or the CLI subprocess approach (more battle-tested, guaranteed feature parity)? The SDK is recommended, but if you have experience with the CLI subprocess approach or know the SDK isn't mature enough, that changes the calculus.

2. **Monorepo Structure:** Should the `gateway/` directory be a monorepo with separate `server/` and `client/` packages (with shared types), or a single package with server and client source directories? Monorepo is cleaner for shared types but adds build complexity.

3. **Session Storage:** For persisting sessions across server restarts, should we use:
   - File-based storage (JSON files in `state/`) - simplest
   - SQLite database - more queryable, still local
   - Rely on Claude Code SDK's built-in session management

4. **Permission Mode UX:** When running with `--dangerously-skip-permissions`, should the UI:
   - Show a persistent warning banner (recommended)
   - Require per-session opt-in via a toggle
   - Allow setting it as a default in user preferences

5. **Tool Call Approval:** When a tool call requires user approval (not in skip-permissions mode), should the UI:
   - Show inline approval buttons in the chat stream (like Claude Code CLI)
   - Show a modal/dialog for each approval
   - Show a sidebar panel with pending approvals

6. **Scope of v1:** For the initial version, which features are must-haves vs nice-to-haves?
   - Must-have: Chat + streaming, tool call display, slash command auto-complete, session list/resume
   - Nice-to-have: File tree browser, vault search, agent status tracking, hook debugging panel
   - Future: Dark/light theme sync with vault theme, split-pane editor, MCP server management

7. **Port Configuration:** You specified port 69420 - should this be configurable via environment variable (e.g., `GATEWAY_PORT=69420`) or hardcoded?

8. **Client-Server Split:** Should the Vite dev server proxy to the Express API server, or should Express serve the built React app in production? (Recommendation: Vite proxy in dev, Express serves static build in production)
