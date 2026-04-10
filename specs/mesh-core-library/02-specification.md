---
slug: mesh-core-library
number: 54
created: 2026-02-24
status: draft
---

# Specification: Mesh Core Library (`@dorkos/mesh`)

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-24
**Ideation:** [01-ideation.md](./01-ideation.md)
**Litepaper:** [Mesh Litepaper](../../meta/modules/mesh-litepaper.md)
**Spec Source:** [Mesh Spec 1](../../plans/mesh-specs/01-mesh-core-library.md)

---

## 1. Overview

Build `@dorkos/mesh` — a pure TypeScript library package at `packages/mesh/` that implements agent discovery, registration, and registry for DorkOS. This is the foundation for the Mesh module: everything in Mesh Specs 2-4 (HTTP routes, client UI, topology, observability) builds on this library.

The library provides:

- **Pluggable discovery strategies** that scan the filesystem for agent projects (`.claude/`, `.cursor/`, `.codex/`)
- **A two-phase lifecycle** — discovery finds candidates, registration commits them to the mesh
- **SQLite-backed persistence** for the agent registry and deny list
- **`.dork/agent.json` manifest management** — read, write, validate
- **Optional RelayCore integration** — register Relay endpoints when agents are registered

## 2. Background / Problem Statement

DorkOS agents run in isolated project directories with no awareness of each other. There is no registry, no discovery mechanism, and no way for agents to find peers by capability. The Mesh module solves this by providing a discovery and registration layer that sits above Relay (the message bus).

Relay Specs 1-2 are complete — `@dorkos/relay` provides endpoint registration and access control. Mesh builds on this by automating endpoint creation when agents are registered and by providing the directory of agents that higher-level features (capability queries, topology visualization) depend on.

## 3. Goals

- Create a new `packages/mesh/` workspace package following existing `packages/relay/` conventions
- Implement pluggable discovery strategies with 3 built-in strategies (Claude Code, Cursor, Codex)
- Implement a discovery engine with depth-limited async BFS and symlink cycle detection
- Implement an agent registry with SQLite persistence (better-sqlite3, WAL mode)
- Implement a deny list with SQLite persistence in the same database
- Implement manifest reader/writer for `.dork/agent.json`
- Implement optional RelayCore integration for endpoint registration
- Implement `MeshCore` class composing all modules into a single entry point
- Add Zod schemas to `@dorkos/shared/mesh-schemas`
- Comprehensive test coverage with vitest

## 4. Non-Goals

- HTTP routes or Express middleware (Mesh Spec 2)
- MCP tools for agent-driven discovery (Mesh Spec 2)
- Client UI — discovery panel, agent list (Mesh Spec 2)
- Network topology, namespace isolation, cross-project ACL (Mesh Spec 3)
- Observability, visualization, lifecycle events (Mesh Spec 4)
- Filesystem watching for live/continuous discovery (future)
- FTS5 full-text search on agent descriptions (add later if needed)
- A2A Agent Card HTTP interop (future — add `toAgentCard()` conversion later)

## 5. Technical Dependencies

| Dependency                  | Version   | Purpose                                                |
| --------------------------- | --------- | ------------------------------------------------------ |
| `better-sqlite3`            | `^11.0.0` | SQLite persistence (WAL mode) for registry + deny list |
| `@types/better-sqlite3`     | `^7.6.0`  | TypeScript types (devDep)                              |
| `ulidx`                     | `^2.4.0`  | Monotonic ULID generation for agent IDs                |
| `@dorkos/shared`            | `*`       | Zod schemas (mesh-schemas.ts)                          |
| `@dorkos/relay`             | `*`       | Optional peer dependency for endpoint registration     |
| `@dorkos/typescript-config` | `*`       | Shared tsconfig preset (devDep)                        |

## 6. Detailed Design

### 6.1 Package Structure

