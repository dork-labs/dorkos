---
slug: relay-core-library
number: 50
created: 2026-02-24
status: ideation
---

# Relay Core Library

**Slug:** relay-core-library
**Author:** Claude Code
**Date:** 2026-02-24
**Branch:** preflight/relay-core-library
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Build `@dorkos/relay` — a pure TypeScript library implementing the foundational message bus for DorkOS. Includes NATS-style hierarchical subject matching, Maildir-based message storage with SQLite indexing, budget envelope enforcement, ephemeral signals via EventEmitter, dead letter queue, and pattern-based access control.
- **Assumptions:**
  - This is a new package at `packages/relay/` following existing monorepo conventions
  - The design doc (`plans/2026-02-24-relay-design.md`) and litepaper (`meta/modules/relay-litepaper.md`) contain all settled design decisions
  - The library is standalone — no dependency on `apps/server` or `apps/client`
  - `better-sqlite3` (already used by PulseStore) and `ulidx` are acceptable dependencies
  - `chokidar` (already used by session-broadcaster) is acceptable for file watching
  - Storage root defaults to `~/.dork/relay/` following the existing `~/.dork/` convention
- **Out of scope:**
  - HTTP routes and Express integration (Spec 2)
  - MCP tools for agents (Spec 2)
  - Client UI (Spec 2)
  - Rate limiting, circuit breakers, backpressure (Spec 3)
  - External adapters — Telegram, Slack, webhooks (Spec 4)
  - Pulse migration, Console migration (Spec 5)

## 2) Pre-reading Log

