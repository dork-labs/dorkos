---
slug: file-autocomplete
number: 17
created: 2026-02-13
status: implemented
---

# File Autocomplete in Chat Input

**Slug:** file-autocomplete
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Add file and folder autocomplete to the chat input, triggered by `@` (mirroring how `/` triggers slash command autocomplete). The system should support fuzzy matching, file names, folder names, partial names, and be efficient for projects with thousands of files. When the user switches directories (cwd), the available file list should update automatically.

**Assumptions:**

- `@` is the trigger character (matches Claude Code CLI convention where `@filename` references files)
- Files should use paths relative to the current working directory
- The `@path/to/file` text stays in the message as-is (Claude Code natively understands this syntax)
- We follow the same architectural pattern as slash commands (Transport interface, server endpoint, React Query hook, palette component)
- Git-tracked projects should use `git ls-files` for fast, .gitignore-respecting file listing
- The existing `fuzzyMatch` utility can be reused for client-side filtering

**Out of scope:**

- MCP resource references (`@server:protocol://resource`)
- Image/binary file preview in the palette
- File content preview on hover
- Drag-and-drop file references
- Multiple `@` references in a single autocomplete session (each `@` triggers independently)

---

## 2) Pre-reading Log

- `apps/client/src/components/chat/ChatPanel.tsx`: Main orchestrator. Regex detects `/` trigger, filters commands, manages palette state. **Pattern to replicate for `@` trigger.**
- `apps/client/src/components/commands/CommandPalette.tsx`: Dropdown UI with grouped items, keyboard navigation, scroll-into-view. **Pattern to adapt for file palette.**
- `apps/client/src/components/chat/ChatInput.tsx`: Textarea with `isPaletteOpen` interception for arrow keys, Enter, Tab, Escape. **Already supports palette-open mode — needs no changes if we reuse the same props.**
- `apps/client/src/lib/fuzzy-match.ts`: Subsequence matcher with consecutive-char scoring. **Reusable as-is for file name matching.**
- `apps/client/src/hooks/use-commands.ts`: React Query hook with cwd in query key. **Pattern to follow for `useFiles` hook.**
- `apps/client/src/hooks/use-directory-state.ts`: Returns `[cwd, setCwd]`. **Already used in ChatPanel for commands — reuse for files.**
- `packages/shared/src/transport.ts`: Transport interface. **Need to add `listFiles()` method.**
- `apps/client/src/lib/http-transport.ts`: HTTP adapter. **Need to add `listFiles()` implementation.**
- `apps/client/src/lib/direct-transport.ts`: Direct adapter for Obsidian. **Need to add `listFiles()` pass-through.**
- `packages/shared/src/schemas.ts`: Zod schemas. **Need to add `FileListQuery` and `FileListResponse` schemas.**
- `apps/server/src/routes/directory.ts`: Existing directory browser — **only returns directories, not files**. Security: restricted to `$HOME`.
- `apps/server/src/services/command-registry.ts`: Filesystem scanner with caching. **Pattern to follow for file listing service.**

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/components/chat/ChatPanel.tsx` — Chat orchestrator, owns autocomplete state
- `apps/client/src/components/chat/ChatInput.tsx` — Textarea with palette keyboard interception
- `apps/client/src/components/commands/CommandPalette.tsx` — Autocomplete dropdown (model for FilePalette)
- `apps/client/src/hooks/use-commands.ts` — React Query hook (model for useFiles)
- `apps/client/src/lib/fuzzy-match.ts` — Reusable fuzzy matcher

**Shared Dependencies:**

- `packages/shared/src/transport.ts` — Transport interface (needs new method)
- `packages/shared/src/schemas.ts` — Zod schemas (needs new schemas)
- `apps/client/src/hooks/use-directory-state.ts` — cwd state management

**Data Flow (slash commands — the model to follow):**

```
User types "/"
  → ChatPanel regex detects trigger, extracts query
  → filteredCommands = fuzzyMatch(query, allCommands)
  → CommandPalette renders filtered list
  → User selects → text inserted into input
  → On submit → message sent with /command text
