# Marketplace Telemetry

The opt-in install telemetry pipeline that powers ranking and analytics for `dorkos.ai/marketplace`. This guide documents how the pipeline is provisioned, what gets stored, what does not get stored, and how to evolve the schema.

Pair this guide with:

- [`specs/marketplace-04-web-and-registry/02-specification.md`](../specs/marketplace-04-web-and-registry/02-specification.md) — the authoritative spec. The 2026-04-07 changelog entry explains why telemetry is Neon + Drizzle only (single source of truth, no Redis, no queues).
- [`contributing/marketplace-installs.md`](marketplace-installs.md) — the install pipeline that emits the events this guide stores.
- [`contributing/marketplace-registry.md`](marketplace-registry.md) — the public registry repo that the rankings are computed for.

## 1. Overview

A user installs a marketplace package. Their DorkOS client checks `telemetry.enabled` in their config; if `true` (and only if `true`), it POSTs a single anonymized event to `https://dorkos.ai/api/telemetry/install`. That endpoint is a Vercel Edge Function that validates the payload with Zod and writes one row to the `marketplace_install_events` table in Neon Postgres via Drizzle. That is the entire pipeline.

There is no Redis cache layer, no queue, no fan-out worker. The Edge Function makes one synchronous insert and returns 200. The `/marketplace` and `/marketplace/[slug]` pages read aggregate counts at hourly ISR refresh time via a single `GROUP BY` query — also through Drizzle. One ORM, one mental model, one storage tier.

The pipeline is opt-in by default. The DorkOS client never reports anything until the user explicitly flips `telemetry.enabled` to `true` in `~/.dork/config.json` or via the in-product toggle in the Dork Hub UI.

## 2. Required Vercel integration

`apps/site` runs on Vercel. Telemetry storage is provisioned through one — and only one — Vercel Marketplace integration:

```bash
vercel integration add neon       # Provisions DATABASE_URL
```

That is the entire infrastructure footprint. Nothing else needs to be installed, configured, or rotated to bring up the telemetry pipeline in a fresh environment.

## 3. Environment variables

| Variable       | Provisioned by                | Used by                                                                  |
| -------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL` | `vercel integration add neon` | `apps/site/src/db/client.ts` (Drizzle Neon HTTP driver, edge-compatible) |

That is the only secret the telemetry pipeline reads. There are no Redis URLs, no Redis tokens, no queue URLs, no API keys. If a future PR introduces a second secret for telemetry, it should be rejected — the architecture decision in the 2026-04-07 changelog is explicitly to keep this surface minimal.

## 4. Local development

`DATABASE_URL` is **not required for local development**. The marketplace pages are designed to degrade gracefully when telemetry is unreachable:

- `apps/site/src/app/(marketing)/marketplace/page.tsx` calls `fetchInstallCounts().catch(() => ({}))` so a missing or unreachable database returns an empty counts map. Packages still render — they simply rank by `featured` weight only, with zero install counts.
- `apps/site/src/app/(marketing)/marketplace/[slug]/page.tsx` does the same with `fetchInstallCount(slug).catch(() => 0)`.

This means a contributor can run `pnpm dev --filter @dorkos/site`, hit `http://localhost:3000/marketplace`, and see the full UI without ever provisioning Neon. Only the install counts column will be empty (or zero).

When you do want a real DB locally — for telemetry endpoint development or schema work — provision a free Neon project, copy its connection string into `apps/site/.env.local` as `DATABASE_URL=...`, and run the migrations (next section).

## 5. Drizzle schema and migrations

The telemetry table schema lives at `apps/site/src/db/schema.ts`. It is **not** in `packages/db` — that package is SQLite-only and serves the local DorkOS server. The marketplace telemetry table is Postgres and lives next to the only app that consumes it (`apps/site`).

The Drizzle config lives at `apps/site/drizzle.config.ts` and points at `./src/db/schema.ts`. Generated migrations land in `apps/site/drizzle/0000_*.sql` and are committed to the repo.

The `apps/site/package.json` exposes three scripts:

```bash
pnpm db:generate   # Regenerate the migration when schema.ts changes
pnpm db:migrate    # Apply pending migrations to DATABASE_URL
pnpm db:studio     # Open drizzle-studio against DATABASE_URL
```

The workflow for changing the schema is:

1. Edit `apps/site/src/db/schema.ts`.
2. Run `pnpm db:generate --filter @dorkos/site` — this writes a new SQL migration file under `apps/site/drizzle/`.
3. Review the generated SQL and commit both `schema.ts` and the migration file in the same commit.
4. Run `pnpm db:migrate --filter @dorkos/site` against your local Neon branch (or wait for the deploy hook to run it against the staging branch).

Migrations are forward-only. There is no down migration story — Postgres state is reproducible from `marketplace.json` plus the cumulative install events, both of which are append-only.

## 6. Schema reference

