# Task Breakdown: Mesh Registry Integrity & Reconciliation

**Spec:** `specs/mesh-registry-integrity/02-specification.md`
**Generated:** 2026-02-26

---

## Phase 1: Schema + Upsert (Foundation)

### 1.1 Add scan_root, behavior_json, budget_json columns to agents table
**Size:** Small | **Priority:** High | **Dependencies:** None

Add three new columns (`scan_root`, `behavior_json`, `budget_json`) to the Drizzle `agents` table schema in `packages/db/src/schema/mesh.ts`. Extend the `status` enum to include `'unreachable'`. Generate migration `0003_*.sql` with `ALTER TABLE` statements. All columns have sensible defaults so no data migration is needed.

### 1.2 Replace insert() with idempotent upsert() in AgentRegistry
**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Replace `AgentRegistry.insert()` with `upsert()` using `ON CONFLICT(id) DO UPDATE`. Handles path conflicts by removing stale entries first. Persists `scanRoot`, `behaviorJson`, `budgetJson` on insert. Updates all callers in `mesh-core.ts`. Six test cases covering all conflict scenarios.

### 1.3 Update rowToEntry() and update() to use new DB columns
**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

Update `rowToEntry()` to read `behavior`, `budget`, and `scanRoot` from DB columns instead of hardcoded defaults. Update `update()` to persist all mutable fields including the three new columns. Round-trip tests verify data integrity.

### 1.4 Add orphan management methods to AgentRegistry
**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2, 1.3

Add `markUnreachable()`, `listUnreachable()`, and `listUnreachableBefore()` methods. These support the reconciler's orphan detection and auto-removal with 24-hour grace period.

---

## Phase 2: Compensating Registration

### 2.1 Implement file-first register() with compensating cleanup in MeshCore
**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.2

Reorder `register()` to file-first: write manifest to disk, then upsert DB, then register Relay. Each step has compensating cleanup on failure (remove file if DB fails, remove DB entry if Relay fails). Add `removeManifest()` helper to `manifest.ts`.

### 2.2 Update upsertAutoImported() to sync instead of skip
**Size:** Small | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1

Remove the early-return guard in `upsertAutoImported()` that skips existing entries. Always call `upsert()` so manifest changes on disk are synced to DB. Handles moved folders (same ID, different path).

---

## Phase 3: Reconciliation

### 3.1 Create reconciler module with anti-entropy sweep
**Size:** Medium | **Priority:** High | **Dependencies:** 1.2, 1.4

New `packages/mesh/src/reconciler.ts` with `reconcile()` function. Checks each DB entry's path on disk, syncs updated manifests, marks missing paths as unreachable, auto-removes orphans past 24-hour grace period. Five test cases covering all scenarios.

### 3.2 Wire reconciliation into MeshCore and server startup
**Size:** Medium | **Priority:** High | **Dependencies:** 3.1 | **Parallel with:** 3.3

Add `reconcileOnStartup()`, `startPeriodicReconciliation(intervalMs)`, and `stopPeriodicReconciliation()` to MeshCore. Wire into `apps/server/src/index.ts` startup (run once + start 5-min timer) and shutdown (clear timer).

### 3.3 Add unreachableCount to MeshStatusResponse schema
**Size:** Small | **Priority:** Medium | **Dependencies:** 1.4 | **Parallel with:** 3.2

Add `unreachableCount` field to `MeshStatusResponseSchema` in `packages/shared/src/mesh-schemas.ts`. Populate from `registry.listUnreachable().length` in the status endpoint handler.

### 3.4 Update architecture documentation with reconciliation lifecycle
**Size:** Small | **Priority:** Low | **Dependencies:** 3.1, 3.2

Document the registration flow (file-first with compensation), reconciliation lifecycle (startup + periodic), and orphan handling (24h grace period) in `contributing/architecture.md`.

---

## Summary

| Phase | Tasks | Sizes |
|-------|-------|-------|
| P1: Foundation | 4 tasks | 1 medium, 3 small |
| P2: Compensating Registration | 2 tasks | 1 medium, 1 small |
| P3: Reconciliation | 4 tasks | 2 medium, 2 small |
| **Total** | **10 tasks** | **4 medium, 6 small** |
