---
slug: mesh-core-library
number: 54
created: 2026-02-24
status: ideation
---

# Mesh Core Library — Agent Discovery & Registry Package

**Slug:** mesh-core-library
**Author:** Claude Code
**Date:** 2026-02-24
**Branch:** preflight/mesh-core-library
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Build `@dorkos/mesh` — a pure TypeScript library package at `packages/mesh/` implementing pluggable agent discovery strategies, a two-phase lifecycle (discover → register/deny), SQLite-backed agent registry and deny list, `.dork/agent.json` manifest management, optional RelayCore integration for endpoint registration, and a composing `MeshCore` class.
- **Assumptions:**
  - Relay Specs 1-2 are complete — `@dorkos/relay` is available as an optional dependency for endpoint registration
  - Follows existing `packages/relay/` package structure conventions (ESM, @dorkos/ scope, vitest)
  - Uses better-sqlite3 with WAL mode (same pattern as Relay's sqlite-index.ts and PulseStore)
  - Uses ulidx with monotonicFactory for agent IDs (same as Relay)
  - Pure library — no HTTP routes, no Express, no client code
  - Agent count is small (5-50 agents per installation) — no need for complex indexing
- **Out of scope:**
  - HTTP routes and MCP tools (Mesh Spec 2)
  - Client UI for discovery/registration (Mesh Spec 2)
  - Network topology and namespace isolation / cross-project ACL (Mesh Spec 3)
  - Observability, visualization, lifecycle events (Mesh Spec 4)
  - Filesystem watching for live discovery (future — Spec 1 uses on-demand scanning)
  - FTS5 full-text search on agent descriptions (can add later if needed)

## 2) Pre-reading Log

- `meta/modules/mesh-litepaper.md`: Full Mesh vision — agent lifecycle (Unknown → Discovered → Registered/Denied), pluggable discovery strategies, .dork/agent.json as commitment artifact, three approval interfaces, Relay integration on registration
- `meta/modules/relay-litepaper.md`: Foundation messaging layer — subject hierarchy, endpoint registry, access control, budget envelopes. Mesh depends on Relay, Relay depends on nothing.
- `meta/dorkos-litepaper.md`: System architecture showing Mesh (discovery) sits above Relay (messaging)
- `plans/mesh-specs/01-mesh-core-library.md`: Detailed spec with verification criteria, ~15-20 files, ~1500-2500 LOC
- `packages/relay/package.json`: Workspace package pattern — ESM, @dorkos/ scope, exports main entry. Dependencies: better-sqlite3, ulidx, chokidar, @dorkos/shared
- `packages/relay/tsconfig.json`: Extends @dorkos/typescript-config/node.json, outDir: dist
- `packages/relay/vitest.config.ts`: Node environment, includes src/**/**tests**/**/\*.test.ts
- `packages/relay/src/relay-core.ts`: Main class composes EndpointRegistry, MaildirStore, SqliteIndex, DeadLetterQueue, AccessControl. Constructor takes RelayOptions (dataDir, maxHops, defaultTtlMs). Key method: `registerEndpoint(subject)` returns EndpointInfo
- `packages/relay/src/access-control.ts`: Pattern-based ACL with JSON persistence (access-rules.json), hot-reload via chokidar, rules sorted by priority. Method `checkAccess(sender, recipient)` returns { allowed, matchedRule }
- `packages/relay/src/sqlite-index.ts`: SQLite pattern — better-sqlite3, WAL mode, PRAGMA user_version migrations, prepared statements compiled in constructor
- `apps/server/src/services/pulse/pulse-store.ts`: Same SQLite pattern — WAL + NORMAL sync + busy_timeout 5000, migrations array, prepared statements
- `packages/shared/src/relay-schemas.ts`: Zod schemas with .openapi() metadata, exports inferred types via z.infer<>
- `packages/shared/package.json`: Subpath exports (./schemas, ./relay-schemas, ./config-schema). Each maps to src/file.ts and dist/file.js
- `vitest.workspace.ts`: Workspace test config — add 'packages/mesh' to array
- `packages/relay/src/__tests__/adapter-registry.test.ts`: Test pattern — mock factories, vi.fn() spies, beforeEach setup
- `turbo.json`: globalPassThroughEnv includes DORKOS_RELAY_ENABLED (feature flag pattern for future DORKOS_MESH_ENABLED)

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/src/relay-core.ts` — RelayCore class (MeshCore depends on for endpoint registration)
  - `packages/relay/src/access-control.ts` — ACL enforcement (Mesh writes rules here on registration)
  - `packages/relay/src/endpoint-registry.ts` — In-memory endpoint tracking
  - `packages/relay/src/sqlite-index.ts` — SQLite pattern to replicate for Mesh registry
  - `packages/shared/src/relay-schemas.ts` — Zod schema pattern to follow for mesh-schemas.ts
  - `packages/shared/package.json` — Subpath export pattern for adding ./mesh-schemas
  - `apps/server/src/services/pulse/pulse-store.ts` — Additional SQLite reference pattern
- **Shared dependencies:**
  - `zod` — Schema validation + type inference (for mesh-schemas.ts)
  - `@asteasolutions/zod-to-openapi` — OpenAPI metadata on schemas
  - `better-sqlite3` — SQLite persistence (agent registry, denial list)
  - `ulidx` — ULID generation (agent IDs)
  - `@dorkos/shared` — Central type definitions (new mesh-schemas.ts)
  - `@dorkos/relay` — Optional dependency for endpoint registration
- **Data flow:**
  - Discovery: `MeshCore.discover(roots, depth)` → `DiscoveryEngine.scan()` → `Strategy[].detect(dir)` → filter denials + existing → `DiscoveryCandidate[]`
  - Registration: `MeshCore.register(candidate, approver)` → `ManifestWriter.write(.dork/agent.json)` → `AgentRegistry.insert()` → `RelayCore.registerEndpoint()` (optional)
  - Denial: `MeshCore.deny(candidate, reason, denier)` → `DenialList.insert()` → filtered from future scans
  - Auto-import: Discovery finds existing `.dork/agent.json` → `ManifestReader.read()` → `AgentRegistry.upsert()` directly
- **Feature flags/config:**
  - Future `DORKOS_MESH_ENABLED` in turbo.json globalPassThroughEnv (Spec 2)
  - MeshCore constructor options: `{ dataDir, relayCore?, strategies? }`
- **Potential blast radius:**
  - New files (packages/mesh/): ~18-22 files (source + tests + config)
  - Modified files: `packages/shared/package.json` (add export), `packages/shared/src/mesh-schemas.ts` (new), `vitest.workspace.ts` (add entry), root `package.json` (workspace)
  - Test files: ~10-12 test files in packages/mesh/src/**tests**/

## 4) Root Cause Analysis

N/A — this is new feature work, not a bug fix.

## 5) Research

- **Potential solutions:**

  **1. Discovery Engine — Custom Async BFS Generator (Recommended)**
  - Depth-limited BFS using explicit queue, AsyncGenerator for streaming, Set<realpath> for symlink cycle detection
  - Pros: Explicit cycle detection (safe with symlinks), streaming results, zero extra deps, graceful EACCES/EPERM handling
  - Cons: ~80 lines to maintain, BFS queue grows for wide trees
  - Complexity: Medium

  **2. Discovery Engine — fast-glob**
  - Glob patterns with depth/ignore options
  - Pros: Simple API, battle-tested
  - Cons: No symlink cycle detection (documented OOM risk), no streaming, less control
  - Complexity: Low

  **3. SQLite Schema — Simple JSON columns (Recommended)**
  - 2 tables (agents + denials), capabilities stored as JSON text column
  - Pros: Simple, sufficient for 5-50 agents, matches litepaper's capabilities: string[]
  - Cons: No indexed capability queries
  - Complexity: Low

  **4. SQLite Schema — Normalized tables**
  - 5 tables (agents, capabilities, skills, tags, denials) with foreign keys
  - Pros: SQL-native capability queries with indexed JOINs
  - Cons: Overkill for small registries, more complex schema
  - Complexity: Medium

  **5. Agent ID — ULID via ulidx monotonicFactory (Recommended)**
  - Monotonic within same millisecond, consistent with @dorkos/relay
  - Alternative: UUID v7 (better ecosystem support but less compact)

  **6. Multi-agent framework survey**
  - AutoGen, CrewAI, LangGraph all use in-memory registration, not filesystem discovery
  - DorkOS's filesystem approach is novel, analogous to MCP server discovery (.claude/mcp.json)

  **7. A2A Agent Card standard (Linux Foundation)**
  - HTTP-centric standard with name, description, version, skills[], capabilities{}, provider{}, url (required), authentication
  - Useful alignment for future HTTP interop, but url/authentication don't apply to local agents
  - Decision: use DorkOS-native format at .dork/agent.json, add toAgentCard() conversion later

- **Recommendation:** Custom async BFS with pluggable strategy interface, simple 2-table SQLite schema with JSON columns, DorkOS-native manifest format, ULID via ulidx. This minimizes complexity while leaving clean extension points.

## 6) Decisions

| #   | Decision                     | Choice                                           | Rationale                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Discovery engine approach    | Custom async BFS with pluggable strategies       | Only approach with explicit symlink cycle detection. Strategies are pluggable detectors (ClaudeCodeStrategy, etc.) that answer "is this an agent?" — not filesystem walkers. Mirrors RelayAdapter plugin pattern.                                                                                   |
| 2   | Manifest format and location | `.dork/agent.json` with DorkOS-native fields     | Litepaper specifies this path. DorkOS-native format (id, name, runtime, capabilities[], behavior, budget, registeredAt, registeredBy) is purpose-built and simple. A2A conversion (toAgentCard()) can be added later for HTTP interop. `.dork/` is DorkOS's namespace, `.well-known/` is HTTP-only. |
| 3   | SQLite schema design         | Simple JSON columns (2 tables: agents + denials) | Agent count is small (5-50). JSON columns for capabilities/manifest are sufficient. Normalized tables with JOINs are overkill. json_each() available if SQL-native filtering is ever needed.                                                                                                        |
