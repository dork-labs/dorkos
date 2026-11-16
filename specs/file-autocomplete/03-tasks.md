# Task Breakdown: File Autocomplete (`@` trigger)

**Spec:** [02-spec.md](./02-spec.md)
**Created:** 2026-02-13
**Total Tasks:** 7 (across 7 phases)
**New Files:** 4 | **Modified Files:** 9

---

## Dependency Graph

```
P1 (Shared Layer) ──┬──> P2 (Server) ──> P3 (Client Transports) ──> P5 (useFiles Hook) ──┐
                    │                                                                       ├──> P7 (ChatPanel Integration)
                    └──> P4 (fuzzyMatch Enhancement) ──> P6 (FilePalette Component) ────────┘
```

**Parallel opportunities:** P4 can run in parallel with P2 and P3 (no shared dependencies beyond P1).

---

## Task 1: [P1] Add FileListQuery and FileListResponse schemas to shared layer and listFiles to Transport interface

**Status:** pending
**Blocks:** Task 2, Task 3, Task 4, Task 5
**Files:** `packages/shared/src/schemas.ts` (modify), `packages/shared/src/transport.ts` (modify)

### Implementation

#### 1. `packages/shared/src/schemas.ts`

Add the following schemas after the `CommandsQuerySchema` / `CommandRegistrySchema` section and before the `BrowseDirectoryQuerySchema` section (or at any logical grouping point among the "query/response" schemas). Follow the exact same pattern as existing schemas:

```typescript
// === File Listing Types ===

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

#### 2. `packages/shared/src/transport.ts`

Add `FileListResponse` to the existing import from `'./types.js'`:

```typescript
import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,
  FileListResponse, // NEW
} from './types.js';
```

Add the new method to the `Transport` interface. Place it after `getCommands` and before `health` to keep file/directory methods grouped:

```typescript
export interface Transport {
  // ... existing methods ...
  getCommands(refresh?: boolean, cwd?: string): Promise<CommandRegistry>;
  listFiles(cwd: string): Promise<FileListResponse>; // NEW
  health(): Promise<HealthResponse>;
  getConfig(): Promise<ServerConfig>;
}
```

### Verification

- The shared package should typecheck cleanly: `npx turbo typecheck --filter=@dorkos/shared`
- Note: client and server will have compile errors until they implement the new `listFiles` method (Tasks 2, 3)
- The new types should be importable: `import type { FileListResponse } from '@dorkos/shared/types'`

---

## Task 2: [P2] Create FileListService, files route, and mount in app.ts

**Status:** pending
**Depends on:** Task 1
**Blocks:** Task 3
**Files:** `apps/server/src/services/file-lister.ts` (new), `apps/server/src/routes/files.ts` (new), `apps/server/src/app.ts` (modify)

### Implementation

#### 1. `apps/server/src/services/file-lister.ts` (NEW)

```typescript
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CacheEntry {
  files: string[];
  timestamp: number;
}

export class FileListService {
  private cache = new Map<string, CacheEntry>();
  private readonly MAX_FILES = 10_000;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }> {
    // Check cache
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return {
        files: cached.files,
        truncated: cached.files.length >= this.MAX_FILES,
        total: cached.files.length,
      };
    }

    let files: string[];
    try {
      files = await this.listViaGit(cwd);
    } catch {
      files = await this.listViaReaddir(cwd);
    }

    const truncated = files.length > this.MAX_FILES;
    if (truncated) {
      files = files.slice(0, this.MAX_FILES);
    }

    // Update cache
    this.cache.set(cwd, { files, timestamp: Date.now() });

    return { files, truncated, total: files.length };
  }

  private async listViaGit(cwd: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout.split('\n').filter((line) => line.length > 0);
  }

  private async listViaReaddir(cwd: string): Promise<string[]> {
    const EXCLUDED = new Set([
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'coverage',
      '__pycache__',
      '.cache',
    ]);
    const MAX_DEPTH = 8;
    const files: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= this.MAX_FILES) return;

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // Skip directories we can't read
      }

      for (const entry of entries) {
        if (files.length >= this.MAX_FILES) break;
        if (EXCLUDED.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(cwd, fullPath);

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          files.push(relativePath);
        }
      }
    };

    await walk(cwd, 0);
    return files;
  }

  invalidateCache(cwd?: string): void {
    if (cwd) {
      this.cache.delete(cwd);
    } else {
      this.cache.clear();
    }
  }
}

