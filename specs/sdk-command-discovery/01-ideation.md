---
slug: sdk-command-discovery
number: 133
created: 2026-03-15
status: ideation
---

# SDK-Based Command Discovery

**Slug:** sdk-command-discovery
**Author:** Claude Code
**Date:** 2026-03-15
**Branch:** preflight/sdk-command-discovery
**Related:** Spec #19 (Improve Slash Command System) — complementary, not superseding

---

## 1) Intent & Assumptions

**Task brief:** Switch slash command discovery from our own filesystem scanner (`CommandRegistryService`) to the Claude Agent SDK's programmatic `supportedCommands()` API as the primary source, supplemented by filesystem metadata. Establish an extensible architecture so future runtimes (OpenCode, Codex, etc.) can provide commands through their own discovery mechanisms.

**Assumptions:**

- The Claude Agent SDK's `Query.supportedCommands()` and `initializationResult().commands` APIs are stable and return built-in commands, custom commands, and skills
- The SDK returns `SlashCommand { name, description, argumentHint }` — less metadata than our scanner's `CommandEntry` (which also has `namespace`, `allowedTools`, `filePath`)
- We only implement Claude Code's SDK-based discovery now; other runtimes are designed-for but not built
- Spec #19's UI/UX improvements (fuzzy matching, cwd-aware caching, trigger regex) are fully implemented and remain unchanged
- The `AgentRuntime.getCommands()` interface already supports multi-runtime — each runtime owns its discovery strategy

**Out of scope:**

- Implementing command discovery for non-Claude-Code runtimes (OpenCode, Cursor, Codex)
- Changing the client-side command palette UI, autocomplete, or keyboard navigation
- Adding new frontmatter fields or command formats
- The emerging "skills" system (`.claude/skills/`) — the SDK handles this transparently
- Changing how Claude Code interprets/expands slash commands at execution time

---

## 2) Pre-reading Log

- `packages/shared/src/agent-runtime.ts:247`: `getCommands(forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry>` — the interface contract, already runtime-agnostic
- `apps/server/src/services/runtimes/claude-code/command-registry.ts`: Full filesystem scanner — reads `.claude/commands/{ns}/{cmd}.md`, parses YAML frontmatter via `gray-matter`, 5-min cache TTL. 116 lines.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts:412-425`: `getCommands()` manages per-CWD `CommandRegistryService` instances with LRU eviction (max 50)
- `apps/server/src/services/runtimes/claude-code/message-sender.ts:195-235`: `supportedModels()` and `mcpServerStatus()` are already fetched non-blocking from SDK queries — but `supportedCommands()` is **never called**
- `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts:7-25`: Init message includes `slash_commands: []` (empty array in mocks) — the field exists but is unused
- `apps/server/src/routes/commands.ts`: Thin route, already delegates to `runtime.getCommands()` — zero changes needed here
- `packages/shared/src/schemas.ts:392-413`: `CommandEntrySchema` has `namespace`, `command`, `fullCommand`, `description`, `argumentHint`, `allowedTools`, `filePath` — more fields than SDK provides
- `packages/shared/src/transport.ts:139-140`: Transport interface `getCommands(refresh?, cwd?)` — unchanged
- `apps/client/src/layers/entities/command/model/use-commands.ts`: React Query hook with `['commands', { cwd }]` key — unchanged
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts:154-156`: TestModeRuntime stubs `getCommands()` with empty result
- `research/20260315_agent_sdk_slash_command_discovery_api.md`: SDK exposes three command discovery mechanisms
- `research/20260315_slash_command_storage_formats_competitive.md`: Industry analysis of 6 tools — all use markdown + frontmatter in `.<tool>/commands/`, filesystem scan is universal, Claude Code has the only programmatic API

---

## 3) Codebase Map

**Primary Components/Modules:**

