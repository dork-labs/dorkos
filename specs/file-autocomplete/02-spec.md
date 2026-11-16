# Specification: File Autocomplete (`@` trigger)

**Slug:** file-autocomplete
**Date:** 2026-02-13
**Source:** [01-ideation.md](./01-ideation.md)

---

## 1) Overview

Add file and folder autocomplete to the chat input, triggered by `@`. When a user types `@` after whitespace (or at start of input), a palette appears showing files from the current working directory, filtered by fuzzy matching. Selecting a file inserts `@relative/path` into the message text. Selecting a directory inserts `@dir/` and keeps the palette open for drill-down.

The feature follows the exact same layered pattern as the existing slash command autocomplete (`/` trigger), adding a parallel pipeline: server service → route → shared schemas → transport → React Query hook → palette component → ChatPanel orchestration.

Claude Code natively understands `@path` references in messages, so no special server-side parsing is needed — the text goes through as-is to the Agent SDK.

---

## 2) Technical Design

### Data Flow

```
User types "@que"
  → ChatInput fires onChange with value + selectionStart (cursor position)
  → ChatPanel applies regex to input.slice(0, cursorPos)
  → Regex matches: trigger="@", query="que"
  → showFiles=true, fileQuery="que"
  → useFiles(cwd) provides cached file list from server
  → useMemo: fuzzyMatch("que", each file path) → filteredFiles (top 50)
  → FilePalette renders: "QueryClient.ts" (src/lib/) highlighted
  → User presses Enter → "@src/lib/QueryClient.ts " inserted at trigger position
  → Palette closes
```

### Types & Schemas

```typescript
// packages/shared/src/schemas.ts — NEW schemas

export const FileListQuerySchema = z
  .object({
    cwd: z.string().min(1),
  })
  .openapi('FileListQuery');

export const FileListResponseSchema = z
  .object({
    files: z.array(z.string()),
    truncated: z.boolean(),
    total: z.number().int(),
  })
  .openapi('FileListResponse');
```

```typescript
// packages/shared/src/transport.ts — NEW method on Transport interface

listFiles(cwd: string): Promise<FileListResponse>;
```

### Server Service: FileListService

```typescript
// apps/server/src/services/file-lister.ts

class FileListService {
  private cache = new Map<string, { files: string[]; timestamp: number }>();
  private readonly MAX_FILES = 10_000;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }>;
  private async listViaGit(cwd: string): Promise<string[]>;
  private async listViaReaddir(cwd: string): Promise<string[]>;
  invalidateCache(cwd?: string): void;
}
```

**`listViaGit`**: Runs `execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd })`. Returns relative paths. If git is not available or the directory isn't a git repo, throws so caller falls back to readdir.

**`listViaReaddir`**: Recursive readdir with hardcoded exclusions: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `__pycache__`, `.cache`. Depth limit: 8 levels. Returns relative paths.

**Caching**: In-memory Map keyed by `cwd`. TTL of 5 minutes. `listFiles()` checks cache first.

### Server Route

```typescript
// apps/server/src/routes/files.ts
// GET /api/files?cwd=/path/to/project

router.get('/', async (req, res) => {
  const parsed = FileListQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error, details });
  const result = await fileLister.listFiles(parsed.data.cwd);
  res.json(result);
});
```

Security: The `cwd` comes from the client's directory state (which is already restricted to the home directory by the directory browser). The file lister only reads file names, not contents.

### Extended fuzzyMatch

```typescript
// apps/client/src/lib/fuzzy-match.ts — MODIFIED

export function fuzzyMatch(
  query: string,
  target: string
): { match: boolean; score: number; indices: number[] } {
  if (!query) return { match: true, score: 0, indices: [] };
  // ... same algorithm, but also collects indices of matched chars
}
```

The `indices` array contains the positions in `target` where each query character matched. This is backwards-compatible — existing callers that destructure `{ match, score }` still work.

### FilePalette Component

```typescript
// apps/client/src/components/files/FilePalette.tsx

interface FileEntry {
  path: string; // relative path: "src/components/chat/ChatPanel.tsx"
  filename: string; // "ChatPanel.tsx"
  directory: string; // "src/components/chat/"
  isDirectory: boolean;
}

interface FilePaletteProps {
  filteredFiles: Array<FileEntry & { indices: number[] }>;
  selectedIndex: number;
  onSelect: (entry: FileEntry) => void;
}
```

**Rendering each item:**

