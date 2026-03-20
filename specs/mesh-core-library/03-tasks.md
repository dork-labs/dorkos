---
slug: mesh-core-library
number: 54
created: 2026-02-24
status: draft
---

# Tasks: Mesh Core Library (`@dorkos/mesh`)

**Spec:** [02-specification.md](./02-specification.md)
**Total Tasks:** 17
**Phases:** 4

---

## Phase 1: Foundation (Schemas + Package Setup)

### Task 1.1: Create Zod schemas in `@dorkos/shared/mesh-schemas`

**Subject:** `[mesh-core-library] [P1] Create Zod schemas in @dorkos/shared/mesh-schemas`
**Dependencies:** None

Create `packages/shared/src/mesh-schemas.ts` with all Mesh Zod schemas and add the `./mesh-schemas` subpath export to `packages/shared/package.json`.

**File: `packages/shared/src/mesh-schemas.ts` (NEW)**

```typescript
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// --- Agent Runtime ---

export const AgentRuntimeSchema = z
  .enum(['claude-code', 'cursor', 'codex', 'other'])
  .openapi('AgentRuntime');

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

// --- Agent Behavior ---

export const AgentBehaviorSchema = z
  .object({
    responseMode: z.enum(['always', 'direct-only', 'mention-only', 'silent']).default('always'),
    escalationThreshold: z.number().optional(),
  })
  .openapi('AgentBehavior');

export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

// --- Agent Budget ---

export const AgentBudgetSchema = z
  .object({
    maxHopsPerMessage: z.number().int().min(1).default(5),
    maxCallsPerHour: z.number().int().min(1).default(100),
  })
  .openapi('AgentBudget');

export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

// --- Agent Manifest ---

export const AgentManifestSchema = z
  .object({
    id: z.string().min(1).describe('ULID assigned at registration'),
    name: z.string().min(1),
    description: z.string().default(''),
    runtime: AgentRuntimeSchema,
    capabilities: z.array(z.string()).default([]),
    behavior: AgentBehaviorSchema.default({}),
    budget: AgentBudgetSchema.default({}),
    registeredAt: z.string().datetime(),
    registeredBy: z.string().min(1),
  })
  .openapi('AgentManifest');

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// --- Discovery Hints ---

export const AgentHintsSchema = z
  .object({
    suggestedName: z.string(),
    detectedRuntime: AgentRuntimeSchema,
    inferredCapabilities: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .openapi('AgentHints');

export type AgentHints = z.infer<typeof AgentHintsSchema>;

// --- Discovery Candidate ---

export const DiscoveryCandidateSchema = z
  .object({
    path: z.string().min(1),
    strategy: z.string().min(1),
    hints: AgentHintsSchema,
    discoveredAt: z.string().datetime(),
  })
  .openapi('DiscoveryCandidate');

export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;

// --- Denial Record ---

export const DenialRecordSchema = z
  .object({
    path: z.string().min(1),
    strategy: z.string().min(1),
    reason: z.string().optional(),
    deniedBy: z.string().min(1),
    deniedAt: z.string().datetime(),
  })
  .openapi('DenialRecord');

export type DenialRecord = z.infer<typeof DenialRecordSchema>;
```

**File: `packages/shared/package.json` (MODIFY)**

Add this subpath export alongside the existing ones:

```json
"./mesh-schemas": {
  "types": "./src/mesh-schemas.ts",
  "default": "./dist/mesh-schemas.js"
}
```

**Verification:**

- `npm run typecheck` passes
- All schemas export both the Zod schema and inferred TypeScript type
- OpenAPI metadata is attached via `.openapi()`

---

### Task 1.2: Create `packages/mesh/` package scaffold

**Subject:** `[mesh-core-library] [P1] Create packages/mesh/ package scaffold`
**Dependencies:** None (parallel with Task 1.1)

Create the `packages/mesh/` directory with configuration files.

**File: `packages/mesh/package.json` (NEW)**

```json
{
  "name": "@dorkos/mesh",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@dorkos/shared": "*",
    "better-sqlite3": "^11.0.0",
    "ulidx": "^2.4.0"
  },
  "peerDependencies": {
    "@dorkos/relay": "*"
  },
  "peerDependenciesMeta": {
    "@dorkos/relay": { "optional": true }
  },
  "devDependencies": {
    "@dorkos/relay": "*",
    "@dorkos/typescript-config": "*",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

**File: `packages/mesh/tsconfig.json` (NEW)**

```json
{
  "extends": "@dorkos/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

**File: `packages/mesh/vitest.config.ts` (NEW)**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
  },
});
```

**File: `packages/mesh/src/index.ts` (NEW)**

```typescript
/**
 * @dorkos/mesh -- Agent discovery, registration, and registry for DorkOS.
 *
 * Provides pluggable discovery strategies, SQLite-backed persistence,
 * manifest management, and optional Relay integration.
 *
 * @module mesh
 */