export const fileLister = new FileListService();
```

#### 2. `apps/server/src/routes/files.ts` (NEW)

```typescript
import { Router } from 'express';
import { FileListQuerySchema } from '@dorkos/shared/schemas';
import { fileLister } from '../services/file-lister.js';

const router = Router();

// GET /api/files?cwd=/path/to/project
router.get('/', async (req, res) => {
  const parsed = FileListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid query parameters',
      details: parsed.error.format(),
    });
  }

  try {
    const result = await fileLister.listFiles(parsed.data.cwd);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list files';
    res.status(500).json({ error: message });
  }
});

export default router;
```

#### 3. `apps/server/src/app.ts` (MODIFY)

Add import and route mount. The existing file has this structure:

```typescript
import sessionRoutes from './routes/sessions.js';
import commandRoutes from './routes/commands.js';
import healthRoutes from './routes/health.js';
import directoryRoutes from './routes/directory.js';
import configRoutes from './routes/config.js';
```

Add after `configRoutes`:

```typescript
import fileRoutes from './routes/files.js';
```

Then in the route mounting section:

```typescript
app.use('/api/sessions', sessionRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/directory', directoryRoutes);
app.use('/api/config', configRoutes);
app.use('/api/files', fileRoutes); // NEW
```

### Unit Tests

Create `apps/server/src/services/__tests__/file-lister.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process and fs/promises before importing
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

import { FileListService } from '../file-lister.js';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';

describe('FileListService', () => {
  let service: FileListService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FileListService();
  });

  it('returns file list from git', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      callback(null, { stdout: 'src/index.ts\nsrc/app.ts\n', stderr: '' });
      return {} as any;
    });

    const result = await service.listFiles('/test/cwd');
    expect(result.files).toEqual(['src/index.ts', 'src/app.ts']);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(2);
  });

  it('falls back to readdir when git fails', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      callback(new Error('not a git repo'), { stdout: '', stderr: '' });
      return {} as any;
    });

    vi.mocked(readdir).mockResolvedValue([
      { name: 'index.ts', isDirectory: () => false, isFile: () => true } as any,
    ]);

    const result = await service.listFiles('/test/cwd');
    expect(result.files).toHaveLength(1);
  });

  it('returns cached results on second call', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      callback(null, { stdout: 'file.ts\n', stderr: '' });
      return {} as any;
    });

    await service.listFiles('/test/cwd');
    await service.listFiles('/test/cwd');

    // execFile should only be called once due to caching
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('sets truncated=true when exceeding MAX_FILES', async () => {
    const manyFiles = Array.from({ length: 10_001 }, (_, i) => `file${i}.ts`).join('\n') + '\n';
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      callback(null, { stdout: manyFiles, stderr: '' });
      return {} as any;
    });

    const result = await service.listFiles('/test/cwd');
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBe(10_000);
  });

  it('excludes node_modules in readdir strategy', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
      const callback = cb || _opts;
      callback(new Error('not a git repo'), { stdout: '', stderr: '' });
      return {} as any;
    });

    vi.mocked(readdir).mockResolvedValue([
      { name: 'node_modules', isDirectory: () => true, isFile: () => false } as any,
      { name: 'src', isDirectory: () => true, isFile: () => false } as any,
      { name: 'index.ts', isDirectory: () => false, isFile: () => true } as any,
    ]);

    const result = await service.listFiles('/test/cwd');
    // node_modules should be excluded, only index.ts should be present
    // (src is a directory so it would be walked, but readdir for src is not mocked so it returns nothing)
    expect(result.files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});