```
packages/mesh/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts                    # Barrel exports
    ├── mesh-core.ts                # MeshCore class (main entry point)
    ├── discovery-strategy.ts       # DiscoveryStrategy interface
    ├── strategies/
    │   ├── claude-code-strategy.ts  # Detects .claude/ with AGENTS.md
    │   ├── cursor-strategy.ts       # Detects .cursor/
    │   └── codex-strategy.ts        # Detects .codex/
    ├── discovery-engine.ts          # Async BFS scanner
    ├── agent-registry.ts            # SQLite agent registry
    ├── denial-list.ts               # SQLite denial list
    ├── manifest.ts                  # .dork/agent.json reader/writer
    ├── relay-bridge.ts              # Optional RelayCore integration
    └── __tests__/
        ├── strategies.test.ts
        ├── discovery-engine.test.ts
        ├── agent-registry.test.ts
        ├── denial-list.test.ts
        ├── manifest.test.ts
        ├── relay-bridge.test.ts
        ├── mesh-core.test.ts
        └── fixtures/               # Test directory structures
            ├── claude-project/
            │   └── .claude/
            │       └── AGENTS.md
            ├── cursor-project/
            │   └── .cursor/
            ├── codex-project/
            │   └── .codex/
            ├── registered-project/
            │   └── .dork/
            │       └── agent.json
            └── empty-project/
```

### 6.2 Zod Schemas (`packages/shared/src/mesh-schemas.ts`)

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

Add `./mesh-schemas` subpath export to `packages/shared/package.json`:

```json
"./mesh-schemas": {
  "types": "./src/mesh-schemas.ts",
  "default": "./dist/mesh-schemas.js"
}
```

### 6.3 Discovery Strategy Interface

```typescript
/**
 * A pluggable strategy for detecting agent projects by filesystem markers.
 *
 * Each strategy knows how to recognize a specific type of agent project
 * (e.g., Claude Code projects have .claude/ with AGENTS.md).
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

**Built-in strategies:**

| Strategy             | Detection Logic                                      | Runtime       | Name Derivation      |
| -------------------- | ---------------------------------------------------- | ------------- | -------------------- |
| `ClaudeCodeStrategy` | `.claude/` directory exists AND contains `AGENTS.md` | `claude-code` | `path.basename(dir)` |
| `CursorStrategy`     | `.cursor/` directory exists                          | `cursor`      | `path.basename(dir)` |
| `CodexStrategy`      | `.codex/` directory exists                           | `codex`       | `path.basename(dir)` |

Each strategy file is ~30-40 lines. Detection uses `fs.promises.access()` to check existence.

### 6.4 Discovery Engine

The discovery engine performs depth-limited async BFS across configured root directories.

**Interface:**

```typescript
export interface DiscoveryOptions {
  maxDepth?: number; // Default: 5
  excludedDirs?: Set<string>; // Default: EXCLUDED_DIRS
  followSymlinks?: boolean; // Default: false
}

