---
slug: context-builder-agent-refactor
number: 42
created: 2026-02-18
status: specified
---

# Specification: Context Builder & agent-manager.ts Refactor

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-18

---

## Overview

Two tightly coupled improvements to `apps/server/src/services/`:

1. **Context Builder** — A new `context-builder.ts` service that builds structured runtime context (git status, date/time, system info, DorkOS metadata) and injects it into every `query()` call via `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }`. This also activates the full Claude Code system prompt, which is currently not configured.

2. **agent-manager.ts Refactor** — The file is 579 lines, violating the 500-line hard limit. It is split into four focused sub-modules, each under 300 lines, with `agent-manager.ts` becoming a lean orchestrator.

---

## Background / Problem Statement

`AgentManager.sendMessage()` calls the Claude Agent SDK's `query()` function with no `systemPrompt` option. The SDK therefore uses a minimal default prompt — the full Claude Code guidelines, tool instructions, environment awareness, and coding best practices are never activated. Every DorkOS session operates with a degraded agent context.

Separately, `agent-manager.ts` at 579 lines exceeds the project's 500-line hard limit (`.claude/rules/file-size.md`). The file has multiple extractable responsibilities that warrant dedicated modules.

---

## Goals

- Activate the full `claude_code` system prompt preset on every agent session
- Inject structured, fresh runtime context (cwd, git status, OS, date, DorkOS info) on every user turn
- Bring `agent-manager.ts` and all resulting files under 300 lines
- Enable isolated unit testing of the SDK event mapping and context building logic
- Zero behavior change to any existing functionality

---

## Non-Goals

- Modifying `git-status.ts` or extending `GitStatusResponse` with filenames
- Injecting recent git commits (the `claude_code` preset already includes them)
- Caching or debouncing context-building calls
- Client-side changes of any kind
- Session store extraction or persistence (future concern)
- Hook-based context injection (`SessionStart`, `UserPromptSubmit`)

---

## Technical Dependencies

| Dependency | Version | Notes |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | current | `Options.systemPrompt` with `preset: 'claude_code'` |
| Node.js `os` module | built-in | `platform()`, `release()`, `hostname()` |
| `services/git-status.ts` | internal | `getGitStatus(cwd)` reused as-is |
| `lib/boundary.ts` | internal | Transitively used by `git-status.ts` |

---

## Detailed Design

### File Structure After Refactor

```
apps/server/src/
├── lib/
│   └── sdk-utils.ts              # NEW (~40 lines): makeUserPrompt, resolveClaudeCliPath
├── services/
│   ├── agent-types.ts            # NEW (~35 lines): AgentSession, ToolState interfaces
│   ├── agent-manager.ts          # REFACTORED (~240 lines): AgentManager class, singleton
│   ├── sdk-event-mapper.ts       # NEW (~140 lines): mapSdkMessage() pure async generator
│   ├── context-builder.ts        # NEW (~100 lines): buildSystemPromptAppend()
│   ├── git-status.ts             # UNCHANGED
│   ├── interactive-handlers.ts   # UNCHANGED
│   ├── session-lock.ts           # UNCHANGED
│   └── build-task-event.ts       # UNCHANGED
```

### 1. `agent-types.ts` (NEW, ~35 lines)

Extracted from `agent-manager.ts`. Contains the shared interface types needed by both `agent-manager.ts` and `sdk-event-mapper.ts`.

```typescript
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, PermissionMode } from '@dorkos/shared/types';
import type { PendingInteraction } from './interactive-handlers.js';

export interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  permissionMode: PermissionMode;
  model?: string;
  cwd?: string;
  hasStarted: boolean;
  activeQuery?: Query;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
}

export interface ToolState {
  inTool: boolean;
  currentToolName: string;
  currentToolId: string;
  taskToolInput: string;
  appendTaskInput: (chunk: string) => void;
  resetTaskInput: () => void;
  setToolState: (tool: boolean, name: string, id: string) => void;
}
```

### 2. `lib/sdk-utils.ts` (NEW, ~40 lines)

Two pure utility functions extracted from `agent-manager.ts`. No class, no state.

**`makeUserPrompt(content: string)`** — Wraps a plain string in the `AsyncIterable<SDKUserMessage>` form required by the SDK when `mcpServers` is present. Safe to use unconditionally.

**`resolveClaudeCliPath()`** — Resolves the Claude Code CLI path. Tries SDK bundled path, then `PATH` lookup, then returns `undefined` for SDK default resolution.

```typescript
export async function* makeUserPrompt(content: string) { ... }
export function resolveClaudeCliPath(): string | undefined { ... }
```

### 3. `sdk-event-mapper.ts` (NEW, ~140 lines)

