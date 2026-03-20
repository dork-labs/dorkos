---
title: '@dorkos/mesh Core Library Research'
date: 2026-02-24
type: internal-architecture
status: archived
tags: [mesh, discovery, bfs, agent-manifest, sqlite, registry]
feature_slug: mesh-core-library
---

# Research: @dorkos/mesh Core Library

**Date**: 2026-02-24
**Feature**: mesh-core-library
**Depth**: Deep Research
**Searches performed**: 14
**Sources**: 25+ authoritative references

---

## Research Summary

The @dorkos/mesh core library sits at the intersection of five well-studied domains: agent manifest standards (A2A), filesystem traversal algorithms, SQLite registry patterns, pluggable strategy architectures, and ULID-based identifiers. The A2A Agent Card spec is now a mature Linux Foundation standard with well-defined JSON fields that align closely with what .dork/agent.json needs. The existing @dorkos/relay package provides a near-perfect SQLite migration template (WAL mode, PRAGMA user_version, better-sqlite3) to reuse verbatim. ULID via ulidx with monotonicFactory is the correct identifier choice. The primary design decision is around discovery engine architecture: glob-based vs walk-based vs custom BFS, each with clear tradeoffs.

---

## Key Findings

### 1. A2A Agent Card Standard (Linux Foundation)

The Agent2Agent (A2A) Protocol was launched by Google in April 2025 and moved to Linux Foundation governance on June 23, 2025. It now has 100+ corporate backers. The AgentCard is the agent's self-describing manifest, conventionally served at `https://<host>/.well-known/agent-card.json`.

**Complete AgentCard field inventory:**

| Field                | Required | Type     | Description                                                             |
| -------------------- | -------- | -------- | ----------------------------------------------------------------------- |
| `name`               | Yes      | string   | Human-readable agent name                                               |
| `description`        | Yes      | string   | Agent functionality overview                                            |
| `url`                | Yes      | string   | Service URL where agent is hosted                                       |
| `version`            | Yes      | string   | Agent version (provider-defined format)                                 |
| `defaultInputModes`  | Yes      | string[] | Supported input MIME types                                              |
| `defaultOutputModes` | Yes      | string[] | Supported output MIME types                                             |
| `authentication`     | Yes      | object   | Auth schemes and credential requirements                                |
| `skills`             | Yes      | object[] | Collection of capability units                                          |
| `provider`           | No       | object   | Organization name and URL                                               |
| `documentationUrl`   | No       | string   | Link to agent documentation                                             |
| `capabilities`       | No       | object   | streaming, pushNotifications, stateTransitionHistory, extendedAgentCard |

**AgentSkill object:**

- `id` (string, required) — unique identifier
- `name` (string, required) — human-readable name
- `description` (string, required) — what the skill does
- `tags` (string[], required) — capability categories, primary searchability vector
- `examples` (string[], optional) — usage examples
- `inputModes` (string[], optional) — skill-specific input MIME overrides
- `outputModes` (string[], optional) — skill-specific output MIME overrides

**AgentCapabilities object:**

- `streaming` (boolean) — SSE streaming support
- `pushNotifications` (boolean) — webhook push support
- `stateTransitionHistory` (boolean) — state tracking support
- `extendedAgentCard` (boolean) — extended card support

**Key observation**: A2A's `url` field assumes HTTP service discovery. Filesystem-local agents running as Claude Code sessions have no HTTP URL. The .dork/agent.json manifest must extend A2A to handle offline/local agents — keeping A2A-compatible fields but adding local-specific extensions.

### 2. ULID vs UUID v7

Both are 128-bit, time-ordered, lexicographically sortable identifiers. Key comparison:

| Property                | ULID                                              | UUID v7                                |
| ----------------------- | ------------------------------------------------- | -------------------------------------- |
| Encoding                | Base32, 26 chars                                  | Hex with dashes, 36 chars              |
| Random bits             | 80 bits                                           | ~74 bits                               |
| URL-safe                | Yes                                               | No (has dashes)                        |
| DB index friendliness   | High (sequential)                                 | High (sequential)                      |
| Ecosystem compatibility | ULID-specific                                     | UUID-standard (PostgreSQL native type) |
| Monotonicity            | Via monotonicFactory (explicit)                   | Via counter bits (impl-specific)       |
| Performance             | Faster (83.7% less network overhead in one study) | Slightly slower                        |
| JS library              | ulidx (TypeScript-native, ESM+CJS)                | `uuid` package                         |

**ulidx monotonicFactory behavior**: When multiple ULIDs are generated within the same millisecond, the factory increments the least-significant random bit, guaranteeing strict lexicographic ordering. If a lower timestamp is passed, the factory still produces a ULID that sorts after the previous one. This is explicit opt-in — the default `ulid()` function does NOT guarantee monotonicity.

**Recommendation**: ULID via ulidx with monotonicFactory, consistent with @dorkos/relay which already uses ULIDs for message IDs. Agent IDs will be less performance-critical than message IDs, but ULID's compactness and readability favor it for identifiers that appear in logs, manifests, and CLI output.

### 3. SQLite Registry Design

The @dorkos/relay package's `sqlite-index.ts` is the canonical internal pattern to follow. Key observations from the existing implementation:

**PRAGMA settings on connection (required):**

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;
```

**Migration pattern (PRAGMA user_version):**

```typescript
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS agents (...);
   CREATE INDEX IF NOT EXISTS ...;`,
  // Version 2 migration added later
  `ALTER TABLE agents ADD COLUMN ...;`,
];

private runMigrations(): void {
  const currentVersion = this.db.pragma('user_version', { simple: true }) as number ?? 0;
  if (currentVersion >= MIGRATIONS.length) return;
  const migrate = this.db.transaction(() => {
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
    }
    this.db.pragma(`user_version = ${MIGRATIONS.length}`);
  });
  migrate();
}
```

