---
id: 260717-163436
title: Remove the advisory per-agent budget; enforced runaway protection is the per-message envelope budget
status: accepted
created: 2026-07-17
spec: agent-budget-enforcement
superseded-by: null
---

# 260717-163436. Remove the advisory per-agent budget; enforced runaway protection is the per-message envelope budget

## Status

Accepted

## Context

`AgentManifest.budget` shipped two fields — `maxHopsPerMessage` (default 5) and `maxCallsPerHour` (default 100) — that were persisted, surfaced in the API, and editable in the UI (`PATCH /api/mesh/agents/:id` via the Tools tab's "Limits" section), yet enforced nothing at runtime; the schema's own TSDoc admitted it. The former enforcer, `BudgetMapper`, had already been deleted as dead code. Meanwhile DOR-260 made a different, genuinely enforced budget authoritative: the per-**message** envelope budget (`RelayBudget` — `maxHops` / `callBudgetRemaining` / TTL / cycle detection), gated once at `RelayPublishPipeline.deliverAndFinalize()` before any delivery. An editable "safety limit" that throttles nothing is exactly what the AGENTS.md quality bar forbids — "be honest by design: no dark patterns" and "no dead code, no tolerated legacy patterns." Only the claude-code relay adapter exists today (codex/opencode relay adapters are unbuilt), so building real per-agent enforcement now would have been speculative work against a single-runtime reality.

## Decision

We will delete `AgentBudgetSchema`, the `AgentManifest.budget` field, and every site that read, wrote, or displayed it — the DB column (`agents.budget_json`, via a generated Drizzle migration), the eight manifest-seed sites, the registry/reconciler sync code, and all client UI surfaces (ToolsTab's editable inputs, AgentRow, the topology node/panel). This is a pure removal, not a stealth deprecation: no field is kept "for compatibility," no UI is kept as a disabled placeholder. Backward compatibility for existing `.dork/agent.json` files carrying a stale `budget` key rides an existing, zero-touch mechanism: `readManifest`'s `AgentManifestSchema.safeParse` already strips unknown keys by default (no `.passthrough()`/`.strict()`), so the key is silently dropped on read and removed from disk on the agent's next write — no migration script needed. The enforced envelope budget (`RelayBudget`, DOR-260) and the per-sender rate limiter are untouched.

## Consequences

### Positive

- Closes an honesty gap: the product no longer presents an editable control that gates nothing — removing it changes only what is _displayed and editable_, never what the system _does_, since the field never gated anything
- Deletes the whole surface area for that dishonesty in one pass: schema, DB column, 8 seed sites, 4 client UI surfaces, 3 dev showcases, 3 docs references, and the OpenAPI schema — nothing half-removed
- Backward compatibility is free: Zod's default unknown-key strip plus the file-first write-through (ADR-0043) means old `agent.json` files load fine forever and self-heal on next write, with zero migration code
- The type deletion is compiler-guided: once `AgentBudget` leaves `@dorkos/shared`, every typed `AgentManifest` literal still carrying `budget` becomes a compile error, so the ~36-file fixture sweep couldn't silently miss a site

### Negative

- Loses a documented, if fictional, floor: an operator who read the advisory fields and assumed they were real loses even the illusion of a per-agent cap until a future enforced version ships
- Rebuilding a real per-agent cap later is not free: it needs a new turn-count store (a Drizzle table, re-adding what this change drops), plumbing the target manifest onto `AdapterContext` via `buildContext`, a sliding-window gate, and an in-adapter rejection path — deliberately out of scope here (see Reintroduction path below)
- The DB migration (`ALTER TABLE agents DROP COLUMN budget_json`) is irreversible in the shipped sense: rows lose the column outright, though the derived `agents` cache (ADR-0043) makes this safe since disk `.dork/agent.json` remains the source of truth

## Reintroduction path

If a per-agent turn cap is wanted later — once Mesh is launch-critical and codex/opencode relay adapters exist — it must be rebuilt **with enforcement**, not resurrected as advisory metadata. The one non-obvious constraint, already pinned by the ideation: the "this is a paid turn" signal lives **inside the claude-code adapter, after the `STREAM_EVENT_TYPES` skip** (`packages/relay/src/adapters/claude-code/agent-handler.ts:179-204`), right before `agentManager.sendMessage` — a future cap must count turns there, **not** naively count `relay.agent.*` publishes at the relay gate (which would burn the cap on reply/stream traffic). Rebuilding then means: a new per-target-agent turn-count store (a Drizzle table + migration), plumbing the target manifest onto `AdapterContext` via `buildContext` (+ a `meshCore.getAgent`), a sliding-window gate, and an in-adapter rejection path that settles the reply-waiter (it cannot reuse the pre-delivery `rejectAtGate`).

## Related

- **DOR-260** — made the per-message envelope budget (`RelayBudget`) authoritative and enforced at `deliverAndFinalize()`. This decision's whole premise: that enforced budget is the real runaway protection, so the advisory per-agent budget was redundant dead metadata.
- **ADR-0043** — file-first agent storage (`.dork/agent.json` source of truth + derived `agents` cache). The reason dropping the `budget_json` column is safe and the reason strip-on-read plus write-through cleanly retires the on-disk key.