```

### Verification

- `npx turbo typecheck --filter=@dorkos/server` should pass
- `npx vitest run apps/server/src/services/__tests__/file-lister.test.ts` should pass
- `npx turbo dev --filter=@dorkos/server` then `curl 'http://localhost:4242/api/files?cwd=/path/to/project'` should return JSON with `files`, `truncated`, `total`

---

## Task 3: [P3] Add listFiles method to HttpTransport and DirectTransport

**Status:** pending
**Depends on:** Task 1, Task 2
**Blocks:** Task 5
**Files:** `apps/client/src/lib/http-transport.ts` (modify), `apps/client/src/lib/direct-transport.ts` (modify)

### Implementation

#### 1. `apps/client/src/lib/http-transport.ts`

Add `FileListResponse` to the type import at the top:

```typescript
import type {
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  StreamEvent,
  TaskItem,
  ServerConfig,
  FileListResponse, // NEW
} from '@dorkos/shared/types';
```

Add the new method to the `HttpTransport` class. Place it after `getCommands` and before `health`, matching the Transport interface order:

```typescript
  listFiles(cwd: string): Promise<FileListResponse> {
    const params = new URLSearchParams({ cwd });
    return fetchJSON<FileListResponse>(this.baseUrl, `/files?${params}`);
  }
```

#### 2. `apps/client/src/lib/direct-transport.ts`

Add `FileListResponse` to the type import at the top:

```typescript
import type {
  StreamEvent,
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  HealthResponse,
  PermissionMode,
  HistoryMessage,
  CommandRegistry,
  TaskItem,
  ServerConfig,
  FileListResponse, // NEW
} from '@dorkos/shared/types';
```

Add to the `DirectTransportServices` interface (after `commandRegistry`):

```typescript
export interface DirectTransportServices {
  // ... existing services ...
  commandRegistry: {
    getCommands(forceRefresh?: boolean): Promise<CommandRegistry>;
  };
  fileLister?: {
    // NEW - optional because Obsidian plugin may not provide it yet
    listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }>;
  };
  vaultRoot: string;
}
```

Add the method to the `DirectTransport` class (after `getCommands`, before `health`):

```typescript
  async listFiles(cwd: string): Promise<FileListResponse> {
    if (this.services.fileLister) {
      return this.services.fileLister.listFiles(cwd);
    }
    // Fallback: return empty when Obsidian plugin doesn't provide file lister
    return { files: [], truncated: false, total: 0 };
  }
```

### Verification

- `npx turbo typecheck --filter=@dorkos/client` should pass (once all Transport methods are implemented)
- Both transport classes now satisfy the `Transport` interface with the new `listFiles` method

---

## Task 4: [P4] Enhance fuzzyMatch to return match indices and add tests

**Status:** pending
**Depends on:** Task 1 (only for consistency, can technically start in parallel)
**Blocks:** Task 6
**Files:** `apps/client/src/lib/fuzzy-match.ts` (modify), `apps/client/src/lib/__tests__/fuzzy-match.test.ts` (modify)

### Implementation

#### 1. `apps/client/src/lib/fuzzy-match.ts`

Replace the entire file with the enhanced version that adds `indices` to the return type. This is backwards-compatible -- existing callers that destructure `{ match, score }` will continue to work.

```typescript
/**
 * Simple subsequence fuzzy matcher for command palette filtering.
 * Returns whether all characters in query appear in target in order,
 * plus a score that rewards consecutive character matches,
 * plus the indices of matched characters in target.
 */
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

#### 2. `apps/client/src/lib/__tests__/fuzzy-match.test.ts`

Update existing tests to include `indices` in expected values, and add new tests for the `indices` feature:

```typescript
import { describe, it, expect } from 'vitest';
import { fuzzyMatch } from '../fuzzy-match';

describe('fuzzyMatch', () => {
  it('matches empty query against anything', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ match: true, score: 0, indices: [] });
    expect(fuzzyMatch('', '')).toEqual({ match: true, score: 0, indices: [] });
  });

  it('matches exact string', () => {
    const result = fuzzyMatch('debug', 'debug');
    expect(result.match).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('matches subsequence characters in order', () => {
    const result = fuzzyMatch('drt', 'debug:rubber-duck-test');
    expect(result.match).toBe(true);
  });

  it('does not match when characters are out of order', () => {
    const result = fuzzyMatch('trd', 'debug:rubber-duck-test');
    expect(result.match).toBe(false);
  });

  it('does not match when characters are missing', () => {
    const result = fuzzyMatch('xyz', 'debug:test');
    expect(result.match).toBe(false);
  });

  it('is case-insensitive', () => {
    const result = fuzzyMatch('DEBUG', 'debug:test');
    expect(result.match).toBe(true);
  });

  it('scores consecutive matches higher than scattered', () => {
    const consecutive = fuzzyMatch('deb', 'debug:test');
    const scattered = fuzzyMatch('det', 'debug:test');
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it('matches colon-separated command names', () => {
    expect(fuzzyMatch('debug:t', '/debug:test').match).toBe(true);
    expect(fuzzyMatch('git:c', '/git:commit').match).toBe(true);
  });

  it('matches partial namespace and command', () => {
    expect(fuzzyMatch('dbr', '/debug:rubber-duck').match).toBe(true);
  });

  // === New indices tests ===

  it('returns empty indices for empty query', () => {
    const result = fuzzyMatch('', 'anything');
    expect(result.indices).toEqual([]);
  });

  it('returns sequential indices for exact match', () => {
    const result = fuzzyMatch('abc', 'abc');
    expect(result.indices).toEqual([0, 1, 2]);
  });

  it('returns sequential indices for exact prefix match', () => {
    const result = fuzzyMatch('src', 'src/index.ts');
    expect(result.indices).toEqual([0, 1, 2]);
  });

  it('returns non-sequential indices for subsequence match', () => {
    const result = fuzzyMatch('sit', 'src/index.ts');
    // s=0, i=4, t=10
    expect(result.match).toBe(true);
    expect(result.indices).toEqual([0, 4, 10]);
  });

  it('indices length equals query length when match is true', () => {
    const result = fuzzyMatch('drt', 'debug:rubber-duck-test');
    expect(result.match).toBe(true);
    expect(result.indices).toHaveLength(3);
  });

  it('indices are empty when match is false', () => {
    const result = fuzzyMatch('xyz', 'abc');
    expect(result.match).toBe(false);
    // indices may be partial (characters found before failure), but match is false
  });

  it('returns correct indices for case-insensitive match', () => {
    const result = fuzzyMatch('ABC', 'abcdef');
    expect(result.match).toBe(true);
    expect(result.indices).toEqual([0, 1, 2]);
  });

  it('returns correct indices for file path matching', () => {
    const result = fuzzyMatch('cp', 'src/components/chat/ChatPanel.tsx');
    expect(result.match).toBe(true);
    // Each index should be within bounds
    for (const idx of result.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan('src/components/chat/ChatPanel.tsx'.length);
    }
    expect(result.indices).toHaveLength(2);
  });
});
```

### Verification

- `npx vitest run apps/client/src/lib/__tests__/fuzzy-match.test.ts` should pass all tests
- Existing callers of `fuzzyMatch` that destructure `{ match, score }` continue to work unchanged

---

## Task 5: [P5] Create useFiles React Query hook

**Status:** pending
**Depends on:** Task 1, Task 3
**Blocks:** Task 7
**Files:** `apps/client/src/hooks/use-files.ts` (new)

### Implementation

#### `apps/client/src/hooks/use-files.ts` (NEW)

Follow the exact same pattern as `apps/client/src/hooks/use-commands.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../contexts/TransportContext';
import type { FileListResponse } from '@dorkos/shared/types';

export function useFiles(cwd?: string | null) {
  const transport = useTransport();
  return useQuery<FileListResponse>({
    queryKey: ['files', { cwd: cwd ?? null }],
    queryFn: () => transport.listFiles(cwd!),
    enabled: !!cwd,
    staleTime: 5 * 60 * 1000, // 5 minutes (matches server cache TTL)
    gcTime: 30 * 60 * 1000, // 30 minutes garbage collection
  });
}
```

### Key Design Decisions

- `enabled: !!cwd` ensures no request fires until a working directory is set
- `staleTime: 5 * 60 * 1000` matches the server-side cache TTL of 5 minutes
- `queryKey` includes `cwd` so changing directories triggers a fresh fetch
- The hook accepts `null | undefined` for `cwd` to handle the pre-directory-selection state gracefully

### Verification

