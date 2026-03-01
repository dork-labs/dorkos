---
title: "Drizzle ORM SQLite Migration System — Production Validation Research"
date: 2026-02-25
type: implementation
status: active
tags: [drizzle, sqlite, migrations, production, schema]
feature_slug: db-drizzle-consolidation
---

# Drizzle ORM SQLite Migration System — Production Validation Research

**Date:** 2026-02-25
**Mode:** Deep Research
**Question:** Is Drizzle ORM's migration system production-ready for desktop/CLI apps that upgrade across versions?

---

## Research Summary

Drizzle ORM's migration system is viable for production desktop/CLI apps using SQLite, but with significant caveats. The `generate` + `migrate` workflow produces committed SQL files, tracks state via a `__drizzle_migrations` table, and supports fully programmatic startup execution — all correct behaviors for a shipped app. However, several sharp edges exist: no built-in rollback support, multi-migration batching in a single transaction (which can obscure failure boundaries), undocumented SQLite-specific transactional behavior, known bugs with table-recreation data loss (partially fixed), and no native JS/TS custom migration scripts (SQL-only custom migrations exist). For a CLI/desktop app where users upgrade across arbitrary version gaps, the `generate + migrate` path is the right choice over `push`, but you must understand its failure modes.

---

## Key Findings

1. **`drizzle-kit generate` produces committed SQL files** — safe, auditable, and correct for versioned app releases.
2. **`drizzle-kit migrate` tracks state in `__drizzle_migrations`** — a real database table that prevents double-application.
3. **Programmatic migration at startup is fully supported** — first-class API in `drizzle-orm/better-sqlite3/migrator`.
4. **Multiple pending migrations run in a single transaction** — this is a known behavior; failure atomicity is all-or-nothing across a batch.
5. **No built-in rollback** — 60+ upvote GitHub discussion confirms this is an open gap; workarounds are manual.
6. **SQLite ALTER TABLE limitations require table recreation** — Drizzle handles most cases but has known data-loss bugs in edge cases, partially fixed.
7. **Custom SQL migrations are supported** — but JS/TS migration scripts are not yet available.
8. **`push` is inappropriate for production** — it mutates the database without producing auditable files or tracking state.

---

## Detailed Analysis

### 1. How `drizzle-kit generate` Works

`drizzle-kit generate` compares your current TypeScript schema against the previous schema snapshot stored in a local `meta/` directory. It does **not** connect to the database — it diffs TypeScript against a local JSON snapshot, not against the live DB.

The output file structure (current format, post-0.17.0):

```
drizzle/
  meta/
    _journal.json          # Ordered list of applied migration names
    0000_snapshot.json     # Schema state at each migration point
    0001_snapshot.json
  0000_init.sql            # The actual SQL migration statements
  0001_add_users_table.sql
```

Older format (pre-0.17.0) used timestamped directories (`20242409125510_premium_mister_fear/`) containing `migration.sql` and `snapshot.json`. Both formats are supported by the runtime.

The `_journal.json` file is what Drizzle uses to understand the ordered sequence of migrations. The live `__drizzle_migrations` database table is what it uses to know which ones have already run.

**Custom migration generation:**

```bash
drizzle-kit generate --custom --name=seed-users
```

This generates an empty `.sql` file you fill in manually. Useful for data backfills, unsupported DDL, or seed data.

**Naming control:**

```bash
drizzle-kit generate --name=init   # Custom name suffix
```

Migrations can also be prefixed by timestamp (default) or sequence number via `drizzle.config.ts`.

### 2. How `drizzle-kit migrate` Works at Runtime

The CLI command executes a four-step process:

1. Reads all `.sql` files from the migrations folder
2. Connects to the database and queries `__drizzle_migrations` for previously applied records
3. Identifies which migration files have not yet been applied
4. Applies new migrations sequentially and records them in `__drizzle_migrations`

**Programmatic API (the important one for CLI/desktop apps):**

For `better-sqlite3` specifically:

```typescript
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';

const sqlite = new Database(process.env.DATABASE_PATH ?? '~/.dork/app.db');
const db = drizzle(sqlite);

// Synchronous — better-sqlite3 is sync
migrate(db, { migrationsFolder: './drizzle' });
```

For async drivers (e.g., Bun SQLite, libsql/Turso):

```typescript
import { migrate } from 'drizzle-orm/libsql/migrator';
await migrate(db, { migrationsFolder: './drizzle' });
```

The `migrate()` function accepts a second config argument that can also override:

```typescript
migrate(db, {
  migrationsFolder: './drizzle',
  migrationsTable: '__drizzle_migrations',  // default
});
```