// Populated as modules are created in subsequent tasks
```

---

### Task 1.3: Integrate mesh package into workspace

**Subject:** `[mesh-core-library] [P1] Integrate mesh package into workspace`
**Dependencies:** Task 1.1, Task 1.2

**File: `vitest.workspace.ts` (MODIFY)**

Add `'packages/mesh'` to the workspace array:

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/client',
  'apps/roadmap',
  'apps/server',
  'packages/cli',
  'packages/mesh',
  'packages/relay',
  'packages/shared',
]);
```

**Steps:**

1. Run `npm install` to resolve the new workspace package
2. Run `npm run typecheck` to verify the package compiles
3. Verify `packages/mesh` appears in workspace resolution

---

## Phase 2: Discovery (Strategies + Engine)

### Task 2.1: Create `DiscoveryStrategy` interface

**Subject:** `[mesh-core-library] [P2] Create DiscoveryStrategy interface`
**Dependencies:** Task 1.1 (needs AgentHints type)

Create `packages/mesh/src/discovery-strategy.ts` with the strategy interface.

**File: `packages/mesh/src/discovery-strategy.ts` (NEW)**

```typescript
import type { AgentHints } from '@dorkos/shared/mesh-schemas';

/**
 * A pluggable strategy for detecting agent projects by filesystem markers.
 *
 * Each strategy knows how to recognize a specific type of agent project
 * (e.g., Claude Code projects have .claude/ with CLAUDE.md).
 */
export interface DiscoveryStrategy {
  /** Unique strategy identifier (e.g., "claude-code", "cursor", "codex"). */
  readonly name: string;

  /** Check if the given directory matches this strategy's detection criteria. */
  detect(dir: string): Promise<boolean>;

  /** Extract hints (name, runtime, capabilities) from a detected directory. */
  extractHints(dir: string): Promise<AgentHints>;
}
```

Export from `src/index.ts`:

```typescript
export type { DiscoveryStrategy } from './discovery-strategy.js';
```

---

### Task 2.2: Implement built-in discovery strategies

**Subject:** `[mesh-core-library] [P2] Implement built-in discovery strategies`
**Dependencies:** Task 2.1

Create three strategy files in `packages/mesh/src/strategies/`.

**File: `packages/mesh/src/strategies/claude-code-strategy.ts` (NEW)**

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../discovery-strategy.js';

/**
 * Detects Claude Code agent projects by the presence of .claude/ directory
 * containing a CLAUDE.md file.
 */
export class ClaudeCodeStrategy implements DiscoveryStrategy {
  readonly name = 'claude-code';

  async detect(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, '.claude'));
      await fs.access(path.join(dir, '.claude', 'CLAUDE.md'));
      return true;
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'claude-code',
    };
  }
}
```

**File: `packages/mesh/src/strategies/cursor-strategy.ts` (NEW)**

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../discovery-strategy.js';

/**
 * Detects Cursor agent projects by the presence of .cursor/ directory.
 */
export class CursorStrategy implements DiscoveryStrategy {
  readonly name = 'cursor';

  async detect(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, '.cursor'));
      return true;
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'cursor',
    };
  }
}
```

**File: `packages/mesh/src/strategies/codex-strategy.ts` (NEW)**

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../discovery-strategy.js';

/**
 * Detects Codex agent projects by the presence of .codex/ directory.
 */
export class CodexStrategy implements DiscoveryStrategy {
  readonly name = 'codex';

