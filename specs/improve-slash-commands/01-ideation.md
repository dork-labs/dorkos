---
slug: improve-slash-commands
number: 19
created: 2026-02-13
status: specified
---

# Improve Slash Command System

**Slug:** improve-slash-commands
**Author:** Claude Code
**Date:** 2026-02-13
**Branch:** preflight/improve-slash-commands
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Improve the slash command system across client and server. Fix the colon regex bug that prevents filtering by full command name, add fuzzy matching, preserve text before the slash on command selection, reload commands when directory changes, and clean up minor issues.

**Assumptions:**

- We're improving the existing system, not replacing it
- The command palette UI structure (grouped by namespace) stays
- Directory switching already exists via `useDirectoryState()` (`?dir=` URL param / Zustand store)
- Command set of ~50-200 items (no need for virtualization or heavy indexing)

**Out of scope:**

- Adding new command `.md` files
- Changing how the Agent SDK processes/executes commands server-side
- Rich text / contenteditable for the input (stays as textarea)
- Root-level command files (commands outside namespace directories) — noted but deferred

---

## 2) Pre-reading Log

- `apps/client/src/components/chat/ChatPanel.tsx`: Main orchestrator. Lines 93-103 handle slash detection with regex `/(^|\s)\/(\w*)$/`. Lines 72-79 filter with `.includes()`. Line 106 replaces entire input on selection.
- `apps/client/src/components/commands/CommandPalette.tsx`: Pure presentation. Groups by namespace, renders list, scrolls active item into view. `onClose` prop is passed but never called (`void onClose` on line 13).
- `apps/client/src/components/chat/ChatInput.tsx`: Keyboard handling when palette is open (ArrowUp/Down/Enter/Tab/Escape).
- `apps/client/src/hooks/use-commands.ts`: React Query with static key `['commands']`. No cwd parameter. 5-min stale, 30-min gc.
- `apps/client/src/hooks/use-directory-state.ts`: Manages cwd via URL `?dir=` (standalone) or Zustand (embedded). Clears `sessionId` on change but does NOT invalidate commands.
- `apps/server/src/routes/commands.ts`: Singleton `CommandRegistryService(vaultRoot)` created at module load. `vaultRoot` fixed from `GATEWAY_CWD` env var. Only accepts `?refresh=` query param.
- `apps/server/src/services/command-registry.ts`: Scans `.claude/commands/` recursively. Only reads directories (skips root-level `.md` files). Caches indefinitely until `forceRefresh=true`.
- `packages/shared/src/transport.ts`: `getCommands(refresh?: boolean)` — no cwd param.
- `packages/shared/src/schemas.ts`: `CommandsQuerySchema` only has `refresh`. `CommandEntrySchema` has namespace, command, fullCommand, description, argumentHint, allowedTools, filePath.
- `apps/client/src/lib/http-transport.ts`: `getCommands(refresh)` → `GET /api/commands?refresh=true`.
- `apps/client/src/lib/direct-transport.ts`: `getCommands(refresh)` → calls registry directly.

---

## 3) Codebase Map

**Primary Components/Modules:**