**Proposed agents table schema:**

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  project_path TEXT NOT NULL UNIQUE,
  manifest_path TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  version TEXT,
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  manifest_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_skills (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_tags (
  skill_row_id TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (skill_row_id, tag)
);

CREATE TABLE IF NOT EXISTS deny_list (
  project_path TEXT PRIMARY KEY,
  denied_at TEXT NOT NULL,
  reason TEXT
);
```

**Indexes for common query patterns:**

```sql
CREATE INDEX IF NOT EXISTS idx_agents_runtime ON agents(runtime);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_project_path ON agents(project_path);
CREATE INDEX IF NOT EXISTS idx_agent_skills_agent_id ON agent_skills(agent_id);
CREATE INDEX IF NOT EXISTS idx_skill_tags_tag ON skill_tags(tag);
```

FTS5 full-text search on agent name/description is available via better-sqlite3 (SQLite is compiled with FTS5 by default in Node.js distributions). Omit from initial implementation and add later if needed.

**Deny list design**: A separate `deny_list` table keyed by `project_path` is preferable to a status flag on the agents table because:

1. Agents can be denied before they are fully registered
2. Deny list entries should survive agent record deletion/re-registration
3. Simpler to query and maintain independently

### 4. Filesystem Discovery Strategies

Three main approaches exist:

**Approach A: Glob-based (fast-glob or tinyglobby)**

Uses a glob pattern like `**/.dork/agent.json` with depth limits and ignore patterns:

- Pros: Simple one-liner API, battle-tested, handles basic ignore patterns, TypeScript types built-in
- Cons: No cycle detection (fast-glob does NOT detect cyclic symlinks — can heap-OOM), returns all results at once (no streaming for large trees), less control over traversal
- Critical: `followSymbolicLinks` must remain `false` (the default) to avoid cyclic symlink crashes

**Approach B: @nodelib/fs.walk (fast-glob's internal engine)**

Direct use of the underlying walk library with entryFilter/deepFilter/errorFilter callbacks:

- Pros: Streaming callbacks (memory-efficient), fine-grained filter control, errorFilter for graceful permission error handling, well-maintained
- Cons: Lower-level API, still no built-in cycle detection for symlinks that @nodelib/fs.walk resolves

**Approach C: Custom Async BFS Generator (fs.promises)**

Pure Node.js recursive BFS with an explicit queue and visited-path Set for cycle detection:

```typescript
async function* discoverManifests(
  rootDir: string,
  options: DiscoveryOptions
): AsyncGenerator<string> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > options.maxDepth) continue;

    let entries: import('fs').Dirent[];
    try {
      entries = await import('fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') continue;
      throw err;
    }

    for (const entry of entries) {
      const fullPath = import('path').then((p) => p.join(dir, entry.name));
      if (entry.isSymbolicLink()) {
        // Explicit cycle detection via realpath
        const realPath = await import('fs/promises')
          .then((fs) => fs.realpath(String(fullPath)))
          .catch(() => null);
        if (!realPath || visited.has(realPath)) continue;
        visited.add(realPath);
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        queue.push({ dir: String(fullPath), depth: depth + 1 });
      } else if (entry.name === 'agent.json' && dir.endsWith('/.dork')) {
        yield String(fullPath);
      }
    }
  }
}
```

- Pros: Explicit cycle detection via Set of realpaths, AsyncGenerator enables streaming (no buffering), zero extra dependencies, graceful EACCES/EPERM handling
- Cons: More code (~80 lines), queue can grow large for very wide trees (bounded by maxDepth)

### 5. Strategy Pattern for Discovery

The `RelayAdapter` interface in @dorkos/relay is the right template for pluggable discovery strategies:

```typescript
export interface DiscoveryStrategy {
  readonly id: string;
  readonly displayName: string;
  discover(rootDir: string, options: DiscoveryOptions): AsyncGenerator<string>;
  canHandle(rootDir: string): boolean;
}
```

Built-in strategies:

1. **FilesystemStrategy** — Custom BFS (default for home directory scanning)
2. **GlobStrategy** — fast-glob based (for targeted searches with known root patterns)
3. **ProjectListStrategy** — Reads user-configured list of known project directories (no scanning)
4. **WorkspaceStrategy** — Scans npm/pnpm workspace roots from package.json workspaces field

### 6. Multi-Agent Framework Discovery Patterns

AutoGen, CrewAI, and LangGraph do NOT use filesystem-based discovery:

- **AutoGen**: In-memory instantiation, no filesystem markers
- **CrewAI**: Python class instances, programmatic assembly, YAML loaded explicitly not discovered
- **LangGraph**: Graph nodes for agent steps, no filesystem artifact concept

The closest analogues to filesystem-based discovery in the ecosystem:

- **MCP servers**: Discovered via `.claude/mcp.json` or `~/.claude/settings.json`
- **npm workspaces**: Discovered via `package.json#workspaces` glob patterns
- **A2A protocol**: `/.well-known/agent-card.json` at a known HTTP path

DorkOS Mesh's filesystem discovery approach is novel but analogous to MCP tool discovery — a convention-based marker file in a well-known subdirectory.

---

## Detailed Analysis

### Manifest Format: .dork/agent.json vs A2A Agent Card

The A2A Agent Card requires `url` and `authentication` fields that do not apply to local filesystem agents. Proposed .dork/agent.json schema:

```typescript
export interface AgentManifest {
  // A2A-compatible fields
  name: string;
  description: string;
  version: string;
  skills: AgentSkill[];
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
  provider?: {
    name: string;
    url?: string;
  };
  documentationUrl?: string;

  // DorkOS local extensions (not in A2A spec)
  dorkos: {
    /** ULID assigned on first discovery. Stable identifier. */
    id?: string;
    /** Runtime environment for this agent. */
    runtime: 'claude-code' | 'openai-agents' | 'custom';
    /** Subject prefix for Relay messaging. */
    relaySubject?: string;
    /** Whether to auto-discover this agent. */
    autoDiscover?: boolean;
    /** Additional tags for grouping/filtering. */
    tags?: string[];
  };
}
```