- File icon (Lucide `File`) or folder icon (Lucide `Folder`) on the left
- Filename rendered with match highlighting: matched chars get `font-semibold text-foreground`, unmatched get default `text-sm`
- Directory path rendered dimmed: `text-xs text-muted-foreground`
- Layout: `[icon] [filename] [directory-path]` in a single row

**Match highlighting logic:**
The `indices` array from fuzzyMatch maps to character positions in the full path. The component splits the filename + directory into spans, applying highlight styles to characters at matched indices.

### ChatInput Changes

```typescript
// apps/client/src/components/chat/ChatInput.tsx — MODIFIED

interface ChatInputProps {
  // ... existing props ...
  onCursorChange?: (pos: number) => void; // NEW
}
```

Add an `onSelect` / `onInput` handler (or piggyback on `onChange`) that calls `onCursorChange(textarea.selectionStart)` whenever the cursor position changes. This includes: typing, clicking, arrow keys.

Implementation: In `handleChange`, after calling `onChange(e.target.value)`, call `onCursorChange?.(e.target.selectionStart)`. Also add `onSelect` and `onClick` handlers to catch cursor moves without value changes.

### ChatPanel Integration

ChatPanel gets a parallel set of state for file autocomplete:

```typescript
// New state
const [showFiles, setShowFiles] = useState(false);
const [fileQuery, setFileQuery] = useState('');
const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
const [fileTriggerPos, setFileTriggerPos] = useState(-1);
const [cursorPos, setCursorPos] = useState(0);

// useFiles hook
const { data: fileList } = useFiles(cwd);
```

**Trigger detection** (in `handleInputChange` or a new effect triggered by input+cursor changes):

```typescript
function detectTrigger(value: string, cursor: number) {
  const textToCursor = value.slice(0, cursor);

  // Check for @ trigger (file autocomplete)
  const fileMatch = textToCursor.match(/(^|\s)@([\w.\/:-]*)$/);
  if (fileMatch) {
    setShowFiles(true);
    setFileQuery(fileMatch[2]);
    setFileTriggerPos((fileMatch.index ?? 0) + fileMatch[1].length);
    setShowCommands(false);
    return;
  }

  // Check for / trigger (command autocomplete) — existing logic
  const cmdMatch = textToCursor.match(/(^|\s)\/([\w:-]*)$/);
  if (cmdMatch) {
    setShowCommands(true);
    setCommandQuery(cmdMatch[2]);
    setSlashTriggerPos((cmdMatch.index ?? 0) + cmdMatch[1].length);
    setShowFiles(false);
    return;
  }

  // No trigger active
  setShowFiles(false);
  setShowCommands(false);
}
```

Note: Both slash commands AND file autocomplete now use cursor-position-based detection (applied to `input.slice(0, cursorPos)`). This is a minor change to the existing slash command behavior — previously it used `value.match(/(^|\s)\/([\w:-]*)$/)` on the full input. Now it uses `textToCursor` instead. This improves slash commands too (they now work mid-input).

**File filtering:**

```typescript
const allFileEntries = useMemo(() => {
  if (!fileList?.files) return [];
  const entries: FileEntry[] = [];
  const seenDirs = new Set<string>();

  for (const filePath of fileList.files) {
    const lastSlash = filePath.lastIndexOf('/');
    const directory = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
    const filename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    entries.push({ path: filePath, filename, directory, isDirectory: false });

    // Extract unique parent directories
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') + '/';
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        entries.push({
          path: dir,
          filename: parts[i - 1] + '/',
          directory: i > 1 ? parts.slice(0, i - 1).join('/') + '/' : '',
          isDirectory: true,
        });
      }
    }
  }

  return entries;
}, [fileList]);

const filteredFiles = useMemo(() => {
  if (!fileQuery) return allFileEntries.slice(0, 50);
  return allFileEntries
    .map((entry) => {
      const result = fuzzyMatch(fileQuery, entry.path);
      return { ...entry, ...result };
    })
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}, [allFileEntries, fileQuery]);
```

**File selection:**

```typescript
function handleFileSelect(entry: FileEntry) {
  const before = input.slice(0, fileTriggerPos);
  const after = input.slice(cursorPos);

  if (entry.isDirectory) {
    // Directory: insert @dir/ and keep palette open for drill-down
    const newValue = before + '@' + entry.path + after;
    const newCursor = before.length + 1 + entry.path.length; // after the trailing /
    setInput(newValue);
    setCursorPos(newCursor);
    // Palette stays open — detectTrigger will re-fire with the new text
  } else {
    // File: insert @path and close palette
    const newValue = before + '@' + entry.path + ' ' + after;
    setInput(newValue);
    setShowFiles(false);
  }
}
```

