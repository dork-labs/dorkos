---
slug: context-builder-agent-refactor
number: 42
created: 2026-02-18
status: ideation
---

# Context Builder & agent-manager.ts Refactor

**Slug:** context-builder-agent-refactor
**Author:** Claude Code
**Date:** 2026-02-18
**Branch:** N/A (iterative improvement)
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Add a `context-builder.ts` service that injects structured runtime context (git status,
  date/time, system info, DorkOS metadata) into every Claude Agent SDK `query()` call via
  `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. Simultaneously refactor
  `agent-manager.ts` (579 lines, exceeds the 500-line hard limit) so every resulting file is under
  300 lines.
- **Assumptions:**
  - Context is built per `sendMessage()` call — each user turn gets fresh, up-to-date git status
  - The `claude_code` preset is the only SDK preset; no alternatives to evaluate
  - "DorkOS info" = product name, version, server port — not session counts (too dynamic/noisy)
  - "System info" = OS platform, OS version, Node.js version, hostname — not hardware metrics
  - Refactor is purely structural: zero behavior changes, all tests remain green
  - The existing `git-status.ts` service is reused directly (not duplicated)
- **Out of scope:**
  - `UserPromptSubmit` / `SessionStart` hooks for context injection (systemPrompt.append is simpler
    and sufficient; hooks have a known multi-injection bug)
  - Caching/debouncing git calls (per-turn freshness is the goal; git status is fast)
  - Client-side changes of any kind
  - Exposing context as an MCP tool (future consideration)

---

## 2) Pre-reading Log

- `apps/server/src/services/agent-manager.ts`: 579 lines. Five logical sections clearly separable.
  Missing `systemPrompt` entirely — SDK uses only a minimal default prompt (no Claude Code guidelines).
- `apps/server/src/services/git-status.ts`: 124 lines. `getGitStatus(cwd)` already returns structured
  `GitStatusResponse | GitStatusError`. Reusable directly in context-builder with no modifications.
- `apps/server/src/services/interactive-handlers.ts`: 105 lines. Tool approval & question flows.
  `PendingInteraction` type defined here — could be co-located with `AgentSession` in a types file.
- `apps/server/src/services/session-lock.ts`: 103 lines. Already extracted, delegated from AgentManager.
- `apps/server/src/services/mcp-tool-server.ts`: 124 lines. In-process MCP server — could eventually
  expose context-builder as a tool for agents to pull fresh context on demand.
- `apps/server/src/routes/sessions.ts`: Calls all public AgentManager methods — no changes needed if
  agent-manager's public API stays identical.
- `.claude/rules/file-size.md`: Confirms 300-line ideal, 500+ = must split.
- Claude Code SDK source (claude_code preset): Uses an `<env>` XML block with key-value pairs for
  platform, OS version, working directory, git repo status, current date, git branch, recent commits.
  This is the format we should mirror in our `append` string.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/agent-manager.ts` — 579 lines, to be split into 4 files
- `apps/server/src/services/git-status.ts` — 124 lines, reused by context-builder
- `apps/server/src/services/interactive-handlers.ts` — 105 lines, `PendingInteraction` type may move
- `apps/server/src/index.ts` — Creates AgentManager singleton; no changes needed

**New Files to Create:**

- `apps/server/src/services/context-builder.ts` — Runtime context gathering and formatting (~100 lines)
- `apps/server/src/services/sdk-event-mapper.ts` — `mapSdkMessage()` extraction (~140 lines)
- `apps/server/src/lib/sdk-utils.ts` — `resolveClaudeCliPath()` + `makeUserPrompt()` (~40 lines)
- `apps/server/src/services/agent-types.ts` — `AgentSession`, `ToolState` interfaces (~35 lines)

**Shared Dependencies:**

- `@dorkos/shared/types` — `GitStatusResponse`, `GitStatusError`, `StreamEvent`, `PermissionMode`
- `@anthropic-ai/claude-agent-sdk` — `query`, `Options`, `SDKMessage`, `PermissionResult`, `Query`
- Node.js stdlib: `os`, `path`, `url`, `child_process` (all already available)
- `apps/server/src/lib/logger.ts` — Used by context-builder for debug output
- `apps/server/src/lib/boundary.ts` — Used transitively via git-status.ts