```

**Proposed data flow (file autocomplete):**

```
User types "@"
  → ChatPanel regex detects trigger, extracts query
  → Server fetches file list for cwd (cached)
  → filteredFiles = fuzzyMatch(query, allFiles)
  → FilePalette renders filtered list
  → User selects → @path/to/file inserted into input
  → On submit → message sent with @path/to/file text (Claude understands natively)
```

**Blast Radius:**

- **New files (5):** FileListService, files route, FilePalette component, useFiles hook, file-lister tests
- **Modified files (6):** schemas.ts, transport.ts, http-transport.ts, direct-transport.ts, ChatPanel.tsx, server index.ts (mount route)
- **Unchanged:** ChatInput.tsx (palette-open mode already generic), CommandPalette.tsx

---

## 4) Research

### How Claude Code handles `@` file references

Claude Code CLI uses `@filename` syntax to reference files. Key findings:

- `@` followed by a relative path references a file from the project root
- Tab completion is available in the CLI after typing `@`
- Files are included as context in the model's input
- Relative paths are the convention (not absolute)
- Multiple `@file` references can appear in a single message

**Implication:** Our autocomplete should insert `@relative/path` text. The message is sent as-is to the Agent SDK, which already understands this syntax. No special server-side parsing needed.

### File listing strategies for large projects

| Strategy                        | Speed                   | .gitignore          | node_modules          | Simplicity            |
| ------------------------------- | ----------------------- | ------------------- | --------------------- | --------------------- |
| `git ls-files`                  | Very fast (index-based) | Automatic           | Excluded              | High                  |
| Recursive `readdir`             | Slow for large trees    | Must parse manually | Must exclude manually | Low                   |
| `fd` / `ripgrep --files`        | Fast                    | Via .gitignore      | Via .gitignore        | Medium (external dep) |
| Hybrid (git + readdir fallback) | Fast for git repos      | Best of both        | Handled               | Medium                |

**Recommendation:** Use `git ls-files` as primary strategy. It's fast (reads the git index, not the filesystem), respects .gitignore, excludes node_modules/build artifacts, and works correctly for monorepos. Fall back to `readdir` with smart exclusion patterns for non-git directories.

### Performance patterns

| Concern                       | Approach                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Large file lists (10k+ files) | Server returns full list, cached. Client fuzzy-filters locally.                  |
| Network latency               | Prefetch file list when cwd changes (React Query background refetch)             |
| Rendering many items          | Cap displayed results at 50. No virtual scrolling needed.                        |
| Typing latency                | No debounce needed — fuzzy filtering is O(n) on cached array, ~1ms for 10k items |
| Memory                        | File list is string array of relative paths. 10k paths ~ 500KB. Acceptable.      |

### UX patterns

| Pattern      | Decision                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| Trigger      | `@` at end of input (same position rules as `/`)                                     |
| Display      | Flat list (no grouping by directory — unlike commands which group by namespace)      |
| Path display | Show relative path with directory dimmed, filename emphasized                        |
| Selection    | Insert `@relative/path ` with trailing space                                         |
| Empty state  | "No files found" when query matches nothing                                          |
| Keyboard     | Arrow up/down, Enter/Tab to select, Escape to dismiss (reuse ChatInput palette mode) |
| Max visible  | Show top 50 matches (sorted by fuzzy score)                                          |

---

## 5) Approach

### Architecture Overview

Follow the exact same layered pattern as slash commands:

1. **Server service** (`file-lister.ts`): Runs `git ls-files` (or readdir fallback), caches result per cwd, returns `string[]` of relative paths.
2. **Server route** (`files.ts`): `GET /api/files?cwd=...` — validates query, calls service, returns JSON.
3. **Shared schemas**: `FileListQuerySchema`, `FileListResponseSchema` for validation + OpenAPI.
4. **Transport method**: `listFiles(cwd?: string): Promise<FileListResponse>` on the `Transport` interface.
5. **React Query hook** (`use-files.ts`): Fetches file list with cwd in query key. Auto-refetches on cwd change.
6. **ChatPanel state**: Second regex for `@` trigger, separate palette state (can coexist with command palette since only one triggers at a time).
7. **FilePalette component**: Similar to CommandPalette but renders file paths instead of command entries. Flat list (no namespace grouping).

### Key Design Decisions

**Server-side filtering vs client-side filtering:**
Client-side. The full file list is cached by React Query (staleTime: 5min). Fuzzy matching happens in `useMemo` on every keystroke, same as commands. This avoids a round-trip per keystroke and reuses the existing pattern.

**File list format:**
Simple `string[]` of relative paths (e.g., `["src/index.ts", "src/App.tsx", "package.json"]`). No metadata (size, type, etc.) — keeps payloads small and the API simple. The client can infer directories from paths.

**Cursor-position-based triggering:**
Unlike slash commands which use end-of-input matching, file autocomplete uses cursor position. The regex `(^|\s)@([\w.\/:-]*)$` is applied to `input.slice(0, cursorPos)`. This allows mid-input `@` references. ChatInput needs to expose `selectionStart` (via onChange or a ref callback). This also enables natural directory drill-down: selecting a directory inserts `@dir/`, the cursor lands after `/`, and the regex re-triggers.

**Coexistence with command palette:**
ChatPanel already tracks `showCommands` state. We add `showFiles` state. The regex for `@` and `/` are mutually exclusive (only one triggers at a time). ChatInput's `isPaletteOpen` prop becomes `true` for either palette.

**Match highlighting:**
Extend `fuzzyMatch` to return `indices: number[]` of matched character positions alongside `match` and `score`. The FilePalette renders matched characters with `font-semibold text-foreground` against the default `text-muted-foreground`. This change is backwards-compatible — the existing CommandPalette can adopt highlighting later without changes.

**`git ls-files` execution:**
Run via `child_process.execFile('git', ['ls-files', ...])` with `cwd` set to the target directory. If git is not available or the directory isn't a git repo, fall back to recursive readdir with hardcoded exclusions (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`).