**Critical deployment requirement:** The migrations folder (including `meta/_journal.json`) must be bundled with the app and present at the path you specify. If using esbuild/pkg/electron-builder, you must explicitly include the `drizzle/` directory as a static asset — it is not bundled automatically.

### 3. Migration Tracking Table

The default table name is `__drizzle_migrations`. It is created automatically on first migration run. You can customize it:

```typescript
// drizzle.config.ts
export default defineConfig({
  migrations: {
    table: 'my_migrations_table',  // customize name
    // schema: 'public',           // PostgreSQL only
  }
});
```

The table schema (SQLite) is approximately:

```sql
CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hash       TEXT NOT NULL,
  created_at NUMERIC
);
```

The `hash` column stores the migration file hash (not just filename), which prevents applying the same migration twice even if it gets renamed.

**Important distinction:** `_journal.json` in the `meta/` folder is for Drizzle Kit's schema diffing (build-time). The `__drizzle_migrations` table is for runtime tracking of which migrations have run (execution-time). These two tracking mechanisms serve different purposes and must both be present and consistent.

### 4. Programmatic Execution at App Startup

Yes — this is a first-class, documented pattern. The `migrate()` function is imported directly from the ORM package (not `drizzle-kit`) and requires no CLI tooling at runtime:

```typescript
// db.ts — called during app initialization
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.DORK_HOME ?? '~/.dork', 'app.db');
const migrationsPath = path.join(__dirname, '../drizzle');  // bundled with app

export const sqlite = new Database(dbPath);
export const db = drizzle(sqlite);

// Run synchronously before accepting any requests
migrate(db, { migrationsFolder: migrationsPath });
```

`drizzle-kit` itself (the CLI package) does **not** need to be installed in production — only `drizzle-orm` is needed at runtime. The migrator is part of `drizzle-orm`.

### 5. SQLite-Specific Limitations (ALTER TABLE Constraints)

SQLite has severely limited `ALTER TABLE` support compared to PostgreSQL or MySQL. It supports:
- `ADD COLUMN`
- `RENAME TABLE`
- `RENAME COLUMN` (SQLite 3.25.0+)

It does **not** support:
- `DROP COLUMN` (in older versions)
- `MODIFY COLUMN` (change type, constraints)
- `ADD CONSTRAINT` / `DROP CONSTRAINT`
- `DROP NOT NULL`

For unsupported operations, Drizzle uses a **table recreation pattern**:
1. Create a new table with the desired schema
2. `INSERT INTO new_table SELECT ... FROM old_table`
3. Drop the old table
4. Rename the new table

Drizzle generates this automatically for many cases, but **does not generate automatic migrations for some operations** (e.g., dropping NOT NULL from a column). In these cases, it shows a prompt/suggestion during `generate`, and you must write the migration manually using `--custom`.