**Data Flow:**

```
sendMessage(sessionId, content, opts)
  → buildRuntimeContext(effectiveCwd)         ← NEW: context-builder.ts
    → getGitStatus(cwd)                       ← existing: git-status.ts
    → os.platform(), os.release()             ← Node.js stdlib
    → process.env.DORKOS_VERSION, PORT        ← env vars
  → formatContextAsSystemPrompt(context)      ← NEW: context-builder.ts
  → sdkOptions.systemPrompt = { preset, append }
  → query({ prompt: makeUserPrompt(content), options: sdkOptions })
    → sdkIterator yields SDKMessage events
      → mapSdkMessage(message, ...)           ← EXTRACTED: sdk-event-mapper.ts
        → yields StreamEvent
```

**Potential Blast Radius:**

- Direct changes: `agent-manager.ts` (split), new files created
- Import updates: All test files for agent-manager (3 test files)
- No route changes: `sessions.ts` imports only `agentManager` singleton — public API unchanged
- No client changes
- New test files needed: `context-builder.test.ts`, `sdk-event-mapper.test.ts`, `sdk-utils.test.ts`

---

## 4) Root Cause Analysis

N/A — This is not a bug fix. The motivating issue is:
1. `agent-manager.ts` violates the 500-line hard limit at 579 lines
2. The SDK is using only a minimal system prompt (no Claude Code guidelines injected)

---

## 5) Research

### Topic 1: Context Format

**Key finding:** Claude Code itself uses an `<env>` XML block in its own system prompt. The format is
structured key-value pairs within XML tags, plus a separate `gitStatus` section with actual modified
filenames and recent commits. This is exactly what our `append` string should mirror.

**Format rationale:** XML tags are Anthropic's own recommendation for Claude prompt structure and
research confirms XML "consistently outperforms" JSON and matches Markdown for Claude's tokenizer.
Key-value within XML mirrors Claude Code's own `<env>` block exactly.

**Recommended `append` structure:**

```
<env>
Working directory: /path/to/project
Product: DorkOS
Version: 0.5.1
Port: 4242
Platform: darwin
OS Version: macOS 15.2
Node.js: v22.14.0
Date: 2026-02-18T14:30:00-08:00
</env>

<git_status>
Is git repo: true
Current branch: feat/my-feature
Main branch (use for PRs): main
Ahead of origin: 2 commits
Working tree: dirty (2 modified, 1 staged, 3 untracked, 0 conflicted)
Modified files:
  M apps/server/src/services/agent-manager.ts
  A apps/server/src/services/sdk-event-mapper.ts
</git_status>
```

**What to include (Tier 1 — always):**
- Current date/time (ISO 8601 with timezone) — model uses this for version recency reasoning
- OS platform + coarse version — affects shell commands (brew vs apt), path conventions
- Node.js version — affects API availability (`--env-file` needs Node 20.6+, etc.)
- Git branch + main branch name — model needs both to target correct PR base
- Git dirty state counts + **actual modified filenames** — filenames let the model see which files
  are in-flight and avoid overwriting human work (Claude Code injects these; we should too)
- Whether directory is a git repo — prevents git commands in non-git dirs
- DorkOS product name + version — helps model self-reference in docs/messages

**What to include (Tier 2 — conditionally):**
- Ahead/behind counts — only when `ahead > 0 || behind > 0` (surface as human-readable text:
  "2 commits ahead of origin")
- Detached HEAD flag — only when true; orphaned commits are a real risk