**Keyboard navigation:**

The existing `isPaletteOpen` prop on ChatInput becomes `showCommands || showFiles`. The `onArrowUp`, `onArrowDown`, `onCommandSelect` handlers are reused but dispatch to the correct palette based on which is open.

```typescript
const isPaletteOpen = showCommands || showFiles;

const handleArrowDown = useCallback(() => {
  if (showCommands) {
    setSelectedIndex((prev) => ...);
  } else if (showFiles) {
    setFileSelectedIndex((prev) => ...);
  }
}, [showCommands, showFiles, filteredCommands.length, filteredFiles.length]);

// Similar for handleArrowUp, handleKeyboardSelect
```

**JSX rendering:**

```tsx
<div className="chat-input-container relative border-t p-4">
  <AnimatePresence>
    {showCommands && (
      <CommandPalette
        filteredCommands={filteredCommands}
        selectedIndex={selectedIndex}
        onSelect={handleCommandSelect}
      />
    )}
    {showFiles && (
      <FilePalette
        filteredFiles={filteredFiles}
        selectedIndex={fileSelectedIndex}
        onSelect={handleFileSelect}
      />
    )}
  </AnimatePresence>
  <ChatInput
    value={input}
    onChange={handleInputChange}
    onCursorChange={setCursorPos}
    onSubmit={handleSubmit}
    isLoading={status === 'streaming'}
    onStop={stop}
    onEscape={() => {
      setShowCommands(false);
      setShowFiles(false);
    }}
    isPaletteOpen={isPaletteOpen}
    onArrowUp={handleArrowUp}
    onArrowDown={handleArrowDown}
    onCommandSelect={handleKeyboardSelect}
    activeDescendantId={activeDescendantId}
  />
  ...
</div>
```

### React Query Hook

```typescript
// apps/client/src/hooks/use-files.ts

import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../contexts/TransportContext';
import type { FileListResponse } from '@dorkos/shared/types';

export function useFiles(cwd?: string | null) {
  const transport = useTransport();
  return useQuery<FileListResponse>({
    queryKey: ['files', { cwd: cwd ?? null }],
    queryFn: () => transport.listFiles(cwd!),
    enabled: !!cwd,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
```

---

## 3) Implementation Phases

### Phase 1: Shared Layer (schemas + transport)

**`packages/shared/src/schemas.ts`** — Add:

```typescript
export const FileListQuerySchema = z
  .object({
    cwd: z.string().min(1),
  })
  .openapi('FileListQuery');

export type FileListQuery = z.infer<typeof FileListQuerySchema>;

export const FileListResponseSchema = z
  .object({
    files: z.array(z.string()),
    truncated: z.boolean(),
    total: z.number().int(),
  })
  .openapi('FileListResponse');

export type FileListResponse = z.infer<typeof FileListResponseSchema>;
```

**`packages/shared/src/transport.ts`** — Add import and method:

```typescript
import type { ..., FileListResponse } from './types.js';

// In Transport interface:
listFiles(cwd: string): Promise<FileListResponse>;
```

### Phase 2: Server (service + route)

**`apps/server/src/services/file-lister.ts`** — New file:

- `FileListService` class with `listFiles(cwd)`, `listViaGit(cwd)`, `listViaReaddir(cwd)`, `invalidateCache(cwd?)`
- In-memory cache: `Map<string, { files: string[]; timestamp: number }>`
- Git strategy: `execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 10 * 1024 * 1024 })`
- Readdir strategy: recursive with exclusions, depth limit 8
- Cap at 10,000 files, set `truncated: true` if exceeded
- Export singleton: `export const fileLister = new FileListService();`

**`apps/server/src/routes/files.ts`** — New file:

- `GET /` handler: validate with `FileListQuerySchema.safeParse(req.query)`, call `fileLister.listFiles(cwd)`, return JSON

**`apps/server/src/app.ts`** — Modify:

- Add `import fileRoutes from './routes/files.js';`
- Add `app.use('/api/files', fileRoutes);`

### Phase 3: Client Transports

**`apps/client/src/lib/http-transport.ts`** — Add:

```typescript
listFiles(cwd: string): Promise<FileListResponse> {
  const params = new URLSearchParams({ cwd });
  return fetchJSON<FileListResponse>(this.baseUrl, `/files?${params}`);
}
```