- `meta/modules/relay-litepaper.md`: Vision for Relay as kernel IPC for agents — D-Bus analogy, Maildir + SQLite storage, NATS-style hierarchical subjects, budget envelopes for loop prevention, message persistence vs ephemeral signals
- `plans/2026-02-24-relay-design.md`: Complete technical decisions with TypeScript interfaces, directory structure (`~/.dork/relay/`), all design patterns settled, Maildir delivery via atomic rename, SQLite WAL mode, subject matching inline implementation (~80-200 lines)
- `research/mesh/communication-protocols.md`: FIPA ACL reference, Maildir specifics (tmp/new/cur/failed), loop prevention via hop count + ancestor chain, dead letter queue, contract net protocol
- `research/mesh/architecture-analogies.md`: D-Bus control/data plane split, Mach ports capability model, Consul registry pattern, service mesh concepts
- `research/mesh/access-control-coordination.md`: Layered authorization (declared capabilities + scoped tokens + policy evaluation), object-capability model, budget envelopes, threat model
- `research/20260224_agent_messaging_transport_libraries.md`: Transport library evaluation — concluded inline implementation (~200-300 lines)
- `plans/2026-02-24-litepaper-review.md`: Open design questions OQ-3 (agent identity fallback), OQ-4 (access control in Relay litepaper), OQ-5 (deadline vs TTL redundancy — resolved: TTL only)
- `packages/shared/package.json`: Dual-entry exports pattern, `@dorkos/` scope, private workspace, zod-to-openapi dependency
- `packages/shared/tsconfig.json`: Extends `@dorkos/typescript-config/node.json` with `outDir: ./dist`
- `packages/shared/src/schemas.ts`: Zod schema + inferred type export pattern with `.openapi()` metadata
- `apps/server/src/services/pulse-store.ts`: SQLite reference — WAL mode, `PRAGMA user_version` migrations, prepared statements, `~/.dork/` file convention
- `vitest.workspace.ts`: Current workspace projects (client, roadmap, server, cli, shared) — needs `packages/relay` added
- `packages/typescript-config/`: base.json (ES2022, strict), node.json (NodeNext module resolution)

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/` (NEW) — entire package to create
    - `src/relay-core.ts` — main `RelayCore` class composing all modules
    - `src/subject-matcher.ts` — NATS-style hierarchical subject matching (~50-80 lines)
    - `src/endpoint-registry.ts` — endpoint + subscription management
    - `src/maildir-store.ts` — Maildir delivery (tmp -> new -> cur -> failed)
    - `src/sqlite-index.ts` — SQLite indexing layer (derived, rebuildable)
    - `src/budget-enforcer.ts` — hop count, ancestor chain, TTL, cycle detection
    - `src/signal-emitter.ts` — typed EventEmitter wrapper for ephemeral signals
    - `src/dead-letter-queue.ts` — failed message storage with rejection reasons
    - `src/access-control.ts` — pattern-based allow/deny rules
    - `src/types.ts` — internal types
    - `src/index.ts` — barrel export
  - `packages/shared/src/relay-schemas.ts` (NEW) — Zod schemas for RelayEnvelope, RelayBudget, StandardPayload, signal types, access rules
- **Shared dependencies:**
  - `@dorkos/shared` — Zod schemas, shared types
  - `@dorkos/typescript-config` — tsconfig preset (node.json)
  - `better-sqlite3` — SQLite database (WAL mode, same pattern as PulseStore)
  - `ulidx` — ULID generation (monotonic factory for chronological message IDs)
  - `chokidar` — filesystem watching for new message arrival in mailboxes
  - `zod` — schema validation (via @dorkos/shared)
- **Data flow:**
  - Publish: `RelayCore.publish(subject, payload)` -> budget enforcement -> access control check -> Maildir write (tmp -> new atomic rename) -> SQLite index insert -> chokidar detects new file -> subscriber callbacks fired
  - Subscribe: `RelayCore.subscribe(pattern, handler)` -> subject pattern validated -> subscription registered -> chokidar watches endpoint's `new/` directory
  - Signal: `RelayCore.signal(subject, data)` -> EventEmitter.emit() (never touches disk)
- **Feature flags/config:** None — pure library with constructor options
- **Potential blast radius:**
  - Direct: ~12-15 new files in `packages/relay/`, 1 new file in `packages/shared/`
  - Indirect: `vitest.workspace.ts` (add workspace entry), `packages/shared/package.json` (add relay-schemas export)
  - Tests: ~8-10 test files in `packages/relay/__tests__/`

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

### Potential Solutions

**1. Maildir Storage**
- Description: Implement Maildir protocol directly — atomic file delivery via POSIX rename, one file per message, ULID as filename
- Pros: Crash-safe delivery, simple inspection, filesystem-level durability, ~80 lines of code
- Cons: Scalability degrades past ~100K files per directory (mitigated by per-endpoint subdirectories)
- Recommendation: **Direct implementation** — existing Node.js Maildir libraries are email-centric or abandoned. Use `O_CREAT | O_EXCL` for safe tmp writes, `fs.rename()` for atomic delivery.

**2. Subject Matching**
- Description: Three approaches evaluated — trie (NATS production), pre-compiled regex per pattern, linear token scan
- Pros (linear scan): Simplest (~30 lines), zero dependencies, easy to test, O(N) per publish where N = subscription count
- Cons: Not optimal for >1000 subscriptions (but DorkOS won't hit this threshold initially)
- Recommendation: **Linear token scan** with a `SubjectMatcher` interface for future trie upgrade. Enforce strict validation (no empty tokens, no consecutive dots, `>` only as last token, wildcards as standalone tokens only).

**3. Message IDs (ULID)**
- Description: `ulidx` with `monotonicFactory()` for guaranteed monotonic ordering within same millisecond
- Pros: Timestamp-ordered (free chronological sort), 26-char compact format, sequential B-tree inserts (2-5x better SQLite perf), double-duty as Maildir filename
- Cons: External dependency (small, well-maintained)
- Recommendation: **`ulidx` monotonicFactory()** — ULID serves as message ID, filename, and sort key simultaneously.

**4. SQLite Configuration**
- Description: `better-sqlite3` with WAL mode following PulseStore pattern
- PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `temp_store=MEMORY`
- Migration pattern: `PRAGMA user_version` with sequential migration array
- Recommendation: **Copy PulseStore pattern exactly** — proven in this codebase, synchronous API appropriate for embedded message bus.

**5. Typed EventEmitter**
- Description: Native `EventEmitter<TEventMap>` generics from `@types/node` (available since Node 20.11+)
- Pros: Zero extra dependencies, fully integrated with Node.js lifecycle, supports `once()`, `removeAllListeners()`, `setMaxListeners()`, async `events.once()`
- Cons: Requires `@types/node` >= 20.11.0 (already satisfied in this project)
- Recommendation: **Native generics** — extend `EventEmitter<RelaySignalEvents>` with typed event map.

### Security Considerations
- Maildir file permissions: `mode: 0o700` for directory, `mode: 0o600` for files, use `O_CREAT | O_EXCL` to prevent TOCTOU
- SQLite injection: Always use prepared statements via better-sqlite3 (never string interpolation)
- Subject validation doubles as injection guard (limited character set: alphanumeric, dot, dash, underscore)
- EventEmitter DoS: Per-endpoint subscription limit to prevent listener flooding

### Performance Considerations
- SQLite WAL + `synchronous=NORMAL`: ~10,000-50,000 inserts/sec (vs ~100-500 with default journal)
- ULID sequential inserts: eliminate B-tree page splits that random UUIDs cause
- Linear subject matching: ~1ms for 1,000 subscription checks (adequate for initial scale)
- chokidar uses native OS APIs (FSEvents on macOS, inotify on Linux) — zero-polling

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Message ID format | ULID via `ulidx` | Monotonic ordering, compact 26-char format, sequential B-tree inserts boost SQLite perf 2-5x, doubles as Maildir filename. Research confirms `ulidx` is actively maintained. |
| 2 | TTL vs Deadline in RelayBudget | TTL only — remove `deadline` | Simplifies budget enforcement to one expiry field. Consumers can encode deadline in payload if needed. Resolves litepaper OQ-5. |
| 3 | New message delivery mode | Push via chokidar | Matches existing pattern (session-broadcaster.ts). Subscribers get instant delivery via native OS file watching. chokidar already in the project. |