**What to exclude (noise):**
- Recent commit log — Claude Code's `claude_code` preset already injects this; duplicating wastes
  tokens. (See clarification #1 below.)
- Hardware metrics (CPU, memory, disk) — not actionable for coding agents
- Hostname, remote URL, stash count — low signal, potential security/privacy exposure
- Session count — too dynamic, not actionable
- Full file tree — agent explores on demand via Glob/LS tools

### Topic 2: agent-manager.ts Refactor Strategy

**Recommended split (Functional Core / Imperative Shell pattern):**

The key insight: `mapSdkMessage()` is a **pure transformation function** (functional core).
`AgentManager.sendMessage()` is the **imperative shell** (session state, side effects, streaming loop).
Separating them is both philosophically correct and gets us well under the 300-line target.

**Research verdict:** Extract `mapSdkMessage()` first (highest ROI). Then extract the small utilities
(`resolveClaudeCliPath`, `makeUserPrompt`, `AgentSession` type) to bring the core file under 300 lines.
Do NOT extract the streaming loop — the `Promise.race` concurrency pattern must stay intact.

**Anti-patterns to avoid:**
- Don't split `sendMessage()` itself — the event loop + iterator race is a tightly coupled state machine
- Don't create a `SdkEventMapper` class — `export async function*` is the right shape for a pure generator
- Don't barrel re-export extracted internals through `agent-manager.ts` — only the public class is the contract
- Don't make `ToolState` a class — it's a mutable tracking struct for the loop; keep it a plain interface

**Extraction decisions:**

| Extract? | What | Why |
|----------|------|-----|
| ✅ Yes | `mapSdkMessage()` → `sdk-event-mapper.ts` | Pure async generator, ~130 lines, fully unit-testable |
| ✅ Yes | `resolveClaudeCliPath()` + `makeUserPrompt()` → `lib/sdk-utils.ts` | Pure utilities, no class deps |
| ✅ Yes | `AgentSession`, `ToolState` interfaces → `agent-types.ts` | Needed by both agent-manager + event-mapper |
| ✅ Yes | Runtime context → `context-builder.ts` | New feature, entirely orthogonal responsibility |
| ❌ No | `sendMessage()` streaming loop | Tightly coupled concurrency pattern; splitting harms debuggability |
| ❌ No | `AgentManager` class methods | Class cohesion; ~200 lines after removals, well within 300 |
| ❌ No | Session store (ensureSession, checkHealth) | Defer; in-memory Map is appropriately simple today |

### Recommendation

Use `systemPrompt: { type: 'preset', preset: 'claude_code', append: buildRuntimeContext() }` in
`sendMessage()`, mirroring Claude Code's own `<env>` XML format. Split `agent-manager.ts` into 4
focused files, each under 300 lines, with `agent-manager.ts` as the thin orchestrator at ~240 lines.

---

## 6) File Size Projections After Refactor

| File | Before | After | Status |
|------|--------|-------|--------|
| `agent-manager.ts` | 579 | ~240 | ✅ Under 300 |
| `sdk-event-mapper.ts` | — | ~140 | ✅ New, under 300 |
| `lib/sdk-utils.ts` | — | ~40 | ✅ New, under 300 |
| `agent-types.ts` | — | ~35 | ✅ New, under 300 |
| `context-builder.ts` | — | ~100 | ✅ New, under 300 |

---

## 7) Clarification

1. **Recent git commits in context?** — Claude Code's `claude_code` preset already injects recent
   commit history. Should our `append` also include it (risking duplication) or explicitly skip it?
   *Recommendation: skip — trust the preset, avoid token waste.*

2. **Hostname in context?** — Low signal for most coding tasks. Include or exclude?
   *Recommendation: include (it's one line, helps with multi-machine debugging).*

3. **DorkOS version format** — `process.env.DORKOS_VERSION` may be undefined in dev mode (the CLI
   sets it but `npm run dev` doesn't). Should we fall back to reading from `packages/cli/package.json`
   or use a `"development"` sentinel?
   *Recommendation: `DORKOS_VERSION ?? 'development'` — consistent with `mcp-tool-server.ts`.*

4. **`agent-types.ts` location** — Should it live in `services/agent-types.ts` (alongside other
   services) or `types/agent.ts` (in a dedicated types directory)? The server currently has no
   `types/` directory.
   *Recommendation: `services/agent-types.ts` — consistent with server's flat structure.*

5. **Test coverage expectation** — Should new files (`context-builder.ts`, `sdk-event-mapper.ts`,
   `sdk-utils.ts`) get full test coverage before this spec is considered done?
   *Recommendation: yes — `context-builder` and `sdk-event-mapper` are independently testable and
   worth testing; `sdk-utils` is trivial enough to skip.*