This keeps A2A alignment for future HTTP interoperability while accommodating local-first filesystem discovery. When an agent eventually exposes an HTTP endpoint, its A2A agent card can be generated from the manifest.

### SQLite Schema: Normalize vs Denormalize

**Normalized** (separate tables) vs **Denormalized** (JSON text columns) for capabilities and skills:

- Normalized enables efficient indexed queries by capability or tag via JOIN
- Denormalized is simpler but requires JSON parsing in app layer for filtering
- Agent capability and skill tables are small (5-50 rows per agent) so JOIN overhead is negligible
- Verdict: Start normalized, the query patterns map cleanly to indexed lookups

### Discovery Engine: Depth-Limited BFS Parameters

For scanning a home directory, recommended defaults:

- **maxDepth**: 5 (covers `~/projects/company/repo/.dork/agent.json`)
- **Excluded dirs**: `node_modules`, `.git`, `.DS_Store`, `dist`, `build`, `.cache`, `vendor`, `__pycache__`, `.venv`, `venv`
- **Symlink policy**: `followSymbolicLinks: false` by default, opt-in `true` with explicit cycle detection
- **Error handling**: Silently skip `EACCES`/`EPERM`, log `ENOENT` as warning, propagate unexpected errors
- **Timeout**: 30-second wall clock timeout on full home directory scan

---

## Potential Solutions

### 1. Glob-based Discovery (fast-glob)

- Description: Use fast-glob with depth and ignore options to find all `.dork/agent.json` files.
- Pros: Simple API, battle-tested, handles basic ignore patterns, TypeScript types built-in
- Cons: No cycle detection (cyclic symlinks can OOM), returns all results at once, must keep followSymbolicLinks false
- Complexity: Low
- Maintenance: Low

### 2. @nodelib/fs.walk Direct Usage

- Description: Use fast-glob's underlying walk library with entryFilter/deepFilter callbacks.
- Pros: Streaming callbacks, precise filter control, graceful errorFilter for permission errors
- Cons: Lower-level API, less documentation, symlink cycle detection still manual
- Complexity: Medium
- Maintenance: Low-Medium

### 3. Custom Async BFS Generator (Recommended)

- Description: Depth-limited BFS using explicit queue, AsyncGenerator for streaming, Set for cycle detection.
- Pros: Explicit cycle detection, streaming via AsyncGenerator, zero extra dependencies, graceful error handling per entry
- Cons: ~80 lines of code to maintain, BFS queue can grow for very wide trees
- Complexity: Medium
- Maintenance: Medium

### 4. Pluggable Strategy Pattern with Multiple Built-ins

- Description: DiscoveryStrategy interface with FilesystemStrategy, GlobStrategy, and ProjectListStrategy implementations.
- Pros: Extensible, different strategies for different use cases, user-provided custom strategies, future-proof
- Cons: Most code upfront, requires strategy selection logic
- Complexity: High
- Maintenance: Medium

### SQLite: Flat JSON Columns

- Description: Single agents table with capabilities and skills as JSON text blobs.
- Pros: Simplest schema, no JOINs, easy full-record reads
- Cons: Cannot efficiently query by capability or skill tag, requires JSON parsing for filtering
- Complexity: Low
- Maintenance: Low

### SQLite: Normalized Tables (Recommended)

- Description: Separate relational tables with foreign keys and targeted indexes.
- Pros: Efficient indexed queries by runtime/capability/tag, referential integrity, SQL-native filtering
- Cons: More tables, JOIN queries required for full agent records
- Complexity: Medium
- Maintenance: Medium

### SQLite: Normalized + FTS5

