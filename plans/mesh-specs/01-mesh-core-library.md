---
title: "Mesh Core Library"
spec: 1
order: 1
status: done
blockedBy: []
blocks: [2]
parallelWith: []
litepaperPhase: "Phase 1 — Discovery, Registration, and Registry"
complexity: high
risk: high
estimatedFiles: 15-20
newPackages: ["packages/mesh"]
primaryWorkspaces: ["packages/mesh", "packages/shared"]
touchesServer: false
touchesClient: false
verification:
  - "npm test passes for packages/mesh"
  - "npm run typecheck passes"
  - "MeshCore can be instantiated and discover agents in a test fixture directory"
  - "ClaudeCodeStrategy detects .claude/ directories with CLAUDE.md"
  - "CursorStrategy detects .cursor/ directories"
  - "Discovery skips directories with existing .dork/agent.json (already registered)"
  - "Discovery skips denied agents"
  - "Registration writes .dork/agent.json with correct schema"
  - "Registration creates Relay endpoint for the agent"
  - "Denial persists in SQLite and filters from future scans"
  - "Manual registration by path works without discovery"
  - "Importing hand-authored .dork/agent.json works (auto-import on scan)"
  - "Agent registry persists across MeshCore restarts"
notes: >
  This is the foundation — everything else depends on it. The core challenge
  is the discovery strategy plugin system and the two-phase lifecycle (discover
  → register). Follow the Relay core library pattern: pure TypeScript library
  with no HTTP, no Express, no client. The library must compose with RelayCore
  for endpoint registration and ACL rule creation. Expect ~1500-2500 lines
  including tests. Study packages/relay/ for the package structure pattern.
---

# Spec 1: Mesh Core Library

## Prompt