| Path | Role |
|---|---|
| `packages/shared/src/agent-runtime.ts` | `AgentRuntime` interface — `getCommands()` at line 247 |
| `packages/shared/src/schemas.ts` | `CommandEntrySchema`, `CommandRegistrySchema` (lines 392-413) |
| `apps/server/src/services/runtimes/claude-code/command-registry.ts` | Filesystem scanner (116 lines) — **primary change target** |
| `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` | Per-CWD registry management (lines 412-425) — **primary change target** |
| `apps/server/src/services/runtimes/claude-code/message-sender.ts` | SDK query execution — already calls `supportedModels()`, pattern to follow |
| `apps/server/src/routes/commands.ts` | HTTP endpoint — delegates to runtime, **no changes needed** |

**Shared Dependencies:**

- `gray-matter` — YAML frontmatter parsing (only used by `CommandRegistryService`)
- `@anthropic-ai/claude-agent-sdk` — confined to `services/runtimes/claude-code/`
- TanStack Query — client-side caching with cwd-scoped keys

**Data Flow (current):**

```
Server startup
  → ClaudeCodeRuntime created
  → No command pre-fetch

GET /api/commands?cwd=/path
  → runtime.getCommands(false, "/path")
  → CommandRegistryService("/path") scans .claude/commands/
  → Returns CommandRegistry with namespace/command/description/allowedTools/filePath

Client mount
  → useCommands(cwd) → transport.getCommands() → GET /api/commands?cwd=...
  → CommandPalette renders grouped by namespace
```

**Data Flow (proposed):**

```
First SDK query per session
  → executeSdkQuery() calls query.supportedCommands() non-blocking
  → Cache SlashCommand[] on ClaudeCodeRuntime (keyed by cwd)

GET /api/commands?cwd=/path
  → runtime.getCommands(false, "/path")
  → Return cached SDK commands (includes built-ins + custom + skills)
  → Optionally supplement with filesystem scan for allowedTools/filePath metadata

Client: unchanged
```

**Potential Blast Radius:**

- Direct: 2-3 files (ClaudeCodeRuntime, CommandRegistryService, message-sender or new command-fetcher)
- Schema: 0-1 files (CommandEntrySchema may need optional fields for SDK-only commands)
- Route: 0 files
- Client: 0 files
- Tests: 2-3 files (SDK scenarios, runtime tests, route tests)

---

## 4) Root Cause Analysis

N/A — this is a feature/architecture change, not a bug fix.

---

## 5) Research

### SDK Command Discovery API (Claude Agent SDK)

Three mechanisms exist, all returning the same data:

| Mechanism | Returns | When Available | Metadata |
|---|---|---|---|
| `query.supportedCommands()` | `SlashCommand[]` | Before streaming starts | `name`, `description`, `argumentHint` |
| `query.initializationResult()` | `SDKControlInitializeResponse` | After init completes | `.commands: SlashCommand[]` + models, account info |
| Init system message | `slash_commands: string[]` | First message in stream | Names only — no metadata |

The SDK returns **all** command types: built-in (`/compact`, `/help`, `/clear`), custom (`.claude/commands/`), user-level (`~/.claude/commands/`), and skills (`.claude/skills/`). Our filesystem scanner only finds project-level custom commands.

### Competitive Landscape

| Tool | Discovery | Programmatic API | Format |
|---|---|---|---|
| **Claude Code** | `.claude/commands/` + SDK API | Yes (3 methods) | MD + YAML frontmatter |
| **OpenCode** | `.opencode/commands/` | No | MD + YAML frontmatter |
| **Cursor** | `.cursor/commands/` | No | MD (no frontmatter spec) |
| **Codex CLI** | `~/.codex/prompts/` | No | MD + YAML frontmatter |
| **Windsurf** | `.windsurf/workflows/` | No | MD (no frontmatter) |
| **Continue.dev** | `.continue/prompts/` | No | MD + YAML frontmatter |

Claude Code is the **only** tool with a programmatic discovery API. Every other tool relies exclusively on filesystem scanning. DorkOS is uniquely positioned to use both — the SDK for authoritative command lists and the scanner for supplementary metadata.

### Approach Comparison