The complete `marketplace_install_events` table definition. This is the contract — every column listed here is allowed to exist, and every column **not** listed here is forbidden by the schema test in section 7.

```typescript
import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Append-only marketplace install telemetry events.
 *
 * Single source of truth for install counts and outcome analytics. Written to
 * by the /api/telemetry/install Edge Function (one row per opt-in install),
 * read from by the /marketplace and /marketplace/[slug] pages at hourly ISR
 * refresh time via a single GROUP BY query.
 *
 * Privacy contract: every column on this table is anonymized and aggregate-safe.
 * No IP addresses, no user agents, no hostnames, no usernames, no working
 * directories, no package contents. See section 7 of contributing/marketplace-telemetry.md.
 */
export const marketplaceInstallEvents = pgTable(
  'marketplace_install_events',
  {
    /** ULID — lexicographically sortable, unique row identifier. */
    id: text('id').primaryKey(),

    /** Package name from marketplace.json (e.g. "code-reviewer"). */
    packageName: text('package_name').notNull(),

    /** Marketplace source (e.g. "dorkos-community"). */
    marketplace: text('marketplace').notNull(),

    /** Package type from marketplace.json. */
    type: text('type', {
      enum: ['agent', 'plugin', 'skill-pack', 'adapter'],
    }).notNull(),

    /** Terminal install outcome — failures are debugging signal. */
    outcome: text('outcome', {
      enum: ['success', 'failure', 'cancelled'],
    }).notNull(),

    /** How long the install took, in milliseconds (0–600000). */
    durationMs: integer('duration_ms').notNull(),

    /** Optional error code on failure outcomes (max 64 chars). */
    errorCode: text('error_code'),

    /** Random per-install UUID generated locally. NOT a user identifier. */
    installId: text('install_id').notNull(),

    /** DorkOS version that produced the event (max 32 chars). */
    dorkosVersion: text('dorkos_version').notNull(),

    /** Server-side receipt timestamp (set by the Edge Function). */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_install_events_package_received').on(table.packageName, table.receivedAt.desc()),
    index('idx_install_events_marketplace_received').on(table.marketplace, table.receivedAt.desc()),
  ]
);

/** Inferred row type for typed reads. */
export type MarketplaceInstallEvent = typeof marketplaceInstallEvents.$inferSelect;

/** Inferred insert type for typed writes. */
export type NewMarketplaceInstallEvent = typeof marketplaceInstallEvents.$inferInsert;
```

The two indexes back the only two read patterns the marketplace page needs: "count of installs for one package, ordered by recency" and "count of installs across one marketplace, ordered by recency". Both are compound indexes with `received_at DESC` so the planner can satisfy `GROUP BY package_name` queries without re-sorting.

## 7. Privacy contract

**The schema is the contract.** Anything that is not a column on `marketplaceInstallEvents` cannot be stored, by construction. Drizzle will reject the insert at compile time, and the Zod `InstallEventSchema` in the Edge Function will reject the payload at runtime before it ever reaches the DB.

The forbidden columns — the ones that are explicitly not on the table and never will be without a public ADR overruling this section — include:

- `ipAddress` / `ip` / `xForwardedFor` — never logged. Vercel Edge runtime exposes the client IP via `req.headers.get('x-forwarded-for')`, but the Edge Function never reads that header.
- `userAgent` — never logged.
- `hostname` / `host` — never logged.
- `username` / `user` / `email` — never logged.
- `cwd` / `workingDirectory` / `path` — never logged.
- `packageContents` / `manifest` / `readme` — never logged.

These exclusions are enforced by three complementary tests, all of which are required to remain green:

1. **Schema test** — `apps/site/src/db/__tests__/schema.test.ts`. Negative assertions that walk every column on `marketplaceInstallEvents` and assert that none of the forbidden field names appear. If a future PR adds `ipAddress: text('ip_address')` to the schema, this test fails immediately.

2. **Receive-side test** — `apps/site/src/app/api/telemetry/install/__tests__/route.test.ts`. Constructs a request to `/api/telemetry/install` with PII-shaped headers (`x-forwarded-for: 1.2.3.4`, `cookie: session=abc`, `user-agent: SuperSecretAgent/1.0`) and a valid event body. After the route handler runs, the test inspects the values that were passed into `db.insert(marketplaceInstallEvents).values(...)` and asserts that none of the PII strings (`1.2.3.4`, `abc`, `SuperSecretAgent`) appear anywhere in the inserted row. If the route handler ever starts copying request headers into the row, this test fails.

3. **Client-side test** — `apps/server/src/services/marketplace/__tests__/telemetry-privacy.test.ts`. Stubs `global.fetch`, registers the dorkos.ai reporter with `consent: true`, triggers `reportInstallEvent`, and inspects the captured `fetch` body. Asserts (a) the JSON has only allow-listed keys, (b) the raw body string does not contain `os.hostname()`, `os.userInfo().username`, or `process.cwd()` — read at test time, so any future field that leaks the local environment fails immediately, and (c) the opt-out path (`consent: false`) makes zero `fetch` calls.