**`apps/client/src/lib/direct-transport.ts`** — Add:

```typescript
// Add to DirectTransportServices interface:
fileLister?: {
  listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }>;
};

// Add method:
async listFiles(cwd: string): Promise<FileListResponse> {
  if (this.services.fileLister) {
    return this.services.fileLister.listFiles(cwd);
  }
  // Fallback: return empty (Obsidian plugin may not have file lister yet)
  return { files: [], truncated: false, total: 0 };
}
```

### Phase 4: fuzzyMatch Enhancement

**`apps/client/src/lib/fuzzy-match.ts`** — Modify return type:

```typescript
export function fuzzyMatch(
  query: string,
  target: string
): { match: boolean; score: number; indices: number[] } {
  if (!query) return { match: true, score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  const indices: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += consecutive;
      indices.push(ti);
    } else {
      consecutive = 0;
    }
  }

  return { match: qi === q.length, score, indices };
}
```

**`apps/client/src/lib/__tests__/fuzzy-match.test.ts`** — Add tests for `indices`:

- Empty query → `indices: []`
- Exact match → indices are sequential `[0, 1, 2, ...]`
- Subsequence match → indices are non-sequential
- Verify indices length equals query length when match is true

### Phase 5: useFiles Hook

**`apps/client/src/hooks/use-files.ts`** — New file (see React Query Hook section above)

### Phase 6: FilePalette Component

**`apps/client/src/components/files/FilePalette.tsx`** — New file:

- Same animation pattern as CommandPalette (motion.div with scale+opacity)
- Same `onMouseDown={e => e.preventDefault()}` to prevent blur
- Flat list (no grouping by namespace)
- Each item: `[FileIcon/FolderIcon] [highlighted-filename] [dimmed-directory]`
- Scroll active item into view
- `role="listbox"` with `role="option"` items
- Cap at 50 displayed items

**Match highlighting helper:**

```typescript
function HighlightedText({ text, indices, startOffset = 0 }: {
  text: string;
  indices: number[];
  startOffset?: number;
}) {
  const chars = text.split('');
  const highlightSet = new Set(indices.map(i => i - startOffset));
  return (
    <>
      {chars.map((char, i) =>
        highlightSet.has(i) ? (
          <span key={i} className="font-semibold text-foreground">{char}</span>
        ) : (
          <span key={i}>{char}</span>
        )
      )}
    </>
  );
}
```

### Phase 7: ChatInput + ChatPanel Integration

**`apps/client/src/components/chat/ChatInput.tsx`** — Modify:

- Add `onCursorChange?: (pos: number) => void` to props
- In `handleChange`: after `onChange(e.target.value)`, call `onCursorChange?.(e.target.selectionStart)`
- Add `onSelect` handler on `<textarea>` to catch cursor repositioning (click, shift+arrow):
  ```typescript
  const handleSelect = useCallback(() => {
    if (textareaRef.current) {
      onCursorChange?.(textareaRef.current.selectionStart);
    }
  }, [onCursorChange]);
  ```
- Add `onSelect={handleSelect}` to `<textarea>`

**`apps/client/src/components/chat/ChatPanel.tsx`** — Modify:

- Add all new state variables (showFiles, fileQuery, fileSelectedIndex, fileTriggerPos, cursorPos)
- Add useFiles hook
- Modify `handleInputChange` to use cursor-position-based trigger detection for both `@` and `/`
- Add `allFileEntries` and `filteredFiles` useMemo computations
- Add `handleFileSelect` function
- Modify keyboard handlers to dispatch to correct palette
- Update JSX to render FilePalette alongside CommandPalette
- Pass `onCursorChange={setCursorPos}` to ChatInput

---

## 4) File Change Summary