  async detect(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, '.codex'));
      return true;
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'codex',
    };
  }
}
```

Export all strategies from `src/index.ts`:

```typescript
export { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
export { CursorStrategy } from './strategies/cursor-strategy.js';
export { CodexStrategy } from './strategies/codex-strategy.js';
```

---

### Task 2.3: Write strategy tests

**Subject:** `[mesh-core-library] [P2] Write strategy tests`
**Dependencies:** Task 2.2

Create `packages/mesh/src/__tests__/strategies.test.ts` and test fixture directories.

**Test fixture directories to create:**

```
packages/mesh/src/__tests__/fixtures/
├── claude-project/.claude/CLAUDE.md
├── cursor-project/.cursor/
├── codex-project/.codex/
├── claude-no-md/.claude/           (no CLAUDE.md - edge case)
└── empty-project/
```

**Test cases:**

1. `ClaudeCodeStrategy.detect()` returns `true` for `claude-project/`
2. `ClaudeCodeStrategy.detect()` returns `false` for `claude-no-md/` (`.claude/` exists but no `CLAUDE.md`)
3. `ClaudeCodeStrategy.detect()` returns `false` for `empty-project/`
4. `ClaudeCodeStrategy.extractHints()` returns `{ suggestedName: 'claude-project', detectedRuntime: 'claude-code' }`
5. `CursorStrategy.detect()` returns `true` for `cursor-project/`
6. `CursorStrategy.detect()` returns `false` for `empty-project/`
7. `CursorStrategy.extractHints()` returns `{ suggestedName: 'cursor-project', detectedRuntime: 'cursor' }`
8. `CodexStrategy.detect()` returns `true` for `codex-project/`
9. `CodexStrategy.detect()` returns `false` for `empty-project/`
10. `CodexStrategy.extractHints()` returns `{ suggestedName: 'codex-project', detectedRuntime: 'codex' }`

Use `fs.mkdtemp()` for temp directories in tests. Clean up in `afterEach`.

---

### Task 2.4: Implement discovery engine

**Subject:** `[mesh-core-library] [P2] Implement discovery engine`
**Dependencies:** Task 2.2, Task 1.1

Create `packages/mesh/src/discovery-engine.ts` with async BFS scanner.

**File: `packages/mesh/src/discovery-engine.ts` (NEW)**

```typescript
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import type { DiscoveryCandidate, AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from './discovery-strategy.js';
import type { AgentRegistry } from './agent-registry.js';
import type { DenialList } from './denial-list.js';
import { readManifest } from './manifest.js';

/** Directories excluded from BFS traversal. */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.DS_Store',
]);

export interface DiscoveryOptions {
  maxDepth?: number; // Default: 5
  excludedDirs?: Set<string>; // Default: EXCLUDED_DIRS
  followSymlinks?: boolean; // Default: false
}

/** Event emitted when an existing .dork/agent.json is found during scan. */
export interface AutoImportedAgent {
  type: 'auto-import';
  manifest: AgentManifest;
  path: string;
}

/**
 * Scan directories for agent candidates using depth-limited async BFS.
 *
 * @param rootDir - Root directory to start scanning from
 * @param strategies - Discovery strategies to apply at each directory
 * @param registry - Agent registry for filtering already-registered paths
 * @param denialList - Denial list for filtering denied paths
 * @param options - Scan configuration (depth, exclusions, symlinks)
 */