```
Build the @dorkos/mesh core library package — the agent discovery and network topology layer for DorkOS.

This is a new package at packages/mesh/ that implements the foundational discovery, registration, and registry described in the Mesh litepaper. It's a pure TypeScript library with NO HTTP layer, NO Express routes, and NO client UI. Those come in a later spec.

GOALS:
- Create packages/mesh/ as a new workspace package following existing conventions (see packages/relay/ and packages/shared/ for reference)
- Implement a pluggable discovery strategy interface — each strategy detects agent projects by filesystem markers and extracts hints (name, runtime, capabilities)
- Implement built-in strategies: ClaudeCodeStrategy (.claude/ with CLAUDE.md), CursorStrategy (.cursor/), CodexStrategy (.codex/)
- Implement a discovery engine that scans configured root directories with configurable depth, runs strategies against each candidate, and filters against the deny list and existing registrations
- Implement an agent registry with SQLite persistence (better-sqlite3, WAL mode) — stores registered agents with full manifest data plus filesystem path
- Implement a deny list with SQLite persistence — stores denied candidates with path, strategy, reason, denied_by, denied_at
- Implement a manifest reader/writer for .dork/agent.json — reads existing manifests (auto-import), writes manifests at registration time with ULID IDs and registration metadata
- Implement Relay integration — when an agent is registered, create a Relay endpoint at relay.agent.{project}.{agentId} and configure basic access rules. Accept RelayCore as an optional dependency (Mesh works without Relay, just without endpoints)
- Implement MeshCore class that composes all modules into a single entry point (discover, register, deny, unregister, list, get)
- Add all Zod schemas to packages/shared/src/mesh-schemas.ts (AgentManifest, DiscoveryCandidate, DiscoveryStrategy config, registration/denial records)
- Comprehensive unit tests for every module, especially discovery strategy edge cases and the discover→register lifecycle

INTENDED OUTCOMES:
- A working, tested packages/mesh/ package that can be imported as @dorkos/mesh
- Zod schemas in @dorkos/shared/mesh-schemas for manifest, candidate, registry, and denial types
- Full test coverage with vitest (add packages/mesh to vitest.workspace.ts)
- The library should be usable standalone — no dependency on apps/server or apps/client
- RelayCore integration is optional — MeshCore accepts it via constructor but works without it

KEY DESIGN DECISIONS (already made — see litepaper v2):
- Discovery is reconnaissance, registration is commitment. Two distinct phases.
- Pluggable strategies with a simple interface: detect(dir) → boolean, extractHints(dir) → AgentHints
- .dork/agent.json is Mesh's artifact — written at registration, importable if hand-authored
- If .dork/agent.json already exists in a scanned directory, auto-import to registry (no approval needed)
- Denied candidates stored in Mesh's SQLite, not in the project directory
- Agent IDs are ULIDs, generated at registration time
- Registration records who approved (human:console, human:cli, agent:{id}) and when
- Three approval interfaces converge on the same MeshCore methods — the library doesn't care who calls register()

THE AGENT LIFECYCLE:
  Unknown → Discovered (by strategy) → Registered (approved) or Denied (rejected)
  Also: Manual Registration (bypasses discovery, goes straight to Registered)
  Also: Auto-Import (existing .dork/agent.json → straight to registry)

THE AGENT MANIFEST (.dork/agent.json):
  - id: ULID (generated at registration)
  - name: string (human-readable)
  - description: string
  - runtime: "claude-code" | "cursor" | "codex" | "other"
  - capabilities: string[] (freeform — "code", "test", "deploy", "budget-approval", etc.)
  - behavior: { responseMode, escalation rules }
  - budget: { maxHopsPerMessage, maxCallsPerHour }
  - registeredAt: ISO timestamp
  - registeredBy: string ("human:console", "human:cli", "agent:{agentId}")

DISCOVERY STRATEGY INTERFACE:
  - name: string (e.g., "claude-code", "cursor", "codex")
  - detect(dir: string): Promise<boolean> — does this directory match?
  - extractHints(dir: string): Promise<AgentHints> — what can we infer?
  AgentHints: { suggestedName, detectedRuntime, inferredCapabilities?, description? }

REFERENCE DOCUMENTS (read these during exploration):
- meta/modules/mesh-litepaper.md — full vision document (v2, updated with lifecycle/strategies/registration)
- meta/modules/relay-litepaper.md — Relay architecture that Mesh integrates with
- meta/dorkos-litepaper.md — system-level architecture, Mesh section

CODEBASE PATTERNS TO FOLLOW:
- Package structure: packages/relay/package.json (workspace package, ESM, @dorkos/ scope)
- SQLite usage: packages/relay/src/sqlite-index.ts and apps/server/src/services/pulse-store.ts (better-sqlite3, WAL mode, PRAGMA user_version migrations)
- Zod schemas: packages/shared/src/relay-schemas.ts (schema + inferred type export pattern)
- Test setup: vitest.workspace.ts and packages/relay/src/__tests__/ directories
- ULID generation: packages/relay/ uses ulidx for monotonic ULIDs
- Relay integration: packages/relay/src/relay-core.ts — the RelayCore API for registerEndpoint(), addAccessRule(), publish()

OUT OF SCOPE for this spec:
- HTTP routes (Spec 2)
- MCP tools for agents (Spec 2)
- Client UI (Spec 2)
- Network topology and namespace isolation (Spec 3)
- Console topology visualization (Spec 4)
- Lazy activation and supervision (Spec 4)
- chokidar filesystem watching for live discovery (Spec 2 or later — Spec 1 uses on-demand scanning)
```

## Context for Review

This is the foundation spec — everything else builds on it. The /ideate exploration agent should focus heavily on:
- How `packages/relay/` is structured (package.json exports, tsconfig, vitest config, build)
- How `packages/relay/src/relay-core.ts` exposes its API (constructor, methods, events)
- The SQLite patterns in `packages/relay/src/sqlite-index.ts` and `apps/server/src/services/pulse-store.ts`
- The Zod schema pattern in `packages/shared/src/relay-schemas.ts`
- How RelayCore's `registerEndpoint()` and `addAccessRule()` methods work

The /ideate research agent should investigate:
- Agent discovery patterns in multi-agent frameworks (AutoGen, CrewAI, LangGraph)
- A2A Agent Card standard from Linux Foundation (alignment with .dork/agent.json)
- Filesystem scanning strategies (depth-limited BFS, symlink handling, permission errors)
- SQLite schema design for agent registries (querying by capability, by runtime, by project)
- ULID generation and monotonicity guarantees