| File                                                | Change                                                           | Phase |
| --------------------------------------------------- | ---------------------------------------------------------------- | ----- |
| `packages/shared/src/schemas.ts`                    | **Modify** — Add `FileListQuerySchema`, `FileListResponseSchema` | 1     |
| `packages/shared/src/transport.ts`                  | **Modify** — Add `listFiles()` method + import                   | 1     |
| `apps/server/src/services/file-lister.ts`           | **New** — FileListService with git+readdir strategies            | 2     |
| `apps/server/src/routes/files.ts`                   | **New** — GET /api/files endpoint                                | 2     |
| `apps/server/src/app.ts`                            | **Modify** — Mount files route                                   | 2     |
| `apps/client/src/lib/http-transport.ts`             | **Modify** — Add `listFiles()`                                   | 3     |
| `apps/client/src/lib/direct-transport.ts`           | **Modify** — Add `listFiles()` + service interface               | 3     |
| `apps/client/src/lib/fuzzy-match.ts`                | **Modify** — Add `indices` to return                             | 4     |
| `apps/client/src/lib/__tests__/fuzzy-match.test.ts` | **Modify** — Add indices tests                                   | 4     |
| `apps/client/src/hooks/use-files.ts`                | **New** — React Query hook                                       | 5     |
| `apps/client/src/components/files/FilePalette.tsx`  | **New** — File autocomplete palette UI                           | 6     |
| `apps/client/src/components/chat/ChatInput.tsx`     | **Modify** — Expose cursor position                              | 7     |
| `apps/client/src/components/chat/ChatPanel.tsx`     | **Modify** — `@` trigger, file state, integration                | 7     |

**Total: 4 new files, 9 modified files**

---

## 5) Testing Strategy

### Unit Tests

**`apps/server/src/services/__tests__/file-lister.test.ts`** — New:

- Mock `child_process.execFile` for git strategy
- Mock `fs/promises` for readdir strategy
- Test: git success → returns file list
- Test: git failure → falls back to readdir
- Test: caching (second call returns cached)
- Test: cache TTL expiry
- Test: truncation at 10,000 files
- Test: readdir exclusion patterns

**`apps/client/src/lib/__tests__/fuzzy-match.test.ts`** — Extend existing:

- Test: indices for exact match
- Test: indices for subsequence match
- Test: indices length equals query length
- Test: empty query → empty indices

### Manual Smoke Tests

1. Type `@` → palette appears with project files
2. Type `@src/comp` → fuzzy matches files in src/components/
3. Select a file → `@src/components/ChatPanel.tsx ` inserted, palette closes
4. Select a directory → `@src/components/` inserted, palette stays open with narrowed results
5. Type `@` mid-sentence → palette triggers correctly
6. Arrow keys navigate, Enter/Tab selects, Escape dismisses
7. Switch directory → file list updates
8. Matched characters are highlighted in palette items
9. More than 50 matches → only top 50 shown
10. Non-git directory → readdir fallback works
11. Type `/` → command palette (not file palette) appears
12. Both `@file` and `/command` in same message works

---

## 6) Acceptance Criteria

### Functional

- [ ] Typing `@` after whitespace or at start of input opens file palette
- [ ] File palette shows files and directories from current working directory
- [ ] Fuzzy matching filters results as user types
- [ ] Selecting a file inserts `@relative/path ` at trigger position and closes palette
- [ ] Selecting a directory inserts `@dir/` and keeps palette open (drill-down)
- [ ] Keyboard navigation: Arrow Up/Down, Enter/Tab to select, Escape to dismiss
- [ ] Match highlighting shows which characters matched
- [ ] Changing cwd updates the file list
- [ ] `@` works mid-input (cursor-position based)
- [ ] Command palette (`/`) and file palette (`@`) coexist without conflicts

### Performance

- [ ] File list fetched once per cwd, cached for 5 minutes
- [ ] Fuzzy filtering completes in <5ms for 10k files
- [ ] No visible lag when typing in file query
- [ ] Git-based listing completes in <500ms for typical projects

### Display

- [ ] Filename rendered bold, directory path rendered dimmed
- [ ] File icon for files, folder icon for directories
- [ ] Max 50 items displayed (sorted by fuzzy score)
- [ ] Palette positioned above input (same as command palette)
- [ ] Matched characters visually highlighted

### Compatibility

- [ ] Works in standalone mode (HttpTransport)
- [ ] Works in Obsidian plugin mode (DirectTransport, graceful fallback)
- [ ] Existing slash command autocomplete unchanged
- [ ] `@path` text sent as-is to Agent SDK (no special parsing)

---

## 7) Deferred Work

- **File type icons by extension** — Map `.ts`→TS icon, `.css`→CSS icon, etc. Can add later without architectural changes.
- **MCP resource references** — `@server:protocol://resource` syntax. Different feature entirely.
- **File content preview on hover** — Would require server endpoint to read file content.
- **Virtual scrolling** — Not needed with 50-item cap. Add if we raise the limit.
- **Server-side search** — For repos with 100k+ files. Would add `query` param to `/api/files`.
- **Match highlighting in CommandPalette** — Now that fuzzyMatch returns indices, CommandPalette could adopt highlighting too. Separate PR.