export async function* scanDirectory(
  rootDir: string,
  strategies: DiscoveryStrategy[],
  registry: AgentRegistry,
  denialList: DenialList,
  options: DiscoveryOptions = {}
): AsyncGenerator<DiscoveryCandidate | AutoImportedAgent> {
  const maxDepth = options.maxDepth ?? 5;
  const excludedDirs = options.excludedDirs ?? EXCLUDED_DIRS;
  const followSymlinks = options.followSymlinks ?? false;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const visited = new Set<string>(); // realpath-based cycle detection

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue; // Can't resolve path, skip
    }

    if (visited.has(realDir)) continue;
    visited.add(realDir);

    // Check for existing .dork/agent.json -> auto-import
    const manifest = await readManifest(dir);
    if (manifest) {
      yield { type: 'auto-import', manifest, path: dir };
      continue; // Don't run strategies on already-manifested dirs
    }

    // Check if denied -> skip
    if (denialList.isDenied(realDir)) continue;

    // Check if already registered -> skip
    if (registry.getByPath(realDir)) continue;

    // Run strategies -> yield candidates
    for (const strategy of strategies) {
      try {
        if (await strategy.detect(dir)) {
          const hints = await strategy.extractHints(dir);
          yield {
            path: dir,
            strategy: strategy.name,
            hints,
            discoveredAt: new Date().toISOString(),
          };
          break; // First match wins
        }
      } catch {
        // Strategy error, continue to next
      }
    }

    // Enqueue subdirectories
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !(followSymlinks && entry.isSymbolicLink())) continue;
        if (
          entry.name.startsWith('.') &&
          entry.name !== '.claude' &&
          entry.name !== '.cursor' &&
          entry.name !== '.codex' &&
          entry.name !== '.dork'
        )
          continue;
        if (excludedDirs.has(entry.name)) continue;

        // Skip symlinks when followSymlinks is false
        if (entry.isSymbolicLink() && !followSymlinks) continue;

        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    } catch (err: unknown) {
      // EACCES/EPERM: silently skip inaccessible directories
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') {
        // Log warning for other errors but continue
        console.warn(`Discovery: error reading ${dir}: ${(err as Error).message}`);
      }
    }
  }
}
```

**Important implementation notes:**

- The BFS does NOT descend into dot-directories except `.claude`, `.cursor`, `.codex`, and `.dork`
- First strategy match wins (no multi-strategy matches per directory)
- `readManifest()` dependency means this task depends on Task 3.3 at implementation time, but the interface/type can be stubbed initially
- Export `scanDirectory`, `EXCLUDED_DIRS`, `DiscoveryOptions`, `AutoImportedAgent` from `src/index.ts`

---

### Task 2.5: Write discovery engine tests

**Subject:** `[mesh-core-library] [P2] Write discovery engine tests`
**Dependencies:** Task 2.4, Task 2.3

Create `packages/mesh/src/__tests__/discovery-engine.test.ts`.

**Test fixture structure (created in temp dir per test):**

```
tmpDir/
├── project-a/.claude/CLAUDE.md
├── project-b/.cursor/
├── deep/nested/project-c/.codex/
├── node_modules/hidden/.claude/CLAUDE.md   (should be excluded)
├── registered-project/.dork/agent.json     (should be auto-imported)
└── denied-project/.claude/CLAUDE.md        (should be filtered)
```

**Test cases:**

1. BFS traversal finds agents in nested directories up to maxDepth
2. `maxDepth: 1` skips `deep/nested/project-c/`
3. `node_modules/` is in EXCLUDED_DIRS, so `hidden/` is never reached
4. Already-registered paths (via mock registry.getByPath) are skipped
5. Denied paths (via mock denialList.isDenied) are skipped
6. Existing `.dork/agent.json` yields `AutoImportedAgent` event
7. EACCES directories are silently skipped
8. Symlink cycles are detected and skipped when `followSymlinks: true`
9. Symlinks are ignored entirely when `followSymlinks: false`

**Mock approach:**

- Use real temp filesystem fixtures for directory structure
- Use simple mock objects for `AgentRegistry` and `DenialList` with `vi.fn()` methods

---

## Phase 3: Persistence (Registry + Denial List + Manifest)

### Task 3.1: Implement agent registry

**Subject:** `[mesh-core-library] [P3] Implement agent registry with SQLite persistence`
**Dependencies:** Task 1.1, Task 1.2

Create `packages/mesh/src/agent-registry.ts` with SQLite persistence following the `packages/relay/src/sqlite-index.ts` pattern.

**File: `packages/mesh/src/agent-registry.ts` (NEW)**

**SQL DDL (Migration 1):**

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL UNIQUE,
  runtime TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  manifest_json TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  registered_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_project_path ON agents(project_path);
CREATE INDEX IF NOT EXISTS idx_agents_runtime ON agents(runtime);
```

**AgentRegistryEntry type:**

```typescript
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

export interface AgentRegistryEntry extends AgentManifest {
  projectPath: string;
}
```

**Constructor pattern:**