The three tests together form defense in depth: the client test guards the send layer, the route test guards the receive layer, the schema test guards the storage layer. Bypassing any one is a gate failure.

The full public-facing privacy guarantees are documented at [`/marketplace/privacy`](https://dorkos.ai/marketplace/privacy) on dorkos.ai. That page is the user-facing version of this section — when you change one, change the other.

## 8. Aggregation strategy

The marketplace pages need install counts. The natural Drizzle query is:

```typescript
db.select({
  packageName: marketplaceInstallEvents.packageName,
  count: sql<number>`count(*)::int`,
})
  .from(marketplaceInstallEvents)
  .where(
    and(
      eq(marketplaceInstallEvents.marketplace, 'dorkos-community'),
      eq(marketplaceInstallEvents.outcome, 'success')
    )
  )
  .groupBy(marketplaceInstallEvents.packageName);
```

This `GROUP BY` is the entire aggregation strategy in v1. The `/marketplace` and `/marketplace/[slug]` pages export `revalidate = 3600`, so the query runs **once per hour per region** during ISR refresh, not once per request. Sub-100ms even at millions of rows, indexed on `(package_name, received_at DESC)`.

The `outcome = 'success'` filter is critical: failed installs and cancelled installs are stored for debugging signal, but they never inflate the counts that drive ranking. A package that fails to install for 90% of users does not get featured in the rail.

### Future-state mitigation

If aggregation becomes a bottleneck — millions of rows per package, slow `GROUP BY` even with the index — the next step is **not** to introduce Redis. The next step is an atomic counter table written by the Edge Function via `INSERT ... ON CONFLICT DO UPDATE`:

```typescript
// Speculative — not implemented in v1.
export const marketplaceInstallCounts = pgTable('marketplace_install_counts', {
  packageName: text('package_name').primaryKey(),
  marketplace: text('marketplace').notNull(),
  successCount: integer('success_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

The Edge Function would then perform two writes per success event: one insert into `marketplace_install_events` (the audit log) and one upsert into `marketplace_install_counts` (the read-side cache). The marketplace pages would read from `marketplace_install_counts` directly. This stays within Drizzle, stays within Neon, and adds zero new infra. It is intentionally deferred until measurement justifies it.

### Long-term retention

Per-event rows are kept indefinitely in v1 because the volume is small enough not to matter. Once event volume crosses ~10M rows, the plan is to **aggregate to daily after 30 days**: a scheduled job rolls events older than 30 days into a `marketplace_install_events_daily` table (one row per package per day) and deletes the source rows. The privacy contract is unchanged — daily aggregates contain only counts, never per-event fields.

This rollup is also explicitly within Drizzle, also within Neon. The architectural commitment is "one ORM, one mental model" — every future evolution of telemetry storage stays inside that envelope, or it requires an ADR to overrule the 2026-04-07 changelog decision.

## `source_type` column (marketplace-05)

Marketplace-05 added a new `source_type` column to
`marketplace_install_events` so the marketplace team can track adoption
of each discriminated source form over time. The column is a plain
`text` field constrained to five values:

- `relative-path` — bare `./name` string resolved against the marketplace clone
- `github` — `{ source: 'github', repo }` object form
- `url` — `{ source: 'url', url }` object form (GitLab, Bitbucket, self-hosted)
- `git-subdir` — `{ source: 'git-subdir', url, path }` sparse-clone form
- `npm` — `{ source: 'npm', package }` stub (install deferred to marketplace-06)

### Privacy implications

None new. `source_type` is install-pipeline metadata, not user
metadata. It captures WHICH source form was used, not WHO used it.
The privacy contract is unchanged: no IP, no user agent, no hostname,
no username, no working directory.

### Migration

The Drizzle migration at `apps/site/drizzle/0001_add_source_type.sql`
uses the three-step nullable → backfill → NOT NULL pattern so existing
rows (all of which were necessarily `github` under spec 04's single
source type) don't block the schema change:

```sql
ALTER TABLE "marketplace_install_events" ADD COLUMN "source_type" text;
UPDATE "marketplace_install_events" SET "source_type" = 'github' WHERE "source_type" IS NULL;
ALTER TABLE "marketplace_install_events" ALTER COLUMN "source_type" SET NOT NULL;
```

### Wire format

The telemetry reporter on the server (`services/marketplace/telemetry-reporter.ts`)
derives `sourceType` from the resolved `PluginSource` discriminator and
includes it in every POST to `/api/telemetry/install`. The Edge Function
validates the field via the Zod `enum(['relative-path', 'github', 'url', 'git-subdir', 'npm'])`
schema and inserts it into the `source_type` column.