| Path                                                     | Role                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/client/src/components/chat/ChatPanel.tsx`          | Slash detection, filtering, palette state, command selection |
| `apps/client/src/components/commands/CommandPalette.tsx` | Palette UI rendering (grouped by namespace)                  |
| `apps/client/src/components/chat/ChatInput.tsx`          | Keyboard event handling when palette open                    |
| `apps/client/src/hooks/use-commands.ts`                  | React Query hook for fetching commands                       |
| `apps/client/src/hooks/use-directory-state.ts`           | Cwd state (URL ↔ Zustand)                                    |
| `apps/server/src/routes/commands.ts`                     | GET /api/commands endpoint                                   |
| `apps/server/src/services/command-registry.ts`           | Filesystem scanner + cache                                   |
| `packages/shared/src/transport.ts`                       | Transport interface                                          |
| `packages/shared/src/schemas.ts`                         | Zod schemas for commands                                     |
| `apps/client/src/lib/http-transport.ts`                  | HTTP transport adapter                                       |
| `apps/client/src/lib/direct-transport.ts`                | Direct transport adapter                                     |

**Shared Dependencies:**

- `useDirectoryState()` — cwd management
- `useTransport()` — transport injection via React Context
- `useAppStore` (Zustand) — `selectedCwd`, `sessionId`
- TanStack Query — caching layer

**Data Flow:**

```
Server startup → CommandRegistryService(vaultRoot) scans .claude/commands/
Client mount → useCommands() → transport.getCommands() → GET /api/commands
User types "/" → regex match → filteredCommands (useMemo) → CommandPalette renders
User selects → setInput(cmd.fullCommand + ' ') → palette closes
User submits → transport.sendMessage(sessionId, "/ns:cmd args", onEvent)
```

**Directory Switching (current):**

```
User changes dir → useDirectoryState setter → setUrlDir + setStoreDir + setSessionId(null)
Commands: NOT invalidated (static query key ['commands'], no cwd param)
```

---

## 4) Root Cause Analysis

### Bug: Colon not matched in regex (ChatPanel.tsx:96)

**Observed:** Typing `/debug:r` closes the palette because `:` is not matched by `\w`.
**Expected:** Palette stays open and filters to commands matching `debug:r`.
**Root cause:** Regex `/(^|\s)\/(\w*)$/` uses `\w` which matches `[a-zA-Z0-9_]` — excludes `:` and `-`.
**Fix:** Change capture group to `[\w:-]*` → `/(^|\s)\/([\w:-]*)$/`.

### Bug: Selection replaces entire input (ChatPanel.tsx:105-108)

**Observed:** Typing `please run /deb` then selecting `/debug:test` results in input = `/debug:test ` (prefix "please run " lost).
**Expected:** Input becomes `please run /debug:test `.
**Root cause:** `handleCommandSelect` does `setInput(cmd.fullCommand + ' ')` without preserving text before the slash trigger.
**Fix:** Track the trigger position and replace only the `/{query}` portion.

---

## 5) Research

### Fuzzy Matching

| Approach               | Bundle Size | Pros                                                  | Cons                              |
| ---------------------- | ----------- | ----------------------------------------------------- | --------------------------------- |
| **fuzzysort**          | ~6KB        | Fast, great for file/command names, highlight support | Slightly larger than alternatives |
| **command-score**      | ~3KB        | Superhuman-style scoring, tiny                        | Less highlighting support         |
| **Custom subsequence** | 0KB         | Zero dependencies                                     | No scoring/ranking, must maintain |
| **Fuse.js**            | ~19KB       | Full-featured, well-documented                        | Overkill for 50-200 items         |

**Recommendation:** Simple custom subsequence matching. For ~50-200 commands, the perf difference is negligible, and we avoid adding a dependency. If we later need ranked results or highlighting, upgrade to fuzzysort.

### Text Replacement (Preserving Pre-Slash Text)

**How Slack/Discord do it:** Track the trigger character position (`/`), replace only from trigger to cursor, preserve everything before and after.

**Recommended pattern:** Use `selectionStart` to find cursor position, look backward for the `/` trigger, and on selection replace only `[triggerPos...cursor]` with the command. No library needed — just string slicing.

### Cache Invalidation on Directory Change

**Recommended approach (TanStack Query best practice):** Include `cwd` in the query key: `['commands', { cwd }]`. When `cwd` changes, React Query automatically treats it as a new query and fetches fresh data. Old directory data stays cached for instant back-navigation.

**Server-side:** Accept `?cwd=` query param in the commands route. The registry can use a Map of `cwd → CommandRegistryService` instances, or the single service can accept `cwd` as a method param.

---

## 6) Clarification (Resolved)

1. **Fuzzy matching strategy:** Custom subsequence matcher, no library. Zero dependencies.
2. **Server-side cwd handling:** Option (a) — accept `cwd` as query param, cache registries per directory.
3. **Root-level commands:** Defer. Keep current behavior (namespace directories only).
4. **Unused `onClose` prop:** Remove it from `CommandPalette`.
5. **Mid-input command insertion:** End-of-input only for now.