```typescript
constructor(dbPath: string) {
  this.db = new Database(dbPath);
  this.db.pragma('journal_mode = WAL');
  this.db.pragma('synchronous = NORMAL');
  this.db.pragma('busy_timeout = 5000');
  this.db.pragma('temp_store = MEMORY');
  this.db.pragma('foreign_keys = ON');

  this.runMigrations();

  // Prepare all statements
  this.stmts = {
    insert: this.db.prepare(`INSERT INTO agents (id, name, description, project_path, runtime, capabilities_json, manifest_json, registered_at, registered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getById: this.db.prepare(`SELECT * FROM agents WHERE id = ?`),
    getByPath: this.db.prepare(`SELECT * FROM agents WHERE project_path = ?`),
    listAll: this.db.prepare(`SELECT * FROM agents ORDER BY registered_at DESC`),
    update: this.db.prepare(`UPDATE agents SET name = ?, description = ?, runtime = ?, capabilities_json = ?, manifest_json = ? WHERE id = ?`),
    remove: this.db.prepare(`DELETE FROM agents WHERE id = ?`),
  };
}
```

**Public methods:**

- `insert(agent: AgentRegistryEntry): void` — insert a new agent, stores capabilities as JSON array, full manifest as JSON
- `get(id: string): AgentRegistryEntry | undefined` — look up by ULID
- `getByPath(projectPath: string): AgentRegistryEntry | undefined` — look up by canonical project path
- `list(filters?: { runtime?: AgentRuntime; capability?: string }): AgentRegistryEntry[]` — list all, filter in application layer (JSON parse capabilities_json, check includes)
- `update(id: string, partial: Partial<AgentRegistryEntry>): boolean` — update mutable fields
- `remove(id: string): boolean` — delete by id
- `close(): void` — close the database connection

**Row-to-entry conversion:** Parse `capabilities_json` and `manifest_json` from stringified JSON. Map `project_path` column to `projectPath` field.

---

### Task 3.2: Implement denial list

**Subject:** `[mesh-core-library] [P3] Implement denial list with SQLite persistence`
**Dependencies:** Task 3.1 (shares database)

Create `packages/mesh/src/denial-list.ts` sharing the same SQLite database as the registry.

**File: `packages/mesh/src/denial-list.ts` (NEW)**

**SQL DDL (part of Migration 1, same transaction as agents table):**

```sql
CREATE TABLE IF NOT EXISTS denials (
  path TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  reason TEXT,
  denied_by TEXT NOT NULL,
  denied_at TEXT NOT NULL
);
```

**Constructor:** Receives the Database instance from AgentRegistry (shared db). Runs the denials migration and prepares statements.

```typescript
constructor(db: Database.Database) {
  this.db = db;
  this.runMigrations();
  this.stmts = {
    insert: this.db.prepare(`INSERT OR REPLACE INTO denials (path, strategy, reason, denied_by, denied_at) VALUES (?, ?, ?, ?, ?)`),
    check: this.db.prepare(`SELECT 1 FROM denials WHERE path = ?`),
    listAll: this.db.prepare(`SELECT * FROM denials ORDER BY denied_at DESC`),
    remove: this.db.prepare(`DELETE FROM denials WHERE path = ?`),
  };
}
```

**Public methods:**

- `deny(path: string, strategy: string, reason: string | undefined, denier: string): void` — canonicalize path via `fs.realpathSync()`, insert/replace
- `isDenied(path: string): boolean` — canonicalize path, check existence
- `list(): DenialRecord[]` — return all denial records
- `clear(path: string): boolean` — canonicalize path, delete, return whether a row was removed

**Path canonicalization:** All paths are resolved via `fs.realpathSync()` before storage and lookup to prevent symlink-based bypasses. Wrap in try/catch — if realpath fails (path doesn't exist), use the raw path.

---

### Task 3.3: Implement manifest reader/writer

**Subject:** `[mesh-core-library] [P3] Implement manifest reader/writer`
**Dependencies:** Task 1.1 (needs AgentManifestSchema)

Create `packages/mesh/src/manifest.ts` for `.dork/agent.json` management.

**File: `packages/mesh/src/manifest.ts` (NEW)**

```typescript
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const MANIFEST_DIR = '.dork';
const MANIFEST_FILE = 'agent.json';

/**
 * Read and validate an agent manifest from a project directory.
 *
 * @param projectDir - Project directory containing .dork/agent.json
 * @returns Parsed manifest or null if file doesn't exist or validation fails
 */