- Description: Normalized schema plus FTS5 virtual table for full-text search on names and descriptions.
- Pros: Keyword search with BM25 ranking across agent descriptions
- Cons: FTS5 index sync complexity, likely overkill for initial use case
- Complexity: High
- Maintenance: High

---

## Security Considerations

- **Manifest path traversal**: Validate `project_path` and `manifest_path` against configured boundary using the same `lib/boundary.ts` pattern as the server. Reject manifests resolving outside allowed root.
- **Symlink exploitation**: Default `followSymbolicLinks: false` prevents traversal to sensitive directories via crafted symlinks. The custom BFS uses realpath-based cycle detection as defense-in-depth.
- **Manifest content validation**: Parse manifests via Zod `safeParse`. Log and skip invalid manifests rather than throwing. Never `require()` or `import()` any discovered file.
- **Deny list circumvention**: Match deny list entries on canonical realpath-resolved paths, not raw filesystem paths, to prevent symlink bypasses.
- **ULID predictability**: ULIDs embed a timestamp — they are not secret. If agent isolation requires opaque IDs, do not use agent ID as an access control token.

---

## Performance Considerations

- **Home directory scan timing**: Depth-5 BFS of a typical developer's home directory (5,000-50,000 directories) takes 1-10 seconds. Run once at startup, cache results, use incremental updates via chokidar.
- **Manifest hash for change detection**: Store SHA-256 of manifest content in registry. On rescan, skip unchanged manifests (hash match). Only re-register changed or new agents.
- **Incremental discovery via chokidar**: Watch `**/.dork/agent.json` for creation/modification/deletion events. Same pattern as `session-broadcaster.ts` watching JSONL files.
- **Prepared statements**: Pre-compile all frequent queries in the constructor, following `sqlite-index.ts` pattern.
- **Concurrent reads**: WAL mode allows concurrent reads during indexing. No read locking needed.
- **Directory exclusion early-exit**: Use `Set<string>` for excluded directory names — O(1) lookup before calling `readdir`.

---

## Contradictions and Disputes

- **A2A alignment tension**: A2A requires `url` and `authentication`. Options: (a) make them optional and omit — cleanest, (b) use a placeholder URL like `dorkos://local/<agent-id>`, (c) ignore A2A for now and add a conversion utility later. Option (a) is recommended.
- **ULID vs UUID v7**: UUID v7 has better ecosystem compatibility (PostgreSQL native, standard UUID APIs). ULID has better compactness and readability, and @dorkos/relay already uses it. ULID wins for DorkOS.
- **Discovery scope**: Scanning all of `~` is comprehensive but slow. User-configured paths from `~/.dork/config.json` with opt-in full home scan is the pragmatic default.
- **symlink following**: Safe default is no following. Opt-in with explicit cycle detection is the right compromise.

---

## Recommendation

**Recommended Approach**: Pluggable Strategy Pattern with Custom BFS as the primary strategy, normalized SQLite schema, A2A-compatible manifest with DorkOS extensions.

**Discovery Engine**: Implement `DiscoveryStrategy` interface. Ship `FilesystemStrategy` as the primary implementation using a custom async BFS generator with explicit realpath-based symlink cycle detection. Also ship `GlobStrategy` for targeted scanning and `ProjectListStrategy` for explicit user configuration. This mirrors the `RelayAdapter` plugin pattern from @dorkos/relay.

**SQLite Schema**: Use normalized multi-table schema (agents + agent_capabilities + agent_skills + skill_tags + deny_list) with WAL mode, following the exact pattern from `packages/relay/src/sqlite-index.ts`. Skip FTS5 in v1.

**Manifest Format**: Align top-level fields with A2A AgentCard spec (name, description, version, skills, capabilities, provider, documentationUrl). Add `dorkos` extension namespace for local-specific fields (id, runtime, relaySubject, tags). File location: `.dork/agent.json` in the project root.