---

## 6) Clarifications (Resolved)

1. **Should the `@` trigger work mid-input or only at end-of-input?**
   **Decision: After any whitespace (cursor-position based).** The regex `(^|\s)@([\w.\/:-]*)` is applied to `input.slice(0, cursorPos)` rather than the full input string. This allows `tell me about @file1 and also @file2` flows naturally. Requires tracking `selectionStart` from the textarea.

2. **Should directories appear in the autocomplete alongside files?**
   **Decision: Yes.** User requirement: "I should be able to enter a folder name without a file." Directories are extracted as unique prefixes from the file path list (since `git ls-files` only returns files). Directories show a folder icon; files show a file icon.

3. **Directory drill-down behavior?**
   **Decision: Insert and keep drilling.** Selecting a directory inserts `@src/components/` and keeps the palette open. With cursor-position-based triggering, the regex naturally re-detects `@src/components/` and filters to files within that directory. No special logic needed — this comes for free from the cursor-tracking architecture.

4. **Path display in palette?**
   **Decision: Filename bold, directory dimmed.** VS Code Cmd+P style. `ChatPanel.tsx` rendered prominently with `src/components/chat/` in muted text beside it.

5. **Match highlighting?**
   **Decision: Yes.** Extend `fuzzyMatch` to return `indices: number[]` of matched character positions. Render matched characters with a highlight class. This helps users understand non-obvious fuzzy matches.

6. **File list size limit?**
   Decision: Cap at 10,000 files server-side. Most projects are well under this.

7. **File type icons?**
   Decision: Defer for v1. Simple file/folder icon distinction only.

8. **Cache invalidation?**
   Decision: 5-minute staleTime (matches commands pattern). Changing cwd auto-invalidates via different query key.