export async function readManifest(projectDir: string): Promise<AgentManifest | null> {
  const manifestPath = path.join(projectDir, MANIFEST_DIR, MANIFEST_FILE);
  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    const result = AgentManifestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Write an agent manifest to a project directory atomically.
 *
 * Creates .dork/ directory if it doesn't exist. Writes to a temp file
 * first, then atomically renames to agent.json.
 *
 * @param projectDir - Project directory to write .dork/agent.json into
 * @param manifest - The agent manifest to write
 */
export async function writeManifest(projectDir: string, manifest: AgentManifest): Promise<void> {
  const dorkDir = path.join(projectDir, MANIFEST_DIR);
  await fs.mkdir(dorkDir, { recursive: true });

  const manifestPath = path.join(dorkDir, MANIFEST_FILE);
  const tempPath = path.join(dorkDir, `.agent-${randomUUID()}.tmp`);

  const content = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, manifestPath);
}
```

---

### Task 3.4: Write registry tests

**Subject:** `[mesh-core-library] [P3] Write agent registry tests`
**Dependencies:** Task 3.1

Create `packages/mesh/src/__tests__/agent-registry.test.ts`.

**Test cases:**

1. `insert()` and `get()` round-trip — insert an agent, retrieve by id, verify all fields
2. `getByPath()` returns the correct agent for a project path
3. `list()` returns all agents ordered by `registered_at` DESC
4. `list({ runtime: 'claude-code' })` filters by runtime
5. `list({ capability: 'code-review' })` filters by capability (JSON parse + includes)
6. `update()` modifies mutable fields and returns true
7. `update()` returns false for non-existent id
8. `remove()` deletes the agent and returns true
9. `remove()` returns false for non-existent id
10. Unique `project_path` constraint — inserting duplicate path throws
11. Persistence across close/reopen — insert, close db, reopen, verify agent exists
12. Close releases the database connection

**Setup:** Each test gets a fresh temp-file database via `fs.mkdtemp()` + `path.join(tmpDir, 'mesh.db')`. Clean up in `afterEach`.

---

### Task 3.5: Write denial list tests

**Subject:** `[mesh-core-library] [P3] Write denial list tests`
**Dependencies:** Task 3.2

Create `packages/mesh/src/__tests__/denial-list.test.ts`.

**Test cases:**

1. `deny()` and `isDenied()` round-trip — deny a path, verify it's denied
2. `isDenied()` returns false for non-denied path
3. `clear()` removes a denial and returns true
4. `clear()` returns false for non-denied path
5. `list()` returns all denial records
6. Path canonicalization — deny a symlinked path, check the real path is denied
7. Persistence across close/reopen — deny, close db, reopen, verify denied
8. `deny()` with reason preserves the reason string
9. Re-denying the same path updates the record (INSERT OR REPLACE)

**Setup:** Same as registry tests — temp database. For symlink tests, create a symlink in a temp directory.

---

### Task 3.6: Write manifest tests

**Subject:** `[mesh-core-library] [P3] Write manifest reader/writer tests`
**Dependencies:** Task 3.3

Create `packages/mesh/src/__tests__/manifest.test.ts`.

**Test cases:**

1. `readManifest()` / `writeManifest()` round-trip — write a manifest, read it back, verify equality
2. `readManifest()` returns null when `.dork/agent.json` doesn't exist
3. `readManifest()` returns null when JSON is invalid
4. `readManifest()` returns null when manifest fails Zod validation (missing required fields)
5. `writeManifest()` creates `.dork/` directory if it doesn't exist
6. `writeManifest()` uses atomic write (temp file + rename) — verify the file exists and is valid after write
7. `writeManifest()` produces human-readable JSON (2-space indent, trailing newline)

**Setup:** Use `fs.mkdtemp()` for temp directories. Clean up in `afterEach`.

---

## Phase 4: Integration (Relay Bridge + MeshCore)

### Task 4.1: Implement relay bridge

**Subject:** `[mesh-core-library] [P4] Implement relay bridge for optional RelayCore integration`
**Dependencies:** Task 1.1

Create `packages/mesh/src/relay-bridge.ts` for optional Relay integration.

**File: `packages/mesh/src/relay-bridge.ts` (NEW)**

```typescript
import path from 'path';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RelayCore } from '@dorkos/relay';

/**
 * Optional integration bridge between Mesh and Relay.
 *
 * When RelayCore is provided, automatically registers/unregisters
 * Relay endpoints for discovered agents. When not provided, all
 * operations are no-ops.
 */
export class RelayBridge {
  constructor(private relayCore?: RelayCore) {}

  /**
   * Register a Relay endpoint for an agent.
   *
   * @param agent - The agent manifest
   * @param projectPath - Absolute path to the agent's project directory
   * @returns The registered subject string, or null if RelayCore is not available
   */
  async registerAgent(agent: AgentManifest, projectPath: string): Promise<string | null> {
    if (!this.relayCore) return null;
    const project = path.basename(projectPath);
    const subject = `relay.agent.${project}.${agent.id}`;
    await this.relayCore.registerEndpoint(subject);
    return subject;
  }