**1. SDK Primary, Scanner Supplements (Recommended)**

- Use `supportedCommands()` as the authoritative source
- Enrich with filesystem metadata (`allowedTools`, `filePath`, `namespace`) where available
- Pros: Complete command list (built-ins + skills + user-level), authoritative, forward-compatible
- Cons: Requires an active SDK query context (session or pre-session), slightly more complex merging logic
- Complexity: Medium
- Maintenance: Low — SDK handles format changes

**2. Replace Scanner Entirely**

- Delete `CommandRegistryService`, use only SDK
- Pros: Simplest code, single source of truth
- Cons: Lose `allowedTools` and `filePath` metadata, lose ability to list commands without a session
- Complexity: Low
- Maintenance: Low

**3. Keep Scanner as Primary, SDK for Built-ins Only**

- Filesystem scanner stays as-is, SDK only adds built-in commands
- Pros: Minimal change, preserves all existing metadata
- Cons: Still miss user-level commands (`~/.claude/commands/`), still miss skills, duplicated discovery
- Complexity: Low
- Maintenance: High — must track SDK format changes independently

**4. Dual Source with Deduplication**

- Fetch from both SDK and filesystem, deduplicate by command name, prefer SDK for conflicts
- Pros: Maximum metadata, handles offline/pre-session gracefully
- Cons: Complex merging, potential inconsistencies
- Complexity: High
- Maintenance: Medium

### Multi-Runtime Design Pattern

The `AgentRuntime` interface already defines `getCommands()`. Each runtime implements its own discovery:

```
AgentRuntime.getCommands(forceRefresh?, cwd?)
  ├── ClaudeCodeRuntime  → SDK supportedCommands() + optional filesystem enrichment
  ├── OpenCodeRuntime    → scan .opencode/commands/, parse frontmatter (agent, model, subtask)
  ├── CursorRuntime      → scan .cursor/commands/, freeform markdown
  └── TestModeRuntime    → empty stub
```

No shared `CommandRegistryService` needed — each runtime knows its own command format and discovery mechanism. The `CommandEntry` schema in shared is the **output** contract, not the discovery mechanism.

### Key Insight: Session Requirement

The SDK's `supportedCommands()` requires a `Query` object. Currently, queries are only created when sending messages. Options:

1. **Lazy fetch on first query** — follow the `supportedModels()` pattern in `message-sender.ts` (lines 195-210), which fires a non-blocking fetch on the first `executeSdkQuery()` call
2. **Pre-session probe** — create a lightweight query at startup just to fetch commands and models
3. **Fallback to scanner** — use SDK when available, fall back to filesystem scanner when no session exists yet

Option 1 aligns with existing patterns (`supportedModels()` does exactly this). Option 3 provides the best UX — commands are available immediately from the scanner, then upgraded with SDK data once a session starts.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Relationship to spec #19 | Complement | Spec #19 addressed UI/UX (regex, fuzzy matching, cwd caching) — fully implemented. This spec addresses the command *source* and multi-runtime architecture. Orthogonal concerns. |
| 2 | Multi-runtime scope | Extensible architecture only | Design the interface so future runtimes CAN provide commands differently, but only implement Claude Code's SDK-based discovery now. YAGNI for OpenCode/Cursor until we add those runtimes. |
| 3 | Scanner fate | SDK primary, scanner supplements | Use SDK `supportedCommands()` as the authoritative source (includes built-ins, skills, user-level commands). Supplement with filesystem scan for extra metadata (`allowedTools`, `filePath`) the SDK doesn't provide. Best of both worlds. |
| 4 | Session requirement strategy | Lazy fetch + scanner fallback | Follow the existing `supportedModels()` pattern — fetch from SDK non-blocking on first query. Before any session exists, fall back to filesystem scanner for immediate command availability. |
| 5 | Schema changes | Make enrichment fields optional | `allowedTools` and `filePath` are already optional in `CommandEntrySchema`. `namespace` should also become optional — SDK commands won't always have a namespace (built-ins like `/compact` are flat). |