- `npx turbo typecheck --filter=@dorkos/client` should pass
- The hook should be importable: `import { useFiles } from '../hooks/use-files'`

---

## Task 6: [P6] Create FilePalette component with match highlighting

**Status:** pending
**Depends on:** Task 4
**Blocks:** Task 7
**Files:** `apps/client/src/components/files/FilePalette.tsx` (new)

### Implementation

#### `apps/client/src/components/files/FilePalette.tsx` (NEW)

Follow the exact same animation and accessibility patterns as `apps/client/src/components/commands/CommandPalette.tsx`:

```typescript
import { useEffect } from 'react';
import { motion } from 'motion/react';
import { File, Folder } from 'lucide-react';

export interface FileEntry {
  path: string;       // relative path: "src/components/chat/ChatPanel.tsx"
  filename: string;   // "ChatPanel.tsx"
  directory: string;  // "src/components/chat/"
  isDirectory: boolean;
}

interface FilePaletteProps {
  filteredFiles: Array<FileEntry & { indices: number[] }>;
  selectedIndex: number;
  onSelect: (entry: FileEntry) => void;
}

/**
 * Renders text with matched characters highlighted.
 * indices are positions in the full path; startOffset maps them
 * to positions within the displayed text segment.
 */
function HighlightedText({
  text,
  indices,
  startOffset = 0,
}: {
  text: string;
  indices: number[];
  startOffset?: number;
}) {
  const highlightSet = new Set(indices.map((i) => i - startOffset));
  return (
    <>
      {text.split('').map((char, i) =>
        highlightSet.has(i) ? (
          <span key={i} className="font-semibold text-foreground">
            {char}
          </span>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </>
  );
}

export function FilePalette({
  filteredFiles,
  selectedIndex,
  onSelect,
}: FilePaletteProps) {
  // Scroll active item into view when selection changes
  useEffect(() => {
    const activeEl = document.getElementById(`file-item-${selectedIndex}`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-hidden rounded-lg border bg-popover shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        id="file-palette-listbox"
        role="listbox"
        className="max-h-72 overflow-y-auto p-2"
      >
        {filteredFiles.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No files found.
          </div>
        ) : (
          filteredFiles.map((entry, index) => {
            const isSelected = index === selectedIndex;
            const Icon = entry.isDirectory ? Folder : File;
            return (
              <div
                key={entry.path}
                id={`file-item-${index}`}
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected}
                onClick={() => onSelect(entry)}
                className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors duration-100 data-[selected=true]:bg-ring/10 data-[selected=true]:text-foreground hover:bg-muted"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm truncate">
                  <HighlightedText
                    text={entry.filename}
                    indices={entry.indices}
                    startOffset={entry.directory.length}
                  />
                </span>
                {entry.directory && (
                  <span className="text-xs text-muted-foreground truncate">
                    {entry.directory}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </motion.div>
  );
}
```

### Key Design Decisions

- Same animation values as CommandPalette (`opacity: 0, scale: 0.98, y: 4`)
- Same `onMouseDown={e => e.preventDefault()}` to prevent textarea blur
- `HighlightedText` uses `startOffset` to map full-path indices to the filename/directory segment being rendered
- File icon (`File`) for files, folder icon (`Folder`) for directories from Lucide
- `data-selected` attribute for CSS-driven highlight (same pattern as CommandPalette)
- `role="listbox"` / `role="option"` for accessibility
- Flat list (no namespace grouping unlike CommandPalette)
- Max items capped at 50 in the parent (ChatPanel), not in this component

### Verification

- Component should render without errors when given mock data
- `npx turbo typecheck --filter=@dorkos/client` should pass

---

## Task 7: [P7] Integrate file autocomplete into ChatInput and ChatPanel

**Status:** pending
**Depends on:** Task 5, Task 6
**Files:** `apps/client/src/components/chat/ChatInput.tsx` (modify), `apps/client/src/components/chat/ChatPanel.tsx` (modify)

### Implementation

#### 1. `apps/client/src/components/chat/ChatInput.tsx` (MODIFY)

Add `onCursorChange` prop and wire it up:

**Props interface** -- add:

```typescript
interface ChatInputProps {
  // ... existing props ...
  onCursorChange?: (pos: number) => void; // NEW
}
```

**Destructure** -- add `onCursorChange` to the destructured props.

**handleChange** -- after calling `onChange(e.target.value)`, call `onCursorChange`:

```typescript
const handleChange = useCallback(
  (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    onCursorChange?.(e.target.selectionStart); // NEW
    // Auto-resize textarea
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  },
  [onChange, onCursorChange] // ADD onCursorChange to deps
);
```

**Add `handleSelect`** -- new callback to catch cursor repositioning (click, shift+arrow):

```typescript
const handleSelect = useCallback(() => {
  if (textareaRef.current) {
    onCursorChange?.(textareaRef.current.selectionStart);
  }
}, [onCursorChange]);
```

**Wire `onSelect` on the textarea element**:

```typescript
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onSelect={handleSelect}  // NEW
        role="combobox"
        // ... rest unchanged ...
      />
```

**Update aria-controls** -- it should reference either `command-palette-listbox` or `file-palette-listbox` depending on which is open. For simplicity, keep it as-is (the parent `ChatPanel` controls `isPaletteOpen` to cover both palettes now).

#### 2. `apps/client/src/components/chat/ChatPanel.tsx` (MODIFY)

This is the largest change. Add file autocomplete state, detection, filtering, selection, and rendering alongside the existing command palette.

**New imports** -- add at the top:

```typescript
import { useFiles } from '../../hooks/use-files';
import { FilePalette } from '../files/FilePalette';
import type { FileEntry } from '../files/FilePalette';
```

**New state variables** -- add after the existing command state variables:

```typescript
// File autocomplete state
const [showFiles, setShowFiles] = useState(false);
const [fileQuery, setFileQuery] = useState('');
const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
const [fileTriggerPos, setFileTriggerPos] = useState(-1);
const [cursorPos, setCursorPos] = useState(0);
```

**useFiles hook** -- add after `useCommands`:

```typescript
const { data: fileList } = useFiles(cwd);
```

**`allFileEntries` memo** -- add after `filteredCommands` memo:

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
```

**`filteredFiles` memo** -- add after `allFileEntries`:

```typescript
const filteredFiles = useMemo(() => {
  if (!showFiles) return [];
  if (!fileQuery)
    return allFileEntries.slice(0, 50).map((e) => ({ ...e, indices: [] as number[] }));
  return allFileEntries
    .map((entry) => {
      const result = fuzzyMatch(fileQuery, entry.path);
      return { ...entry, ...result };
    })
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
}, [allFileEntries, fileQuery, showFiles]);
```

**Reset fileSelectedIndex** when filter changes:

```typescript
useEffect(() => {
  setFileSelectedIndex(0);
}, [fileQuery, showFiles]);

// Clamp fileSelectedIndex
useEffect(() => {
  if (filteredFiles.length > 0 && fileSelectedIndex >= filteredFiles.length) {
    setFileSelectedIndex(filteredFiles.length - 1);
  }
}, [filteredFiles.length, fileSelectedIndex]);
```

**Replace `handleInputChange`** -- use cursor-position-based trigger detection for BOTH `@` and `/`:

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

  // Check for / trigger (command autocomplete)
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

function handleInputChange(value: string) {
  setInput(value);
  // Use current cursorPos for detection; if the textarea hasn't reported
  // a cursor position yet, assume end-of-input
  detectTrigger(value, cursorPos || value.length);
}
```

**Add cursor change handler** that also re-runs detection:

```typescript
const handleCursorChange = useCallback(
  (pos: number) => {
    setCursorPos(pos);
    detectTrigger(input, pos);
  },
  [input]
);
```

NOTE: `detectTrigger` references state setters and will need to either be inline or wrapped appropriately. Since `handleInputChange` and `handleCursorChange` both call it, keeping it as a plain function inside the component body (not wrapped in `useCallback`) is the simplest approach, matching the existing `handleInputChange` pattern.

**Add `handleFileSelect`**:

