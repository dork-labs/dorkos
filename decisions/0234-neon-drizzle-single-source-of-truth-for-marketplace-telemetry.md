---
number: 234
title: Neon + Drizzle as Single Source of Truth for Marketplace Install Telemetry
status: accepted
created: 2026-04-07
spec: marketplace-04-web-and-registry
extractedFrom: marketplace-04-web-and-registry
superseded-by: null
---

# 234. Neon + Drizzle as Single Source of Truth for Marketplace Install Telemetry

## Status

Accepted (extracted from spec: marketplace-04-web-and-registry)

## Context

The original `marketplace-04-web-and-registry` specification proposed a dual-store telemetry pipeline for opt-in marketplace install events: Upstash Redis for fast install counters (`HINCRBY` on a `marketplace:installs` hash, drained hourly) and Neon Postgres for the durable event log (writes via Vercel Queues with batched flushes). The two stores satisfied two different concerns — counter latency and event durability — at the cost of two storage paradigms, two clients, two sets of secrets, and two failure modes inside a single Edge Function.

Mid-implementation, several factors made the dual path harder to justify:

1. The rest of the codebase already standardizes on Drizzle ORM. `packages/db` uses `drizzle-orm/better-sqlite3` for the local agent database. Adding Redis would introduce a stringly-typed second mental model (`marketplace:installs:${name}` keys) for an analytics use case that has no latency requirement.
2. The `/marketplace` browse page renders with `revalidate = 3600` (hourly ISR). Counts only need to be aggregated once per hour per region, so the supposed performance advantage of an in-memory counter store evaporates — a `SELECT package_name, count(*) FROM marketplace_install_events GROUP BY package_name` against indexed Postgres takes ~100ms even at millions of rows and runs at most 24 times per day per region.
3. `@vercel/kv` and `@vercel/postgres` are sunset packages. The replacements (`@upstash/redis` and `@neondatabase/serverless`) are independent vendors. Picking both means two Vercel Marketplace integrations to provision, two billing relationships, and two sets of integration auth tokens to rotate.
4. The Vercel Queues indirection (Edge Function → queue → consumer → Postgres) was added to absorb burst writes, but the expected steady-state volume (low thousands of opt-in installs per day) is well within the synchronous write capacity of the Neon HTTP driver.

## Decision

Use **Neon Postgres + Drizzle ORM as the single source of truth** for marketplace install telemetry. The `/api/telemetry/install` Edge Function writes directly to a `marketplace_install_events` table via `drizzle-orm/neon-http`. Reads happen at hourly ISR refresh time via a `GROUP BY package_name` aggregation. There is no Redis, no queue, no background drain.

Concretely:

- `apps/site` depends on `@neondatabase/serverless` (HTTP driver, edge-compatible) and `drizzle-orm`.
- `apps/site` does **not** depend on `@vercel/kv`, `@vercel/postgres`, or `@upstash/redis`. ESLint enforces this via a `no-restricted-imports` rule.
- The Edge Function performs a single `INSERT` per opted-in install event. No batching, no fan-out.
- The browse page reads counts inside its `getStaticProps`-equivalent path (server component fetch) using the same `db` instance and the same Drizzle schema.
- One Vercel Marketplace integration: `vercel integration add neon`. One secret: `DATABASE_URL`. One migration tool: `drizzle-kit`.
- The Edge Function is fail-open from the caller's perspective: a database error returns `204 No Content` so the in-product opt-in path never blocks the install on telemetry success. The error is logged via Vercel Observability for ops visibility.

If aggregation latency ever becomes a real problem (it will not, but the door stays open), the migration path is to add a sibling counter table updated via `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1`. That is a pure schema addition with no consumer changes — the browse page just reads from the counter table instead of running the `GROUP BY`.

## Consequences

### Positive

- **One ORM, one mental model.** Drizzle is already the canonical ORM in this monorepo. Anyone who has touched `packages/db` can read the marketplace telemetry code without learning a new client.
- **One Vercel integration, one secret.** `vercel integration add neon` provisions everything; rotation is one secret.
- **Simpler Edge Function.** A single `await db.insert(installEvents).values(...)` versus a two-store ladder with partial-failure semantics. Easier to test, easier to reason about, easier to recover from.
- **Type-safe queries end-to-end.** Drizzle's typed `db.select()` is harder to get wrong than raw Redis keys. Schema changes propagate as TypeScript errors, not silent runtime drift.
- **Edge-compatible.** The `@neondatabase/serverless` HTTP driver and `drizzle-orm/neon-http` both run unmodified in the Vercel Edge runtime. No Node-only adapters, no Webpack escape hatches.
- **Future-proof.** Adding new tables (ratings, version history, registry analytics, submission queues) is a `drizzle-kit generate` away. The dual-store world would have required deciding "Redis or Postgres?" for every new feature.
- **Cheaper at our scale.** One database, hourly aggregation, no per-write queue billing.

### Negative

- **Counter aggregation runs on every ISR refresh.** Acceptable at ~100ms per request and ~24 requests/day/region, but a hot-key counter store would technically be faster per-read. Mitigated by the upgrade path (counter table) if the assumption ever breaks.
- **One database, one failure domain.** A Neon outage takes both writes (telemetry ingest) and reads (browse page counts) offline. The browse page degrades gracefully because the package list itself is fetched from `marketplace.json` (independent path) — only the count badges go missing. The Edge Function returns `204` on error so the in-product opt-in still succeeds.
- **No queue means no built-in retry buffer.** A spike in opted-in installs that overwhelms Neon's connection pool will drop telemetry events. Given the steady-state volume (low thousands/day) and Neon's autoscaling, this is theoretical. If it becomes real, the fix is the counter table, not a queue.

## Alternatives Considered

- **Original dual-store (Upstash Redis + Neon via Vercel Queues).** Rejected because the latency justification disappears under hourly ISR, and the operational cost (two integrations, two clients, two failure modes) outweighs the marginal benefit at our volume.
- **Redis-only.** Rejected because Redis is not a system of record. Losing event-level granularity would foreclose future ratings/version-history analytics that need raw rows.
- **Postgres without Drizzle (raw SQL via `@neondatabase/serverless`).** Rejected because the rest of the monorepo uses Drizzle and consistency matters more than the marginal flexibility of raw SQL for an analytics path with three queries total.
- **Sticking with the sunset `@vercel/kv` / `@vercel/postgres`.** Rejected — these are end-of-life packages and their replacements (`@upstash/redis`, `@neondatabase/serverless`) are the vendor-recommended path.

## Reference

- `specs/marketplace-04-web-and-registry/02-specification.md` — Changelog entry "2026-04-07 — Drop Upstash Redis, use Neon + Drizzle as single source of truth"
- `contributing/marketplace-telemetry.md` — Operator guide for Neon provisioning, schema, migrations, and the privacy contract
- ADR-0235 — Companion decision on schema location (apps/site-local vs `packages/db`)