  /**
   * Unregister a Relay endpoint for an agent.
   *
   * @param subject - The subject string returned from registerAgent
   */
  async unregisterAgent(subject: string): Promise<void> {
    if (!this.relayCore) return;
    await this.relayCore.unregisterEndpoint(subject);
  }
}
```

---

### Task 4.2: Write relay bridge tests

**Subject:** `[mesh-core-library] [P4] Write relay bridge tests`
**Dependencies:** Task 4.1

Create `packages/mesh/src/__tests__/relay-bridge.test.ts`.

**Test cases:**

1. `registerAgent()` with RelayCore calls `registerEndpoint` with correct subject
2. Subject format is `relay.agent.{basename(projectPath)}.{agentId}`
3. `registerAgent()` returns the registered subject string
4. `registerAgent()` without RelayCore returns null (no-op)
5. `unregisterAgent()` with RelayCore calls `unregisterEndpoint`
6. `unregisterAgent()` without RelayCore is a no-op (does not throw)

**Mock approach:** Mock `RelayCore` with `vi.fn()` for `registerEndpoint` and `unregisterEndpoint`.

---

### Task 4.3: Implement MeshCore class

**Subject:** `[mesh-core-library] [P4] Implement MeshCore class`
**Dependencies:** Task 2.4, Task 3.1, Task 3.2, Task 3.3, Task 4.1

Create `packages/mesh/src/mesh-core.ts` — the main entry point composing all modules.

**File: `packages/mesh/src/mesh-core.ts` (NEW)**

```typescript
import path from 'path';
import { monotonicFactory } from 'ulidx';
import type { AgentManifest, AgentRuntime, DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import type { RelayCore } from '@dorkos/relay';
import type { DiscoveryStrategy } from './discovery-strategy.js';
import { AgentRegistry } from './agent-registry.js';
import type { AgentRegistryEntry } from './agent-registry.js';
import { DenialList } from './denial-list.js';
import { RelayBridge } from './relay-bridge.js';
import { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
import { CursorStrategy } from './strategies/cursor-strategy.js';
import { CodexStrategy } from './strategies/codex-strategy.js';
import {
  scanDirectory,
  type DiscoveryOptions,
  type AutoImportedAgent,
} from './discovery-engine.js';
import { writeManifest } from './manifest.js';

export interface MeshOptions {
  /** Directory for mesh.db and other state. Default: ~/.dork/mesh */
  dataDir?: string;
  /** Optional RelayCore for endpoint registration. */
  relayCore?: RelayCore;
  /** Discovery strategies. Default: [ClaudeCode, Cursor, Codex]. */
  strategies?: DiscoveryStrategy[];
}
```

**Constructor:**

- Resolve `dataDir` (default `~/.dork/mesh`), create directory if needed
- Initialize `AgentRegistry` with `{dataDir}/mesh.db`
- Initialize `DenialList` sharing the registry's database
- Initialize `RelayBridge` with optional `relayCore`
- Set strategies (default: all three built-in)
- Create ULID generator via `monotonicFactory()`

**Methods:**

- `async *discover(roots: string[], options?: DiscoveryOptions): AsyncGenerator<DiscoveryCandidate>` — iterate roots, delegate to `scanDirectory()`, handle auto-imports by upserting to registry + registering relay endpoint, yield only new candidates
- `async register(candidate: DiscoveryCandidate, overrides?: Partial<AgentManifest>, approver?: string): Promise<AgentManifest>` — generate ULID, merge candidate hints + overrides + defaults into full manifest, write `.dork/agent.json`, insert to registry, register relay endpoint, return manifest
- `async registerByPath(projectPath: string, manifest: Partial<AgentManifest>, approver?: string): Promise<AgentManifest>` — manual registration without prior discovery
- `async deny(path: string, reason?: string, denier?: string): Promise<void>` — add to denial list
- `async undeny(path: string): Promise<void>` — remove from denial list
- `async unregister(agentId: string): Promise<void>` — get agent, remove from registry, unregister relay endpoint
- `list(filters?: { runtime?: AgentRuntime; capability?: string }): AgentManifest[]` — delegate to registry.list()
- `get(agentId: string): AgentManifest | undefined` — delegate to registry.get()
- `getByPath(projectPath: string): AgentManifest | undefined` — delegate to registry.getByPath()
- `close(): void` — close registry (which closes the shared db)

---

### Task 4.4: Write MeshCore integration tests

**Subject:** `[mesh-core-library] [P4] Write MeshCore integration tests`
**Dependencies:** Task 4.3

Create `packages/mesh/src/__tests__/mesh-core.test.ts`.

**Test fixture structure (created in temp dir per test):**

```
tmpDir/
├── data/                 (dataDir for MeshCore)
├── projects/
│   ├── project-a/.claude/CLAUDE.md
│   ├── project-b/.cursor/
│   └── pre-registered/.dork/agent.json  (valid manifest)
```

**Test cases:**

1. Full lifecycle: `discover()` -> `register()` -> `list()` -> `unregister()`
   - Discover finds project-a and project-b as candidates
   - Register project-a, verify manifest written to `.dork/agent.json`
   - `list()` returns the registered agent
   - `unregister()` removes it, `list()` returns empty

2. Auto-import: `discover()` auto-imports `pre-registered/` without yielding as candidate
   - After discover, `list()` includes the pre-registered agent
   - pre-registered should NOT appear in the yielded candidates

3. Denial filtering: `deny()` a path, `discover()` does not yield it
   - Deny project-a's path
   - Discover only yields project-b

4. Manual registration: `registerByPath()` works without prior discovery
   - Register a path directly, verify it appears in `list()`

5. Persistence: agents survive MeshCore restart
   - Register an agent, close MeshCore
   - Create new MeshCore with same dataDir
   - `list()` returns the agent

6. RelayCore integration (mocked):
   - Create MeshCore with mocked RelayCore
   - Register an agent, verify `registerEndpoint` was called
   - Unregister, verify `unregisterEndpoint` was called

7. `get()` and `getByPath()` return correct agents

---

### Task 4.5: Finalize barrel exports and verify

**Subject:** `[mesh-core-library] [P4] Finalize barrel exports and run full verification`
**Dependencies:** Task 4.4

Update `packages/mesh/src/index.ts` with all public exports.

**File: `packages/mesh/src/index.ts` (REPLACE)**

```typescript
/**
 * @dorkos/mesh -- Agent discovery, registration, and registry for DorkOS.
 *
 * Provides pluggable discovery strategies, SQLite-backed persistence,
 * manifest management, and optional Relay integration.
 *
 * @module mesh
 */

// Main entry point
export { MeshCore } from './mesh-core.js';
export type { MeshOptions } from './mesh-core.js';

// Discovery
export type { DiscoveryStrategy } from './discovery-strategy.js';
export { scanDirectory, EXCLUDED_DIRS } from './discovery-engine.js';
export type { DiscoveryOptions, AutoImportedAgent } from './discovery-engine.js';

// Strategies
export { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
export { CursorStrategy } from './strategies/cursor-strategy.js';
export { CodexStrategy } from './strategies/codex-strategy.js';

// Persistence
export { AgentRegistry } from './agent-registry.js';
export type { AgentRegistryEntry } from './agent-registry.js';
export { DenialList } from './denial-list.js';

// Manifest
export { readManifest, writeManifest } from './manifest.js';

// Relay Bridge
export { RelayBridge } from './relay-bridge.js';
```

**Verification checklist (from spec section 16):**

- [ ] `npm test` passes for `packages/mesh`
- [ ] `npm run typecheck` passes
- [ ] MeshCore can be instantiated and discover agents in a test fixture directory
- [ ] ClaudeCodeStrategy detects `.claude/` directories with `CLAUDE.md`
- [ ] CursorStrategy detects `.cursor/` directories
- [ ] Discovery skips directories with existing `.dork/agent.json` (already registered)
- [ ] Discovery skips denied agents
- [ ] Registration writes `.dork/agent.json` with correct schema
- [ ] Registration creates Relay endpoint for the agent
- [ ] Denial persists in SQLite and filters from future scans
- [ ] Manual registration by path works without discovery
- [ ] Importing hand-authored `.dork/agent.json` works (auto-import on scan)
- [ ] Agent registry persists across MeshCore restarts

---

## Dependency Graph

```
Phase 1 (Foundation):
  T1.1 ─┐
         ├─ T1.3
  T1.2 ─┘

Phase 2 (Discovery):
  T1.1 ─── T2.1 ─── T2.2 ─── T2.3
                  │
  T1.1 ───────── T2.4 ─── T2.5

Phase 3 (Persistence):
  T1.1, T1.2 ─── T3.1 ─── T3.4
  T3.1 ───────── T3.2 ─── T3.5
  T1.1 ───────── T3.3 ─── T3.6

Phase 4 (Integration):
  T1.1 ───────── T4.1 ─── T4.2
  T2.4, T3.1, T3.2, T3.3, T4.1 ─── T4.3 ─── T4.4
  T4.4 ─── T4.5
```

## Parallel Execution Opportunities

- **T1.1 and T1.2** can run in parallel (no dependencies on each other)
- **T2.1-T2.3** (strategies) and **T3.1-T3.3** (persistence) can run in parallel after Phase 1
- **T3.4, T3.5, T3.6** (persistence tests) can run in parallel with each other
- **T4.1-T4.2** (relay bridge) can run in parallel with T3.x tests

## Estimated Effort

| Phase                | Tasks  | Estimated Lines | Complexity |
| -------------------- | ------ | --------------- | ---------- |
| Phase 1: Foundation  | 3      | ~200            | Low        |
| Phase 2: Discovery   | 5      | ~500            | Medium     |
| Phase 3: Persistence | 6      | ~600            | Medium     |
| Phase 4: Integration | 5      | ~700            | High       |
| **Total**            | **19** | **~2000**       | --         |