const EXCLUDED_DIRS = new Set([
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
```

**Core algorithm:**

```typescript
async function* scanDirectory(
  rootDir: string,
  strategies: DiscoveryStrategy[],
  registry: AgentRegistry,
  denialList: DenialList,
  options: DiscoveryOptions
): AsyncGenerator<DiscoveryCandidate | AutoImportedAgent> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const visited = new Set<string>(); // realpath-based cycle detection

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > (options.maxDepth ?? 5)) continue;

    // Check for existing .dork/agent.json -> auto-import
    // Check if denied -> skip
    // Check if already registered -> skip
    // Run strategies -> yield candidates
    // Enqueue subdirectories (skip excluded, handle symlinks)
  }
}
```

**Key behaviors:**

1. **Auto-import:** If `.dork/agent.json` exists, read manifest and yield an `AutoImportedAgent` event. The caller (MeshCore) upserts this to the registry without approval.
2. **Denial filter:** Check `denialList.isDenied(realpath)` before running strategies.
3. **Registration filter:** Check `registry.getByPath(dir)` to skip already-registered paths.
4. **Symlink safety:** When `followSymlinks` is false (default), skip symlinked directories. When true, resolve realpath and check `visited` set for cycles.
5. **Error handling:** Catch `EACCES`/`EPERM` on `readdir` and skip silently. Log a warning for other errors and continue.

### 6.5 Agent Registry

SQLite persistence using better-sqlite3, following the exact pattern from `packages/relay/src/sqlite-index.ts`.

**Database:** `{dataDir}/mesh.db` (shared with denial list)

**Schema:**

```sql
-- Migration 1: Initial schema
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

  this.stmts = {
    insert: this.db.prepare(`INSERT INTO agents (...) VALUES (...)`),
    getById: this.db.prepare(`SELECT * FROM agents WHERE id = ?`),
    getByPath: this.db.prepare(`SELECT * FROM agents WHERE project_path = ?`),
    listAll: this.db.prepare(`SELECT * FROM agents ORDER BY registered_at DESC`),
    update: this.db.prepare(`UPDATE agents SET ... WHERE id = ?`),
    remove: this.db.prepare(`DELETE FROM agents WHERE id = ?`),
  };
}
```

**Public methods:**

```typescript
insert(agent: AgentRegistryEntry): void
get(id: string): AgentRegistryEntry | undefined
getByPath(projectPath: string): AgentRegistryEntry | undefined
list(filters?: { runtime?: AgentRuntime; capability?: string }): AgentRegistryEntry[]
update(id: string, partial: Partial<AgentRegistryEntry>): boolean
remove(id: string): boolean
close(): void
```

**AgentRegistryEntry** extends `AgentManifest` with `projectPath: string`.

**Capability filtering:** Application-layer JSON parse of `capabilities_json`, then `Array.includes()`. Sufficient for 5-50 agents.

### 6.6 Denial List

Shares the same SQLite database (`mesh.db`) as the agent registry.

**Schema:**

```sql
-- Part of Migration 1 (same transaction as agents table)
CREATE TABLE IF NOT EXISTS denials (
  path TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  reason TEXT,
  denied_by TEXT NOT NULL,
  denied_at TEXT NOT NULL
);
```

**Public methods:**

```typescript
deny(path: string, strategy: string, reason: string | undefined, denier: string): void
isDenied(path: string): boolean
list(): DenialRecord[]
clear(path: string): boolean
close(): void  // shared with registry -- only one close() on the db
```

**Path canonicalization:** All paths are resolved via `fs.realpathSync()` before storage and lookup to prevent symlink-based bypasses.

### 6.7 Manifest Reader/Writer

**`readManifest(projectDir: string): Promise<AgentManifest | null>`**

- Read `{projectDir}/.dork/agent.json`
- Parse JSON, validate with `AgentManifestSchema.safeParse()`
- Return parsed manifest or `null` if file doesn't exist or validation fails

**`writeManifest(projectDir: string, manifest: AgentManifest): Promise<void>`**

- Create `.dork/` directory if it doesn't exist (`mkdir -p` equivalent)
- Write to a temp file in `.dork/` first
- Atomic rename from temp file to `agent.json`
- Uses `JSON.stringify(manifest, null, 2)` for human-readable output

### 6.8 Relay Bridge

Optional integration with `@dorkos/relay` for endpoint registration.

```typescript
export class RelayBridge {
  constructor(private relayCore?: RelayCore) {}

  async registerAgent(agent: AgentManifest, projectPath: string): Promise<string | null> {
    if (!this.relayCore) return null;
    const project = path.basename(projectPath);
    const subject = `relay.agent.${project}.${agent.id}`;
    await this.relayCore.registerEndpoint(subject);
    return subject;
  }

  async unregisterAgent(subject: string): Promise<void> {
    if (!this.relayCore) return;
    await this.relayCore.unregisterEndpoint(subject);
  }
}
```

**Subject derivation:** `relay.agent.{basename(projectPath)}.{agentId}`

When RelayCore is not provided, all methods are no-ops. MeshCore works standalone for discovery and registration — it just doesn't create Relay endpoints.

### 6.9 MeshCore Class

The main entry point that composes all modules.

```typescript
export interface MeshOptions {
  /** Directory for mesh.db and other state. Default: ~/.dork/mesh */
  dataDir?: string;
  /** Optional RelayCore for endpoint registration. */
  relayCore?: RelayCore;
  /** Discovery strategies. Default: [ClaudeCode, Cursor, Codex]. */
  strategies?: DiscoveryStrategy[];
}

export class MeshCore {
  private registry: AgentRegistry;
  private denialList: DenialList;
  private relayBridge: RelayBridge;
  private strategies: DiscoveryStrategy[];
  private generateId: () => string; // monotonicFactory from ulidx

  constructor(options?: MeshOptions);

  /** Scan directories for agent candidates. Yields candidates as found. */
  async *discover(roots: string[], options?: DiscoveryOptions): AsyncGenerator<DiscoveryCandidate>;