**ULID**: Use `ulidx` with `monotonicFactory`. Assign on first discovery, persist to `dorkos.id` in the manifest file for stable cross-rescan identity.

**Rationale**: Maximizes consistency with existing codebase (relay SQLite patterns, adapter plugin pattern, ulidx), provides safe filesystem scanning defaults, leaves clean extension points for future capabilities.

**Caveats**:

- Custom BFS requires thorough testing with edge cases (permission errors, symlink cycles, very deep nesting, empty directories). Use Vitest with temp directory fixtures.
- Writing the ULID back to `dorkos.id` in the manifest requires file locking if multiple processes scan simultaneously.
- A2A spec uses protocol buffer (proto) as normative definition — monitor the spec for AgentCard field changes as it matures under Linux Foundation governance.

---

## Search Methodology

- Number of searches performed: 14
- Most productive search terms: "A2A Agent Card specification Linux Foundation 2025", "ulidx monotonicity guarantees", "fast-glob symlink cycle detection", "SQLite better-sqlite3 PRAGMA user_version migration"
- Primary information sources: a2a-protocol.org, github.com/perry-mitchell/ulidx, sqlite.org, packages/relay/src/sqlite-index.ts (codebase), agent2agent.info

---

## Sources

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [AgentCard Concepts — agent2agent.info](https://agent2agent.info/docs/concepts/agentcard/)
- [GitHub: a2aproject/A2A](https://github.com/a2aproject/A2A)
- [Linux Foundation A2A Announcement](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)
- [ulidx on npm](https://www.npmjs.com/package/ulidx)
- [GitHub: perry-mitchell/ulidx README](https://github.com/perry-mitchell/ulidx/blob/main/README.md)
- [ULID Spec](https://github.com/ulid/spec)
- [UUIDv4 vs UUIDv7 vs ULID — Medium](https://medium.com/@ciro-gomes-dev/uuidv4-vs-uuidv7-vs-ulid-choosing-the-right-identifier-for-database-performance-1f7d1a0fe0ba)
- [Time-Sortable Identifiers Explained — Authgear](https://www.authgear.com/post/time-sortable-identifiers-uuidv7-ulid-snowflake)
- [SQLite WAL Mode — sqlite.org](https://sqlite.org/wal.html)
- [SQLite PRAGMA Statements](https://sqlite.org/pragma.html)
- [SQLite FTS5 Extension](https://sqlite.org/fts5.html)
- [better-sqlite3-migrations](https://github.com/BlackGlory/better-sqlite3-migrations)
- [SQLite DB Migrations with PRAGMA user_version](https://levlaz.org/sqlite-db-migrations-with-pragma-user_version/)
- [fast-glob on npm](https://www.npmjs.com/package/fast-glob)
- [GitHub: mrmlnc/fast-glob](https://github.com/mrmlnc/fast-glob)
- [tinyglobby on npm](https://www.npmjs.com/package/tinyglobby)
- [fast-glob symlink cycle issue #300](https://github.com/mrmlnc/fast-glob/issues/300)
- [Node.js fs.readdirSync symlink behavior issue #51858](https://github.com/nodejs/node/issues/51858)
- [CrewAI vs LangGraph vs AutoGen — DataCamp](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [Agent Communication Protocol Manifest](https://agentcommunicationprotocol.dev/core-concepts/agent-manifest)
- [JSON Agents Portable Agent Manifest](https://jsonagents.org/)
- [SQLite Best Practices for Schema and Indexes — Medium](https://medium.com/@firmanbrilian/best-practices-for-managing-schema-indexes-and-storage-in-sqlite-for-data-engineering-266b7fa65f4c)
- [Speeding up JavaScript ecosystem — module resolution](https://marvinh.dev/blog/speeding-up-javascript-ecosystem-part-2/)
- [Walking The File Directory — Medium](https://medium.com/@patrickshaughnessy/walking-the-file-directory-a98ddd4bf164)
