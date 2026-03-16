# SDK Command Discovery - Task Breakdown

**Spec:** `specs/sdk-command-discovery/02-specification.md`
**Generated:** 2026-03-15
**Mode:** Full decomposition

---

## Phase 1: Foundation (2 tasks, parallelizable)

### 1.1 Make CommandEntrySchema fields optional for SDK-only commands
**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Update `CommandEntrySchema` in `packages/shared/src/schemas.ts` to make `namespace`, `command`, and `filePath` optional. SDK-only commands (built-ins like `/compact`, `/help`, skills) lack filesystem metadata and cannot provide these fields.

**Changes:**
- `namespace: z.string()` becomes `namespace: z.string().optional()`
- `command: z.string()` becomes `command: z.string().optional()`
- `filePath: z.string()` becomes `filePath: z.string().optional()`

The inferred `CommandEntry` TypeScript type updates automatically. Backward compatible since all existing filesystem commands still provide all fields.

---

### 1.2 Wire up supportedCommands() callback in message-sender
**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Add `onCommandsReceived` callback to `MessageSenderOpts` and wire up the `supportedCommands()` SDK call in `executeSdkQuery()`, following the identical pattern of `supportedModels()` (non-blocking, fire-and-forget, debug-level error logging).

**File:** `apps/server/src/services/runtimes/claude-code/message-sender.ts`

**Changes:**
1. New optional field on `MessageSenderOpts`: `onCommandsReceived?: (commands: Array<{ name: string; description: string; argumentHint: string }>) => void`
2. New non-blocking `supportedCommands()` call after the existing `mcpServerStatus` block

---

## Phase 2: Core (1 task)

### 2.1 Add SDK command caching and merge logic in ClaudeCodeRuntime
**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2

Add `cachedSdkCommands` property to `ClaudeCodeRuntime`, pass `onCommandsReceived` callback in `sendMessage()`, and replace `getCommands()` with merge logic.

**File:** `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

**Changes:**
1. New property: `private cachedSdkCommands: Array<{...}> | null = null`
2. New callback in `sendMessage()` opts (only when cache is empty, matching `onModelsReceived` pattern)
3. New `getCommands()` implementation: when SDK cache exists, map SDK commands to `CommandEntry[]`, enrich with filesystem metadata via `Map` lookup, sort alphabetically; otherwise fall back to filesystem-only
4. Extract `getOrCreateRegistry()` private helper (refactored from inline code in old `getCommands()`)
5. `forceRefresh=true` clears `cachedSdkCommands` to null

**Merge strategy:** SDK is authoritative list; filesystem provides enrichment (`namespace`, `command`, `allowedTools`, `filePath`) for project-level commands that exist on disk.

---

## Phase 3: Testing (2 tasks, parallelizable)

### 3.1 Add unit tests for SDK command caching and merge logic
**Size:** Medium | **Priority:** High | **Dependencies:** 2.1 | **Parallel with:** 3.2

Add test cases to `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` covering:

- **Filesystem fallback:** `getCommands()` returns filesystem-only results when SDK cache is empty
- **SDK caching:** After first `sendMessage`, `getCommands()` returns SDK-sourced commands
- **No re-fetch:** Second `sendMessage` does not call `supportedCommands()` again
- **forceRefresh:** `getCommands(true)` clears SDK cache, falls back to filesystem
- **Alphabetical sorting:** Merged commands sorted by `fullCommand`

---

### 3.2 Add schema validation test and update route test assertions
**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 3.1

Add tests to `apps/server/src/routes/__tests__/commands.test.ts` verifying:

- SDK-only commands (no `namespace`, `command`, `filePath`) pass through the API correctly
- Mixed commands (some with filesystem metadata, some without) are returned correctly
- Existing tests continue to pass unchanged (backward compatibility)

---

## Summary

| Phase | Tasks | Parallelizable |
|-------|-------|----------------|
| 1 - Foundation | 2 | Yes (1.1 and 1.2) |
| 2 - Core | 1 | No (depends on P1) |
| 3 - Testing | 2 | Yes (3.1 and 3.2) |
| **Total** | **5** | |

**Files modified:**
- `packages/shared/src/schemas.ts`
- `apps/server/src/services/runtimes/claude-code/message-sender.ts`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`
- `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`
- `apps/server/src/routes/__tests__/commands.test.ts`