  /** Register a discovered candidate as an agent. */
  async register(
    candidate: DiscoveryCandidate,
    overrides?: Partial<AgentManifest>,
    approver?: string
  ): Promise<AgentManifest>;

  /** Register an agent by path (manual registration, bypasses discovery). */
  async registerByPath(
    projectPath: string,
    manifest: Partial<AgentManifest>,
    approver?: string
  ): Promise<AgentManifest>;

  /** Deny a candidate -- persists in SQLite, filtered from future scans. */
  async deny(path: string, reason?: string, denier?: string): Promise<void>;

  /** Remove a denial, allowing the path to resurface as a candidate. */
  async undeny(path: string): Promise<void>;

  /** Unregister an agent -- removes from registry, deletes Relay endpoint. */
  async unregister(agentId: string): Promise<void>;

  /** List all registered agents with optional filtering. */
  list(filters?: { runtime?: AgentRuntime; capability?: string }): AgentManifest[];

  /** Get a single agent by ID. */
  get(agentId: string): AgentManifest | undefined;

  /** Get a single agent by project path. */
  getByPath(projectPath: string): AgentManifest | undefined;

  /** Graceful shutdown -- close SQLite connections. */
  close(): void;
}
```

**Registration flow:**

1. Generate ULID via `monotonicFactory()`
2. Build full `AgentManifest` from candidate hints + overrides + defaults
3. Write `.dork/agent.json` to the project directory
4. Insert into SQLite registry
5. Register Relay endpoint (if RelayCore available)
6. Return the complete manifest

**Auto-import during discovery:**
When `discover()` encounters a directory with an existing `.dork/agent.json`:

1. Read and validate the manifest
2. Upsert to registry (update if exists, insert if new)
3. Do NOT yield as a candidate (it's already registered)
4. Register Relay endpoint if not already registered

### 6.10 Package Configuration Files

**`packages/mesh/package.json`:**

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

**`packages/mesh/tsconfig.json`:**

```json
{
  "extends": "@dorkos/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

**`packages/mesh/vitest.config.ts`:**

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

### 6.11 Workspace Integration

**`vitest.workspace.ts`** -- add `'packages/mesh'` to the array.

**Root `package.json`** -- no change needed (glob `packages/*` already covers new packages).

**`turbo.json`** -- no change needed for Spec 1 (future: add `DORKOS_MESH_ENABLED` in Spec 2).

## 7. User Experience

This spec produces a library with no direct user interface. The UX surfaces in Mesh Spec 2 (HTTP routes, MCP tools, client UI).

Developers interact with `MeshCore` programmatically:

```typescript
import { MeshCore } from '@dorkos/mesh';

const mesh = new MeshCore({ dataDir: '/path/to/data' });

// Discover agents
for await (const candidate of mesh.discover(['/Users/me/projects'])) {
  console.log(`Found: ${candidate.hints.suggestedName} at ${candidate.path}`);
}

// Register an agent
const manifest = await mesh.register(candidate, {}, 'human:cli');

// List registered agents
const agents = mesh.list({ runtime: 'claude-code' });
```

## 8. Testing Strategy

### Unit Tests

| Test File                  | What It Tests                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `strategies.test.ts`       | All 3 built-in strategies: detection logic, hint extraction, edge cases (missing files, empty dirs)             |
| `discovery-engine.test.ts` | BFS traversal, depth limits, excluded dirs, symlink handling, auto-import, denial/registration filtering        |
| `agent-registry.test.ts`   | CRUD operations, persistence across close/reopen, filtering by runtime/capability, unique path constraint       |
| `denial-list.test.ts`      | Deny/isDenied/clear lifecycle, path canonicalization, persistence                                               |
| `manifest.test.ts`         | Read/write round-trip, Zod validation, atomic write, missing directory creation                                 |
| `relay-bridge.test.ts`     | Endpoint registration with mocked RelayCore, no-op behavior without RelayCore                                   |
| `mesh-core.test.ts`        | Full lifecycle: discover -> register -> list -> unregister. Manual registration. Auto-import. Denial filtering. |

### Test Infrastructure

- **Temp directories:** Each test creates a temporary directory with fixture structures using `fs.mkdtemp()`. Cleaned up in `afterEach`.
- **SQLite:** Each test gets a fresh in-memory or temp-file database.
- **RelayCore mocking:** Mock `registerEndpoint()` and `unregisterEndpoint()` with `vi.fn()`.
- **Strategy edge cases:**
  - `.claude/` without `AGENTS.md` -> ClaudeCodeStrategy returns false
  - Empty directory -> no strategy matches
  - Multiple strategies match same directory -> first match wins
  - Nested `.claude/` inside `node_modules/` -> excluded by BFS filter
  - Symlink cycle -> detected and skipped (no infinite loop)
  - Permission denied on directory -> silently skipped

### Key Test Scenarios

```typescript
// Purpose: Verifies the complete discover-register-list lifecycle works end-to-end
it('completes the full discover-register-list lifecycle', async () => {
  const mesh = new MeshCore({ dataDir: tmpDir });
  const candidates: DiscoveryCandidate[] = [];
  for await (const c of mesh.discover([fixtureDir])) {
    candidates.push(c);
  }
  expect(candidates.length).toBeGreaterThan(0);

  const manifest = await mesh.register(candidates[0], {}, 'human:cli');
  expect(manifest.id).toBeDefined();

  const agents = mesh.list();
  expect(agents).toHaveLength(1);
  expect(agents[0].name).toBe(candidates[0].hints.suggestedName);
});

// Purpose: Ensures existing manifests are auto-imported without requiring approval
it('auto-imports existing .dork/agent.json without requiring approval', async () => {
  // Create a .dork/agent.json in fixture
  // Run discover() -- should NOT yield as candidate
  // But agent should appear in list()
});

// Purpose: Verifies denied paths are persistently filtered from scans
it('denied paths do not appear in subsequent scans', async () => {
  const mesh = new MeshCore({ dataDir: tmpDir });
  await mesh.deny('/path/to/project', 'not wanted', 'human:cli');

  const candidates: DiscoveryCandidate[] = [];
  for await (const c of mesh.discover(['/path/to'])) {
    candidates.push(c);
  }
  // /path/to/project should not be in candidates
});

// Purpose: Confirms SQLite persistence survives process restart
it('persists agents across MeshCore restarts', async () => {
  const mesh1 = new MeshCore({ dataDir: tmpDir });
  await mesh1.registerByPath('/tmp/project', { name: 'test' }, 'human:cli');
  mesh1.close();

  const mesh2 = new MeshCore({ dataDir: tmpDir });
  const agents = mesh2.list();
  expect(agents).toHaveLength(1);
  mesh2.close();
});
```

## 9. Performance Considerations

- **Discovery scan:** Depth-5 BFS of a developer home directory (~5,000-50,000 dirs) takes 1-10 seconds. This is on-demand, not continuous -- acceptable latency for a user-triggered scan.
- **Excluded directory early-exit:** `Set<string>` lookup before `readdir()` avoids entering large trees like `node_modules/`.
- **SQLite prepared statements:** All queries are pre-compiled in the constructor (following relay's pattern). No query compilation at call time.
- **WAL mode:** Allows concurrent reads during writes. No blocking for read-heavy operations like `list()`.
- **JSON column filtering:** Application-layer capability filtering (parse JSON array, check includes) is O(n) where n = agent count. At 5-50 agents, this is sub-millisecond.

## 10. Security Considerations

- **Path traversal:** The discovery engine validates that all scanned paths are real filesystem paths. `fs.realpathSync()` resolves symlinks before storage.
- **Manifest validation:** All manifest content is parsed through Zod `safeParse()`. Invalid manifests are logged and skipped, never trusted.
- **No code execution:** The discovery engine only reads filesystem metadata (directory existence, file content). It never `require()`, `import()`, or executes any discovered file.
- **Denial list integrity:** Deny list entries are stored and matched on canonical (realpath-resolved) paths to prevent symlink-based bypasses.
- **Directory boundary:** The discovery engine respects root directories provided by the caller. In Spec 2, the HTTP layer will enforce the server's directory boundary.

## 11. Documentation

- No external user-facing documentation needed for Spec 1 (pure library)
- TSDoc on all exported functions, classes, and interfaces
- Module-level TSDoc on `index.ts` barrel

## 12. Implementation Phases

### Phase 1: Foundation (Schemas + Package Setup)

**Files created:**

- `packages/mesh/package.json`
- `packages/mesh/tsconfig.json`
- `packages/mesh/vitest.config.ts`
- `packages/mesh/src/index.ts`
- `packages/shared/src/mesh-schemas.ts`

**Files modified:**

- `packages/shared/package.json` (add `./mesh-schemas` export)
- `vitest.workspace.ts` (add `'packages/mesh'`)

**Verification:** `npm run typecheck` passes, `npm install` resolves workspace.

### Phase 2: Discovery (Strategies + Engine)

**Files created:**

- `packages/mesh/src/discovery-strategy.ts`
- `packages/mesh/src/strategies/claude-code-strategy.ts`
- `packages/mesh/src/strategies/cursor-strategy.ts`
- `packages/mesh/src/strategies/codex-strategy.ts`
- `packages/mesh/src/discovery-engine.ts`
- `packages/mesh/src/__tests__/strategies.test.ts`
- `packages/mesh/src/__tests__/discovery-engine.test.ts`
- Test fixture directories

**Verification:** Strategy tests pass, discovery engine finds agents in test fixtures.

### Phase 3: Persistence (Registry + Denial List + Manifest)

**Files created:**

- `packages/mesh/src/agent-registry.ts`
- `packages/mesh/src/denial-list.ts`
- `packages/mesh/src/manifest.ts`
- `packages/mesh/src/__tests__/agent-registry.test.ts`
- `packages/mesh/src/__tests__/denial-list.test.ts`
- `packages/mesh/src/__tests__/manifest.test.ts`

**Verification:** Registry CRUD works, denial persists, manifest round-trips.

### Phase 4: Integration (Relay Bridge + MeshCore)

**Files created:**

- `packages/mesh/src/relay-bridge.ts`
- `packages/mesh/src/mesh-core.ts`
- `packages/mesh/src/__tests__/relay-bridge.test.ts`
- `packages/mesh/src/__tests__/mesh-core.test.ts`

**Verification:** Full lifecycle tests pass, all verification criteria from the mesh spec are met.

## 13. Open Questions

No open questions -- all design decisions were resolved during ideation.

## 14. Related ADRs

| ADR                                       | Relevance                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `0012-use-ulid-for-relay-message-ids.md`  | Same ULID pattern (ulidx + monotonicFactory) used for agent IDs                 |
| `0013-hybrid-maildir-sqlite-storage.md`   | SQLite pattern reference (WAL mode, migrations, prepared statements)            |
| `0011-use-nats-style-subject-matching.md` | Subject hierarchy (`relay.agent.{project}.{id}`) used for endpoint registration |
| `0004-monorepo-with-turborepo.md`         | Package structure conventions                                                   |

## 15. References

- [Mesh Litepaper](../../meta/modules/mesh-litepaper.md) -- vision, lifecycle, strategies
- [Relay Litepaper](../../meta/modules/relay-litepaper.md) -- messaging layer Mesh builds on
- [Mesh Spec Sequence](../../plans/mesh-specs/00-overview.md) -- full 4-spec build plan
- [Relay Core Library Spec](../../plans/relay-specs/01-relay-core-library.md) -- reference pattern
- [A2A Agent Card Specification](https://a2a-protocol.org/latest/specification/) -- future alignment target
- [ulidx on npm](https://www.npmjs.com/package/ulidx) -- ULID generation library
- [better-sqlite3 docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) -- SQLite API

## 16. Verification Criteria

From the [Mesh Spec 1](../../plans/mesh-specs/01-mesh-core-library.md) verification checklist:

- [ ] `npm test` passes for `packages/mesh`
- [ ] `npm run typecheck` passes
- [ ] MeshCore can be instantiated and discover agents in a test fixture directory
- [ ] ClaudeCodeStrategy detects `.claude/` directories with `AGENTS.md`
- [ ] CursorStrategy detects `.cursor/` directories
- [ ] Discovery skips directories with existing `.dork/agent.json` (already registered)
- [ ] Discovery skips denied agents
- [ ] Registration writes `.dork/agent.json` with correct schema
- [ ] Registration creates Relay endpoint for the agent
- [ ] Denial persists in SQLite and filters from future scans
- [ ] Manual registration by path works without discovery
- [ ] Importing hand-authored `.dork/agent.json` works (auto-import on scan)
- [ ] Agent registry persists across MeshCore restarts
