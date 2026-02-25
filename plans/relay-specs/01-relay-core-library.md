---
title: "Relay Core Library"
spec: 1
order: 1
status: done
blockedBy: []
blocks: [2]
parallelWith: []
litepaperPhase: "Phase 1 — Core Transport and Safety"
complexity: high
risk: high
estimatedFiles: 15-20
newPackages: ["packages/relay"]
primaryWorkspaces: ["packages/relay", "packages/shared"]
touchesServer: false
touchesClient: false
verification:
  - "npm test passes for packages/relay"
  - "npm run typecheck passes"
  - "RelayCore can be instantiated and send/receive messages in a test"
  - "Subject matching handles *, >, and literal subjects correctly"
  - "Budget enforcement rejects over-limit messages and detects cycles"
  - "Maildir atomic delivery works (tmp → new rename)"
  - "Dead letter queue captures rejected messages with reasons"
  - "Signals fire via EventEmitter without touching disk"
  - "SQLite index is rebuildable from Maildir files"
notes: >
  This is the foundation — everything else depends on it. Take extra care
  with subject matching edge cases and budget enforcement logic. The design
  doc estimates ~200-300 lines for core transport, but with tests and schemas
  expect 1500-2000 lines total. No HTTP, no Express, no client — pure library.
---

# Spec 1: Relay Core Library

## Prompt

```
Build the @dorkos/relay core library package — the universal message bus for DorkOS.

This is a new package at packages/relay/ that implements the foundational messaging layer described in the Relay litepaper. It's a pure TypeScript library with NO HTTP layer, NO Express routes, and NO client UI. Those come in a later spec.

GOALS:
- Create packages/relay/ as a new workspace package following existing conventions (see packages/shared/ for reference)
- Implement NATS-style hierarchical subject matching with * and > wildcards
- Implement an endpoint registry for registering and looking up message endpoints
- Implement a subscription registry for pattern-based pub/sub
- Implement Maildir-based message storage (tmp/ → new/ → cur/ → failed/) with atomic POSIX rename delivery
- Implement SQLite indexing layer (derived from Maildir, fully rebuildable) using better-sqlite3
- Implement budget envelope enforcement (hop count, max hops, ancestor chain cycle detection, TTL expiry, call budget decrement) — budgets can only shrink, never grow
- Implement ephemeral signal mode via EventEmitter (typing, presence, read receipts — never touches disk)
- Implement dead letter queue for rejected/failed messages with rejection reasons
- Implement pattern-based access control rules (allow/deny with priority evaluation, default-allow)
- Create RelayCore class that composes all modules into a single entry point
- Add all Zod schemas to packages/shared/src/relay-schemas.ts (RelayEnvelope, RelayBudget, StandardPayload, signal types, access rules) — use a dedicated file, not the existing schemas.ts which is already 684 lines
- Comprehensive unit tests for every module, especially subject matching edge cases and budget enforcement logic

INTENDED OUTCOMES:
- A working, tested packages/relay/ package that can be imported as @dorkos/relay
- Zod schemas in @dorkos/shared/relay-schemas for envelope, budget, payload, and signal types
- Full test coverage with vitest (add packages/relay to vitest.workspace.ts)
- The library should be usable standalone — no dependency on apps/server or apps/client

KEY DESIGN DECISIONS (already made — see design doc):
- Transport: Maildir for storage (source of truth), SQLite for indexing (derived, rebuildable)
- Delivery guarantee: at-most-once, no retries, failed → dead letter queue
- Ordering: per-endpoint FIFO by timestamp/ULID
- Envelope: thin routing + safety only, payload is opaque to Relay
- Subject hierarchy is convention (relay.agent.{project}.{id}), not enforced by code
- Access control: default-allow, configurable deny, highest-priority-first evaluation

REFERENCE DOCUMENTS (read these during exploration):
- meta/modules/relay-litepaper.md — full vision document
- docs/plans/2026-02-24-relay-design.md — all technical decisions, TypeScript interfaces, directory structure, implementation estimates
- research/mesh/communication-protocols.md — FIPA ACL, Maildir mechanics, loop prevention
- research/mesh/architecture-analogies.md — D-Bus, Mach ports, NATS subject patterns
- research/mesh/access-control-coordination.md — budget envelopes, circuit breakers, capability-based access
- research/20260224_agent_messaging_transport_libraries.md — transport library evaluation (concluded: inline implementation, ~200-300 lines)
- docs/plans/2026-02-24-litepaper-review.md — open design questions OQ-3 (agent identity fallback), OQ-4 (access control in Relay litepaper), OQ-5 (deadline vs ttl redundancy)

CODEBASE PATTERNS TO FOLLOW:
- Package structure: packages/shared/package.json (dual-entry exports, @dorkos/ scope, private, ESM)
- SQLite usage: apps/server/src/services/pulse-store.ts (better-sqlite3, WAL mode, PRAGMA user_version migrations)
- Zod schemas: packages/shared/src/schemas.ts (schema + inferred type export pattern, .openapi() metadata)
- Test setup: vitest.workspace.ts and existing __tests__/ directories

OUT OF SCOPE for this spec:
- HTTP routes (Spec 2)
- MCP tools for agents (Spec 2)
- Client UI (Spec 2)
- Rate limiting, circuit breakers, backpressure (Spec 3)
- External adapters — Telegram, Slack, webhooks (Spec 4)
- Pulse migration, Console migration (Spec 5)
```

## Context for Review

This is the foundation spec — everything else builds on it. The /ideate exploration agent should focus heavily on:
- How `packages/shared/` is structured (package.json exports, tsconfig, build)
- How `pulse-store.ts` uses better-sqlite3 (migration pattern, WAL mode, query patterns)
- The TypeScript interfaces in the design doc (RelayEnvelope, RelayBudget, StandardPayload, RelayAccessRule, RelayAdapter)
- The research docs in `research/mesh/` for communication patterns

The /ideate research agent should investigate:
- Maildir implementations in Node.js (atomic rename, directory conventions)
- NATS subject matching algorithm details (wildcard semantics, edge cases)
- ULID vs UUID for message IDs (ordered, sortable, collision-resistant)
- SQLite WAL mode best practices for concurrent read/write
- EventEmitter patterns for typed, namespaced events in TypeScript