The `mapSdkMessage()` private method extracted from `AgentManager` as a standalone pure async generator. This is the **functional core** — given an SDK message, yield DorkOS `StreamEvent` objects.

**Key constraints:**
- Exported as `export async function* mapSdkMessage(...)` — no class wrapper
- `ToolState` is passed in by reference (mutable struct owned by the caller's streaming loop)
- Does not touch I/O, the SDK iterator, or the session Map

```typescript
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from './agent-types.js';
import { buildTaskEvent, TASK_TOOL_NAMES } from './build-task-event.js';
import { logger } from '../lib/logger.js';

export async function* mapSdkMessage(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState
): AsyncGenerator<StreamEvent> {
  // ... handles: system/init, stream_event (content_block_*), tool_use_summary, result
}
```

**Handled message types:**

| SDK message type | Output StreamEvents |
|---|---|
| `system/init` | `session_status` (with model) |
| `stream_event/content_block_start` (tool_use) | `tool_call_start` |
| `stream_event/content_block_delta` (text) | `text_delta` |
| `stream_event/content_block_delta` (input_json) | `tool_call_delta` |
| `stream_event/content_block_stop` | `tool_call_end`, optional `task_update` |
| `tool_use_summary` | `tool_result` per preceding tool use |
| `result` | `session_status` (with cost/tokens), `done` |

### 4. `agent-manager.ts` (REFACTORED, ~240 lines)

After extractions, `AgentManager` retains its complete public API with no changes. Internally it imports from the new modules.

**Retained methods:** `constructor`, `setMcpServers()`, `ensureSession()`, `sendMessage()`, `updateSession()`, `approveTool()`, `submitAnswers()`, `checkSessionHealth()`, `findSession()`, lock delegation methods, singleton export.

**Critical invariant:** The `Promise.race` event loop inside `sendMessage()` is **not modified**. This concurrency pattern races the SDK iterator against the event queue to allow mid-stream tool approvals. It is a tightly coupled state machine that must stay intact.

**New integration:** Context building is added at the start of `sendMessage()`:

```typescript
async *sendMessage(sessionId, content, opts?) {
  // ... existing session setup, boundary validation ...

  const effectiveCwd = session.cwd ?? this.cwd;
  // NEW: build context append before sdkOptions
  const systemPromptAppend = await buildSystemPromptAppend(effectiveCwd);

  const sdkOptions: Options = {
    cwd: effectiveCwd,
    includePartialMessages: true,
    settingSources: ['project', 'user'],
    systemPrompt: {           // NEW
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    },
    ...(this.claudeCliPath ? { pathToClaudeCodeExecutable: this.claudeCliPath } : {}),
  };

  // ... rest of sendMessage unchanged ...
}
```

### 5. `context-builder.ts` (NEW, ~100 lines)

Builds a fresh context string on every invocation. Never throws — all errors result in partial context (git failures produce `Is git repo: false`).

**Exported API:**
```typescript
export async function buildSystemPromptAppend(cwd: string): Promise<string>
```

**Output format** — XML key-value blocks mirroring Claude Code's own `<env>` structure:

```
<env>
Working directory: /Users/alice/my-project
Product: DorkOS
Version: 0.5.1
Port: 4242
Platform: darwin
OS Version: Darwin 25.2.0
Node.js: v22.14.0
Hostname: macbook-pro.local
Date: 2026-02-18T14:30:00.000Z
</env>

<git_status>
Is git repo: true
Current branch: feat/my-feature
Main branch (use for PRs): main
Ahead of origin: 2 commits
Working tree: dirty (2 modified, 1 staged, 3 untracked, 0 conflicted)
</git_status>
```

**`<env>` block fields (always present):**

| Field | Source | Notes |
|---|---|---|
| `Working directory` | `cwd` parameter | Absolute path |
| `Product` | Hardcoded `"DorkOS"` | |
| `Version` | `process.env.DORKOS_VERSION ?? 'development'` | |
| `Port` | `process.env.DORKOS_PORT ?? '4242'` | |
| `Platform` | `os.platform()` | `darwin`, `linux`, `win32` |
| `OS Version` | `os.release()` | Kernel release string |
| `Node.js` | `process.version` | e.g. `v22.14.0` |
| `Hostname` | `os.hostname()` | |
| `Date` | `new Date().toISOString()` | ISO 8601 UTC |

**`<git_status>` block — non-git directory:**
```
<git_status>
Is git repo: false
</git_status>
```

**`<git_status>` block — git directory fields:**

| Field | Condition | Source |
|---|---|---|
| `Is git repo` | Always | `true` |
| `Current branch` | Always | `GitStatusResponse.branch` |
| `Main branch (use for PRs)` | Always | Hardcoded `main` |
| `Ahead of origin: N commits` | Only when `ahead > 0` | `GitStatusResponse.ahead` |
| `Behind origin: N commits` | Only when `behind > 0` | `GitStatusResponse.behind` |
| `Detached HEAD: true` | Only when `detached === true` | `GitStatusResponse.detached` |
| `Working tree: clean` | When all counts are 0 | `GitStatusResponse.clean` |
| `Working tree: dirty (...)` | When any count > 0 | Counts with >0 shown only |

**Working tree dirty format example:**
```
Working tree: dirty (2 modified, 1 staged, 3 untracked)
```
(Only non-zero counts appear in the parenthetical.)

**`git_status` is explicitly excluded from including:**
- Recent commits / git log (the `claude_code` preset already includes these)
- Remote URL
- Stash count
- File names (GitStatusResponse has counts only; not extended in this spec)

**Error handling:**
```typescript
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envBlock, gitBlock] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
  ]);
  // Always returns a string, never throws
  return [
    envBlock.status === 'fulfilled' ? envBlock.value : '',
    gitBlock.status === 'fulfilled' ? gitBlock.value : '',
  ].filter(Boolean).join('\n\n');
}
```

---

## Data Flow

```
HTTP POST /api/sessions/:id/messages
  └── routes/sessions.ts
       └── agentManager.sendMessage(sessionId, content)
            ├── buildSystemPromptAppend(effectiveCwd)    ← context-builder.ts
            │    ├── buildEnvBlock(cwd)                  ← os module + process.env
            │    └── buildGitBlock(cwd)                  ← git-status.ts
            ├── query({ prompt: makeUserPrompt(content), ← lib/sdk-utils.ts
            │           options: { systemPrompt: {
            │             type: 'preset',
            │             preset: 'claude_code',
            │             append: contextString
            │           }, ... } })
            └── for await sdkMessage of agentQuery
                 └── mapSdkMessage(message, ...)          ← sdk-event-mapper.ts
                      └── yields StreamEvent → SSE → client
```

---

## API Changes

None. `AgentManager`'s public API is unchanged:
- `ensureSession()`, `sendMessage()`, `updateSession()`, `approveTool()`, `submitAnswers()`
- `checkSessionHealth()`, `hasSession()`, `getSdkSessionId()`
- `acquireLock()`, `releaseLock()`, `isLocked()`, `getLockInfo()`
- `agentManager` singleton export

Routes (`sessions.ts`, `config.ts`) require no changes.

---

## Testing Strategy

### New: `context-builder.test.ts`

Mock targets: `vi.mock('../../services/git-status.js')`, `vi.mock('node:os')`, `process.env` via `vi.stubEnv`.

**Test cases:**

| Test | Purpose |
|---|---|
| Returns string containing `<env>` block | Verifies basic structure |
| `<env>` contains all required fields | Field presence |
| `Date` field is valid ISO 8601 | Format validation |
| `Version` defaults to `'development'` when env unset | Fallback behavior |
| `<git_status>` shows `Is git repo: false` for non-git dirs | Error path |
| `<git_status>` shows branch when git repo | Happy path |
| `Ahead of origin` line omitted when ahead=0 | Conditional field |
| `Ahead of origin` shown when ahead>0 | Conditional field |
| `Working tree: clean` when all counts zero | Clean state |
| `Working tree: dirty` shows only non-zero counts | Count filtering |
| `Detached HEAD` shown only when detached | Conditional field |
| Git failure → still returns env block (no throw) | Error resilience |

### New: `sdk-event-mapper.test.ts`

Mock targets: `vi.mock('../build-task-event.js')`, `vi.mock('../../lib/logger.js')`.

**Test cases:**

| Test | Purpose |
|---|---|
| `system/init` → emits `session_status` with model | Init message handling |
| `system/init` → sets `session.sdkSessionId` | Session ID assignment |
| `content_block_start` (tool_use) → emits `tool_call_start` | Tool start |
| `content_block_delta` (text_delta, not in tool) → emits `text_delta` | Text streaming |
| `content_block_delta` (input_json, in tool) → emits `tool_call_delta` | Tool input streaming |
| `content_block_stop` (in tool) → emits `tool_call_end` | Tool end |
| Task tool stop → also emits `task_update` | Task event building |
| `tool_use_summary` → emits `tool_result` per tool ID | Summary handling |
| `result` → emits `session_status` + `done` | Result handling |
| `result` with usage → includes cost and token counts | Usage fields |
| Unknown message type → yields nothing, no throw | Unknown message safety |

### Updated: `agent-manager.test.ts`

- Remove tests for `resolveClaudeCliPath` (moved to `sdk-utils.test.ts`)
- Remove tests for `mapSdkMessage` (moved to `sdk-event-mapper.test.ts`)
- Add: `sendMessage()` calls `buildSystemPromptAppend` and sets `sdkOptions.systemPrompt`
- Add: Verify `sdkOptions.systemPrompt.type === 'preset'` and `preset === 'claude_code'`
- Existing streaming, approval, and locking tests remain unchanged

### Optional: `sdk-utils.test.ts`

Trivial — `makeUserPrompt` yields one object; `resolveClaudeCliPath` returns string or undefined. Low priority.

---

## Performance Considerations

- `getGitStatus()` runs `git status --porcelain=v1 --branch` with a configured timeout (`GIT.STATUS_TIMEOUT_MS`). This is already called by the git route on every request — no new subprocess overhead concern.
- `buildSystemPromptAppend()` runs on every `sendMessage()`. The `Promise.allSettled` parallelizes the env block and git block. Total overhead is bounded by `GIT.STATUS_TIMEOUT_MS`.
- The context string is a few hundred bytes — negligible token overhead relative to the full `claude_code` preset.

---

## Security Considerations

- `process.env` fields included in context (`DORKOS_VERSION`, `DORKOS_PORT`) are non-sensitive server config. No secrets or credentials are injected.
- `os.hostname()` is included. This is acceptable for a local/self-hosted tool; it does not create a cross-origin or auth concern.
- The context string is passed as part of the system prompt to Anthropic's API. Fields are limited to those explicitly specified in this spec — no dynamic env var injection.

---

## Documentation

- `CLAUDE.md` — Update `agent-manager.ts` line count reference; add `context-builder.ts`, `sdk-event-mapper.ts`, `agent-types.ts`, `lib/sdk-utils.ts` to the services table
- `contributing/architecture.md` — Update module layout diagram; add context injection to the data flow section

---

## Implementation Phases

### Phase 1 — Type Extraction (no behavior change)

1. Create `services/agent-types.ts` with `AgentSession` and `ToolState` interfaces
2. Update `agent-manager.ts` to import types from `agent-types.ts`
3. Verify TypeScript compiles: `npm run typecheck`

### Phase 2 — Utility Extraction (no behavior change)

1. Create `lib/sdk-utils.ts` with `makeUserPrompt()` and `resolveClaudeCliPath()`
2. Update `agent-manager.ts` to import from `lib/sdk-utils.ts`
3. Verify TypeScript compiles and tests pass: `npm test -- --run`

### Phase 3 — Event Mapper Extraction (no behavior change)

1. Create `services/sdk-event-mapper.ts` with `export async function* mapSdkMessage(...)`
2. Update `agent-manager.ts` to call `mapSdkMessage()` in the streaming loop
3. Write `sdk-event-mapper.test.ts`
4. Verify all tests pass

### Phase 4 — Context Builder (new feature)

1. Create `services/context-builder.ts` with `buildSystemPromptAppend(cwd)`
2. Integrate into `agent-manager.ts` `sendMessage()` — add `systemPrompt` to `sdkOptions`
3. Write `context-builder.test.ts`
4. Verify all tests pass and TypeScript compiles
5. Update `agent-manager.test.ts` with systemPrompt assertions

### Phase 5 — Validation

1. Confirm all file line counts are under 300
2. Run full test suite: `npm test -- --run`
3. Run typecheck: `npm run typecheck`
4. Update CLAUDE.md and contributing/architecture.md

---

## File Size Targets

| File | Target Lines | Status |
|---|---|---|
| `agent-manager.ts` | ~240 | Refactored |
| `sdk-event-mapper.ts` | ~140 | New |
| `context-builder.ts` | ~100 | New |
| `lib/sdk-utils.ts` | ~40 | New |
| `agent-types.ts` | ~35 | New |

---

## Open Questions

None. All 5 clarifications resolved during ideation-to-spec:

1. Git commits → Skip (trust `claude_code` preset; also skip anything else the preset includes)
2. Hostname → Include
3. Version fallback → `DORKOS_VERSION ?? 'development'`
4. Types location → `services/agent-types.ts`
5. Tests → Both `context-builder` and `sdk-event-mapper` get full test coverage

---

## Related ADRs

None directly applicable. This spec creates candidate material for a new ADR on the context injection architecture decision (use of `systemPrompt.append` over hooks).

---

## References

- `.claude/rules/file-size.md` — File size limits and extraction patterns
- `@anthropic-ai/claude-agent-sdk/sdk.d.ts:796` — `systemPrompt` Options type
- `apps/server/src/services/git-status.ts` — `getGitStatus()` used by context-builder
- `apps/server/src/services/build-task-event.ts` — Precedent for extraction pattern
- Claude Code SDK docs — [Modifying system prompts](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- Anthropic context engineering guide — `<env>` block format as Claude Code's own pattern