**Known bug (Issue #4938 — partially fixed in beta):** When table recreation involves foreign key relationships with cascade deletes, Drizzle's generated migration could silently wipe child table data. The fix adds `PRAGMA foreign_keys=OFF;` before table recreation, but this only works for local SQLite, not Cloudflare D1. If your SQLite has meaningful FK relationships, audit generated migrations carefully before applying them.

**Known bug (Issue #5360):** When adding a `.unique()` column to an existing table requiring a rebuild, the generated `INSERT INTO ... SELECT` can treat the new column name as a string literal instead of a column reference, causing `UNIQUE constraint failed`. As of early 2026, this is an open issue.

### 6. Custom Migration Logic (Data Transformations)

**SQL-only custom migrations are fully supported:**

```bash
drizzle-kit generate --custom --name=backfill-user-slugs
```

This creates a blank `.sql` file you populate:

```sql
-- Custom migration: backfill user slugs from display names
UPDATE users SET slug = lower(replace(name, ' ', '-'))
WHERE slug IS NULL;
```

Custom SQL migrations are integrated into the standard migration sequence — they run in order alongside generated migrations via `drizzle-kit migrate` or the programmatic `migrate()` function.

**JS/TS custom migration scripts are not yet supported.** This is a documented roadmap item. If you need to run TypeScript logic as part of a migration (e.g., calling an external API, or running complex transformations not expressible in SQL), you currently must:
- Do the data transformation in SQL
- Or run a separate startup script before/after calling `migrate()`
- Or use the community package `drizzle-migrations` which adds JS migration support

### 7. Transaction Behavior and Failure Handling

**Critical finding:** Multiple pending migrations are applied in a **single transaction**. This means:

- If you deploy with 3 pending migrations and migration 2 fails, all 3 are rolled back
- No partial application — good for atomicity
- But: this can cause issues if migration 1 commits something migration 2 depends on (the PostgreSQL enum bug from Issue #3249 illustrates this — less of an issue for SQLite but the batching behavior is the same)

**Per-database behavior:**
- `better-sqlite3`: Synchronous; the transaction behavior follows SQLite's default. All pending migrations are executed together.
- Expo SQLite driver: Each migration is individually wrapped in a transaction.

**Rollback (intentional, down-migration): Not supported.** This is the largest gap. Discussion #1339 has 60+ upvotes and 223 people watching. The Drizzle team acknowledged this and there is a PR (#4439) in progress as of early 2025, but it was not shipped as of February 2026.

Current workarounds used by the community:
- Maintain separate `.down.sql` files manually
- Use external tools like `golang-migrate` alongside Drizzle schema generation
- Take a SQLite database backup before applying migrations (appropriate for CLI/desktop apps)

**Failure recovery in practice for a CLI/desktop app:** Since you control the deployment (unlike a web server with concurrent users), the most pragmatic strategy is:
1. `sqlite3 backup` (using `better-sqlite3`'s `.backup()` API) before running migrations
2. Run `migrate()`
3. If it throws, restore from backup

### 8. Committing Migration Files to Git

**Yes — this is the intended workflow.** The entire `drizzle/` directory (SQL files + `meta/` folder including `_journal.json` and all snapshots) should be committed to git. These are the source of truth for:
- Code review of schema changes
- Reproducible migration sequences across environments
- The `meta/` snapshots enable Drizzle Kit to correctly compute diffs for future `generate` runs

You should never modify generated migration files after they have been applied to any database (dev or prod), as the hash-based tracking will break.

**For bundled apps (CLI/Electron/pkg):** The `drizzle/` folder must be explicitly included in your bundle/package as static assets. The `migrate()` function needs to read these files from disk at runtime. Common approaches:
- Use `path.join(__dirname, '../drizzle')` and configure your bundler to copy the folder
- In the DorkOS CLI esbuild pipeline, add the migrations folder as a `loader: { '.sql': 'file' }` or copy via build script

### 9. `drizzle-kit push` vs `drizzle-kit migrate` — Which for Production?

| Aspect | `push` | `migrate` |
|---|---|---|
| Generates SQL files | No | Yes (via `generate`) |
| Version-controlled | No | Yes |
| Tracks applied state | No | Yes (`__drizzle_migrations`) |
| Works offline/programmatically | No (needs schema introspection) | Yes |
| Safe for existing data | Risky | Designed for it |
| Supports arbitrary version gaps | No | Yes |
| Appropriate for production | **No** | **Yes** |
| Appropriate for dev prototyping | Yes | Acceptable but slower |

**`push` is explicitly not recommended for production.** The official docs state it is "best for rapid prototyping" and that "running push directly on a production database is risky." It has no concept of "which changes have been applied" — it computes the current diff every time and applies it directly. If a user has v1.0 and upgrades to v3.0, `push` could produce unpredictable behavior with data loss.

For a CLI/desktop app where users upgrade across versions (v1 → v2 → v5, or v1 → v5 directly), **`migrate` is the only correct choice.** The migration sequence is deterministic, the files are committed and shipped with the app, and the `__drizzle_migrations` table ensures each migration runs exactly once regardless of the upgrade path.

### 10. Known Issues with Drizzle Migrations for SQLite

A curated list of confirmed issues:

| Issue | Severity | Status |
|---|---|---|
| No rollback/down-migrations | High | Open (PR #4439 in progress) |
| Table recreation silent data loss with FK cascades (Issue #4938) | Critical | Partially fixed (beta); breaks on Cloudflare D1 |
| Unique column add during table rebuild uses column name as string literal (Issue #5360) | Medium | Open as of early 2026 |
| Multiple migrations run in single transaction — enum-style ordering dependency (Issue #3249) | Medium | Not fixed; design choice |
| Expo SQLite driver crashes with >1 migration (Issue #2384) | Medium | Status unclear; not relevant for Node.js |
| JS/TS custom migration scripts not supported | Medium | On roadmap |
| `_journal.json` missing breaks deployment | Medium | User error; must bundle static assets |

---

## Push vs. Migrate Decision for DorkOS PulseStore / RelayStore

The existing PulseStore uses `better-sqlite3` with `PRAGMA user_version` for manual migration tracking. If migrating to Drizzle:

- Use `drizzle-kit generate + migrate` workflow
- Ship the `drizzle/` folder inside the CLI bundle (copy step in `packages/cli/scripts/build.ts`)
- Call `migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') })` at the top of each store's initialization, before any queries
- Take a `.backup()` snapshot before running migrations for safety
- Do not use `drizzle-kit push` at any point in the production path

---

## Research Gaps & Limitations

- The exact `__drizzle_migrations` table DDL for SQLite was not found in official documentation — it was inferred from behavior descriptions and community reports. Inspect the actual table after first migration run to verify schema.
- Transactional behavior for `better-sqlite3` specifically (whether each migration gets its own transaction vs. all-at-once) was confirmed as "all at once" from the PostgreSQL discussion but not independently verified for the SQLite driver via source code inspection.
- The status of PR #4439 (rollback support) is unclear — it was referenced in early 2025 discussions and may have shipped or stalled by February 2026.
- No authoritative benchmark data on migration performance for large SQLite files with table-recreation operations.

---

## Sources & Evidence

- [Drizzle ORM - Migrations](https://orm.drizzle.team/docs/migrations) — Official migrations overview
- [Drizzle ORM - `drizzle-kit migrate` command](https://orm.drizzle.team/docs/drizzle-kit-migrate) — CLI command docs; confirms `__drizzle_migrations` default table name
- [Drizzle ORM - `drizzle-kit generate` command](https://orm.drizzle.team/docs/drizzle-kit-generate) — File structure, `--custom` flag, naming conventions
- [Drizzle ORM - Custom Migrations](https://orm.drizzle.team/docs/kit-custom-migrations) — SQL-only custom migrations; JS/TS not yet supported
- [Drizzle ORM - Kit Overview](https://orm.drizzle.team/docs/kit-overview) — push vs. migrate comparison
- [Drizzle ORM - `drizzle-kit push`](https://orm.drizzle.team/docs/drizzle-kit-push) — push command docs
- [Migrations Rollback Discussion #1339](https://github.com/drizzle-team/drizzle-orm/discussions/1339) — 223 upvotes; rollback confirmed as not implemented; community workarounds
- [Multiple Migrations in Single Transaction Discussion #898](https://github.com/drizzle-team/drizzle-orm/discussions/898) — Confirms all pending migrations run in one transaction
- [Multiple Migration Transaction Bug Issue #3249](https://github.com/drizzle-team/drizzle-orm/issues/3249) — Single-transaction batching causes enum ordering issues in PostgreSQL
- [SQLite Table Recreation Data Loss Bug Issue #4938](https://github.com/drizzle-team/drizzle-orm/issues/4938) — FK cascade data loss during table recreation; partially fixed
- [SQLite Unique Column Rebuild Bug Issue #5360](https://github.com/drizzle-team/drizzle-orm/issues/5360) — Column name treated as string literal during table rebuild
- [Apply Migrations from Code Discussion #4344](https://github.com/drizzle-team/drizzle-orm/discussions/4344) — Programmatic migration without CLI
- [Add Drizzle ORM to Remix with SQLite and Fly.io - Jacob Paris](https://www.jacobparis.com/content/remix-drizzle-sqlite) — Production deployment pattern; Docker bundling requirement
- [How does Drizzle handle migrations - DEV Community](https://dev.to/websilvercraft/how-does-drizzle-handle-migrations-part-1-ddg) — Internal snapshot vs. DB tracking distinction
- [Migration System | DeepWiki](https://deepwiki.com/drizzle-team/drizzle-orm/3.2-cli-commands-and-interface) — Internal migration system architecture
- [Migrations with Drizzle: push to SQLite is here - Medium](https://andriisherman.medium.com/migrations-with-drizzle-just-got-better-push-to-sqlite-is-here-c6c045c5d0fb) — Push vs. migrate for SQLite specifically
- [Building Offline-First Expo App with Drizzle and SQLite - Medium](https://medium.com/@detl/building-an-offline-first-production-ready-expo-app-with-drizzle-orm-and-sqlite-f156968547a2) — Mobile production patterns

---

## Search Methodology

- Searches performed: 10
- Most productive terms: `drizzle orm sqlite migrations production`, `drizzle-kit migrate programmatic runtime`, `drizzle __drizzle_migrations table tracking`, `drizzle migrate transaction failure rollback`, `drizzle sqlite ALTER TABLE mirror table`, `drizzle-kit generate journal.json snapshot meta`
- Primary sources: orm.drizzle.team official docs, github.com/drizzle-team/drizzle-orm issues and discussions, dev.to, jacobparis.com
- Research depth: Deep