```typescript
function handleFileSelect(entry: FileEntry) {
  const before = input.slice(0, fileTriggerPos);
  const after = input.slice(cursorPos);

  if (entry.isDirectory) {
    // Directory: insert @dir/ and keep palette open for drill-down
    const newValue = before + '@' + entry.path + after;
    const newCursor = before.length + 1 + entry.path.length;
    setInput(newValue);
    setCursorPos(newCursor);
    setFileQuery(entry.path);
    // Palette stays open -- detectTrigger will re-fire with new text
  } else {
    // File: insert @path and close palette
    const newValue = before + '@' + entry.path + ' ' + after;
    setInput(newValue);
    setShowFiles(false);
  }
}
```

**Update keyboard handlers** to dispatch to correct palette:

```typescript
const isPaletteOpen = showCommands || showFiles;

const handleArrowDown = useCallback(() => {
  if (showCommands) {
    setSelectedIndex((prev) =>
      filteredCommands.length === 0 ? 0 : (prev + 1) % filteredCommands.length
    );
  } else if (showFiles) {
    setFileSelectedIndex((prev) =>
      filteredFiles.length === 0 ? 0 : (prev + 1) % filteredFiles.length
    );
  }
}, [showCommands, showFiles, filteredCommands.length, filteredFiles.length]);

const handleArrowUp = useCallback(() => {
  if (showCommands) {
    setSelectedIndex((prev) =>
      filteredCommands.length === 0
        ? 0
        : (prev - 1 + filteredCommands.length) % filteredCommands.length
    );
  } else if (showFiles) {
    setFileSelectedIndex((prev) =>
      filteredFiles.length === 0 ? 0 : (prev - 1 + filteredFiles.length) % filteredFiles.length
    );
  }
}, [showCommands, showFiles, filteredCommands.length, filteredFiles.length]);

const handleKeyboardSelect = useCallback(() => {
  if (showCommands) {
    if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
      handleCommandSelect(filteredCommands[selectedIndex]);
    } else {
      setShowCommands(false);
    }
  } else if (showFiles) {
    if (filteredFiles.length > 0 && fileSelectedIndex < filteredFiles.length) {
      handleFileSelect(filteredFiles[fileSelectedIndex]);
    } else {
      setShowFiles(false);
    }
  }
}, [showCommands, showFiles, filteredCommands, selectedIndex, filteredFiles, fileSelectedIndex]);
```

**Update `activeDescendantId`**:

```typescript
const activeDescendantId =
  showCommands && filteredCommands.length > 0
    ? `command-item-${selectedIndex}`
    : showFiles && filteredFiles.length > 0
      ? `file-item-${fileSelectedIndex}`
      : undefined;
```

**Update JSX** -- add FilePalette alongside CommandPalette, update ChatInput props:

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
    onCursorChange={handleCursorChange}
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

  <StatusLine
    sessionId={sessionId}
    sessionStatus={sessionStatus}
    isStreaming={status === 'streaming'}
  />
</div>
```

### Verification

- `npx turbo typecheck --filter=@dorkos/client` should pass
- `npx turbo dev` then open the UI, type `@` in the chat input -- the file palette should appear
- Type `@src/comp` -- fuzzy matches should filter to files in `src/components/`
- Select a file -- `@src/components/ChatPanel.tsx ` should be inserted
- Select a directory -- `@src/` should be inserted and palette stays open
- Type `/` -- command palette appears (not file palette)
- Both `@file` and `/command` in same message should work
- Arrow keys, Enter/Tab, Escape all work correctly for both palettes

---

## Summary

| Phase | Task                              | Files                         | Status  |
| ----- | --------------------------------- | ----------------------------- | ------- |
| P1    | Shared schemas + transport        | 2 modified                    | pending |
| P2    | Server service + route            | 2 new, 1 modified, 1 new test | pending |
| P3    | Client transports                 | 2 modified                    | pending |
| P4    | fuzzyMatch enhancement            | 1 modified, 1 modified test   | pending |
| P5    | useFiles hook                     | 1 new                         | pending |
| P6    | FilePalette component             | 1 new                         | pending |
| P7    | ChatInput + ChatPanel integration | 2 modified                    | pending |

**Critical path:** P1 -> P2 -> P3 -> P5 -> P7
**Parallel track:** P1 -> P4 -> P6 -> P7
