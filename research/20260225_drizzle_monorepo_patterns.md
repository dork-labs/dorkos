---
title: "Drizzle ORM in Turborepo Monorepo — Research Report"
date: 2026-02-25
type: implementation
status: active
tags: [drizzle, turborepo, monorepo, packages-db, shared-schema]
feature_slug: db-drizzle-consolidation
---

# Drizzle ORM in Turborepo Monorepo — Research Report

**Date:** 2026-02-25
**Depth:** Deep Research (14 tool calls)
**Topic:** Drizzle ORM integration patterns for a Turborepo monorepo with better-sqlite3 — five specific questions

---

## Research Summary

Drizzle ORM has a well-established pattern for Turborepo monorepos using a `packages/db` shared package with `drizzle.config.ts` co-located inside it. The programmatic migrate API for better-sqlite3 is `migrate(db, { migrationsFolder: '...' })` imported from `drizzle-orm/better-sqlite3/migrator`. The biggest open gap is **CI detection of uncommitted migrations**: Drizzle has no native `--check` or `--dry-run` flag for this; the community workaround is running `drizzle-kit generate` and then checking `git diff --exit-code`. The esbuild bundling problem is well-solved via a copy step in the build script. Several nuances around path resolution in ESM bundles and `drizzle-kit check`'s actual exit-code behavior are flagged as uncertain below.

---

## Key Findings

### 1. packages/db Structure in Turborepo

The strongly-established community pattern places everything inside `packages/db`:

```
packages/db/
├── src/
│   ├── schema/
│   │   ├── index.ts
│   │   └── users.ts        # table definitions
│   ├── migrate.ts           # programmatic migration runner (exported)
│   └── index.ts             # barrel: re-exports schema, types, db instance
├── drizzle/                 # generated SQL migrations + _journal.json + snapshots
├── drizzle.config.ts        # drizzle-kit config — lives HERE, not at repo root
├── tsconfig.json
└── package.json
```

**`drizzle.config.ts` lives inside `packages/db/`**, not at the repo root. It references `schema: './src/schema'` and `out: './drizzle'` using relative paths from the package directory. drizzle-kit is run with `cd packages/db && drizzle-kit generate`, or via a turbo task that runs from the package directory. Multiple community projects confirm this placement (marwanhisham.dev guide, pliszko.com guide).

**Migration files live in `packages/db/drizzle/`** — this is the `out` folder from drizzle.config.ts. This directory contains:
- `*.sql` — individual migration SQL files
- `meta/_journal.json` — drizzle-kit's migration journal (critical — must ship with SQL files)
- `meta/*.snapshot.json` — schema snapshots used for diffing

**`drizzle-kit` as a dependency:** Install as a `devDependency` of `packages/db`, not the repo root. It only needs to be available when running generation/migration tasks in that package.

```json
// packages/db/package.json
{
  "name": "@dorkos/db",
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "better-sqlite3": "^9.0.0"
  },
  "dependencies": {
    "drizzle-orm": "^0.38.0"
  },
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:check": "drizzle-kit check"
  }
}
```

**IMPORTANT — `drizzle-orm` deduplication:** A known Turborepo gotcha is having multiple versions of `drizzle-orm` in the monorepo, which causes `instanceof` check failures. Install `drizzle-orm` at the repo root workspace to force deduplication, and do NOT install it separately in `apps/server` or `apps/obsidian-plugin`.

---

### 2. Package.json Exports — Two Valid Patterns

**Pattern A: JIT (Just-in-Time) — No build step required**

This is the pattern already used by `packages/shared` in DorkOS. The `exports` field points directly to `.ts` source files. Consumer apps (server, obsidian-plugin) must be configured to handle TypeScript source in workspace dependencies (Vite and esbuild both handle this well). tsserver uses the source as the type source of truth.

```json
{
  "name": "@dorkos/db",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./migrator": {
      "types": "./src/migrate.ts",
      "default": "./src/migrate.ts"
    }
  }
}
```

Consumer import:
```typescript
import { db, users } from '@dorkos/db';
import { runMigrations } from '@dorkos/db/migrator';
```

**Pattern B: Compiled — tsc build step**

```json
{
  "name": "@dorkos/db",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist/**"]
}
```

**Recommendation for DorkOS:** Use the **JIT pattern** (Pattern A) — it matches the existing `packages/shared` approach (which already exports `.ts` files directly), requires no build step for the db package, and both Vite (client) and esbuild (server bundle) resolve TypeScript source from workspace packages correctly.

---

### 3. How Apps Import from packages/db

Apps add the workspace dependency in their own `package.json`:

```json
// apps/server/package.json
{
  "dependencies": {
    "@dorkos/db": "workspace:*"
  }
}
```

Then import normally:
```typescript
import { db, users, sessions } from '@dorkos/db';
import { runMigrations } from '@dorkos/db/migrator';
```

The `migrationsFolder` path passed to `runMigrations` must be an **absolute path** resolved relative to the consuming app (see Question 3 for path resolution details).

---

## Detailed Analysis

### Question 2: Programmatic Migration API at Startup

**Confirmed import path:**
```typescript
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
```

**Confirmed function signature:**
```typescript
migrate(db: BetterSQLite3Database, config: { migrationsFolder: string }): void
```

Note: The better-sqlite3 driver's `migrate()` is **synchronous** (no `await` needed), unlike PostgreSQL drivers which are async. This is because `better-sqlite3` itself is a synchronous API.

**Complete startup example:**
```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';

const sqlite = new Database('~/.dork/relay/index.db');
const db = drizzle({ client: sqlite });

// Run pending migrations on startup — synchronous
migrate(db, { migrationsFolder: path.join(__dirname, '../drizzle') });

export { db };
```

**Internal tracking table:** Drizzle creates a table named `__drizzle_migrations` automatically in your SQLite database to track which migrations have already been applied. You cannot rename this for SQLite (the `table` option in config only applies to PostgreSQL). This table is created on first run and does not need to be manually managed.

**Option name consistency:** The option is `migrationsFolder` (camelCase) for all drivers — both `drizzle-orm/better-sqlite3/migrator` and `drizzle-orm/node-postgres/migrator` use the same option name. There is no `migrations` vs `migrationsFolder` naming discrepancy between drivers. CONFIRMED by documentation and multiple examples.

**Migration folder contents that must be present at runtime:**
- The SQL files (e.g., `0000_init.sql`, `0001_add_users.sql`)
- `meta/_journal.json` — Drizzle reads this to determine which migrations have been applied

If `meta/_journal.json` is missing, Drizzle will throw an error like `Cannot read file migrations/meta/_journal.json`. This is the most common failure mode in bundled/Docker deployments.

---

### Question 3: Bundling Migration Files with esbuild (CLI Package)

The DorkOS CLI already uses a multi-step esbuild build script (`packages/cli/scripts/build.ts`). The cleanest approach is adding a **copy step** in that build script.

**Option A: fs.cpSync copy step in build script (RECOMMENDED)**

```typescript
// packages/cli/scripts/build.ts — add after esbuild step
import { cpSync } from 'fs';
import { resolve } from 'path';

// Copy drizzle migrations folder into dist alongside the server bundle
cpSync(
  resolve(__dirname, '../../packages/db/drizzle'),
  resolve(__dirname, '../dist/drizzle'),
  { recursive: true }
);
```

Then at runtime in the server bundle:
```typescript
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

migrate(db, { migrationsFolder: join(__dirname, '../drizzle') });
```

**Option B: esbuild `--loader:.sql=text` (embeds SQL as strings)**

```typescript
// In esbuild config
{
  loader: { '.sql': 'text' }
}
```

This embeds each `.sql` file as a string export. However, Drizzle's `migrate()` function reads the migrations folder from disk at runtime — it does NOT accept pre-loaded SQL strings. Using `--loader:.sql=text` would only be useful if you wrote your own migration runner that consumed those string imports. **Not recommended** for use with Drizzle's built-in migrate function.

**Option C: esbuild `--loader:.sql=copy`**

esbuild's `copy` loader copies the file to the output directory and rewrites the import path to point to the copied file. This requires you to `import` each SQL file explicitly, which doesn't work for a dynamic migrations folder. **Not practical** for Drizzle's folder-based migration API.

**Option D: esbuild plugin (e.g., `esbuild-plugin-copy`)**

```typescript
import copy from 'esbuild-plugin-copy';

await esbuild.build({
  // ...
  plugins: [
    copy({
      assets: {
        from: ['../../packages/db/drizzle/**/*'],
        to: ['./drizzle'],
      },
    }),
  ],
});
```

This works but adds a dependency. The plain `fs.cpSync` approach (Option A) is simpler and has no additional dependencies.

**ESM path resolution in bundled apps:**

DorkOS server uses `NodeNext` modules (ESM output from tsc) and the CLI bundle uses esbuild in ESM format. In both cases, `__dirname` is not available natively. Solutions:

```typescript
// Method 1: fileURLToPath (works in Node 18+, esbuild ESM bundles)
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Method 2: import.meta.dirname (Node 20.11+ only)
const migrationsPath = join(import.meta.dirname, '../drizzle');

// Method 3: esbuild banner inject (define globally in bundle)
// esbuild config:
banner: {
  js: `
    import { fileURLToPath as __fileURLToPath } from 'url';
    import { dirname as __pathDirname } from 'path';
    const __filename = __fileURLToPath(import.meta.url);
    const __dirname = __pathDirname(__filename);
  `
}
```

**IMPORTANT CAVEAT:** When esbuild bundles to ESM format, `import.meta.url` reflects the bundle entry point's path, not each module's original path. If you resolve `__dirname` inside a module that gets bundled into `dist/server/index.js`, then `__dirname` will be `dist/server/` at runtime — which is exactly what you want, since the migrations folder will also be in `dist/`.

**UNCERTAIN:** The exact behavior when esbuild inlines multiple modules into one bundle and each calls `fileURLToPath(import.meta.url)`. All references will resolve to the single bundle file's location, which is correct as long as you use a consistent relative path from the bundle to the migrations folder.

---

### Question 4: CI/CD Migration Check

**What `drizzle-kit check` actually does:**

`drizzle-kit check` validates the **internal consistency of your migration history** — it checks that the SQL files in your migrations folder match the metadata snapshots in `meta/`. It is designed for teams with parallel branches where migration conflicts can arise. It does **NOT** detect whether your TypeScript schema has uncommitted changes that lack a corresponding migration file.

**Exit code reliability:** There is a known bug (GitHub issue #2354) where `drizzle-kit migrate` exits `0` even on failure. As of mid-2024 this was not consistently fixed. Whether `drizzle-kit check` exits non-zero correctly is **uncertain** — the documentation does not state this explicitly, and the bug report suggests the CLI tooling has exit-code reliability issues.

**There is NO `drizzle-kit generate --check` or `--dry-run` flag.** The generate command only supports `--custom`, `--name`, and `--config`. This is an **open feature request** (GitHub issue #5059, opened January 2026, still open). The proposed commands (`drizzle-kit ci`, `drizzle-kit changes`, `drizzle-kit generate --dry-run`) do not yet exist.

**The only reliable CI workaround today:**

```bash
# In CI, after checkout:
# 1. Run drizzle-kit generate (will produce no output if schema and migrations are in sync)
npx drizzle-kit generate --config packages/db/drizzle.config.ts

# 2. Check if generate produced any new files
git diff --exit-code packages/db/drizzle/
# OR
git status --porcelain packages/db/drizzle/ | grep -q . && exit 1 || exit 0
```

If `git diff --exit-code` returns non-zero, new migration files were generated, meaning the developer forgot to commit them. This causes the CI step to fail.

**Prisma equivalent:** Prisma has `prisma migrate diff` and `prisma migrate status` — these are first-class commands. Drizzle does not have an equivalent. This is a genuine capability gap.

**Where to put this check in the workflow:**

| Location | Tradeoff |
|---|---|
| **Pre-commit hook (husky/lint-staged)** | Fastest feedback; runs locally before push. Requires husky setup. Developer can bypass with `--no-verify`. |
| **CI step (GitHub Actions, etc.)** | Authoritative; cannot be bypassed. Slower feedback. Recommended as the enforcement point. |
| **Turbo task** | Can run as part of `turbo run build` dependency chain but turbo tasks are usually not the right place for git-state checks. |

**Recommended approach:** Pre-commit hook for local feedback + CI step as enforcement:

```yaml
# .github/workflows/ci.yml
- name: Check for uncommitted migrations
  run: |
    npx drizzle-kit generate --config packages/db/drizzle.config.ts
    git diff --exit-code packages/db/drizzle/ || (echo "Uncommitted migrations detected. Run drizzle-kit generate and commit the output." && exit 1)
```

---

### Question 5: Turbo Task for db:generate

**Recommended `turbo.json` task:**

```json
{
  "tasks": {
    "db:generate": {
      "inputs": [
        "src/schema/**/*.ts",
        "drizzle.config.ts"
      ],
      "outputs": [
        "drizzle/**"
      ],
      "cache": true
    },
    "db:check": {
      "cache": false
    },
    "db:migrate": {
      "cache": false
    },
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["$TURBO_DEFAULT$", "!./**/*.md"],
      "outputs": ["dist/**"]
    }
  }
}
```

**Notes on caching:**
- `db:generate` CAN be cached because its inputs (schema files) and outputs (migration files) are deterministic. If schema files haven't changed since last run, turbo will skip re-running it.
- `db:check` and `db:migrate` should have `"cache": false` because they interact with live database state or check git state.

**Should `build` depend on `db:generate`?**

This is contextual. You do NOT want `turbo run build` to auto-run `drizzle-kit generate` in CI because:
1. CI should not modify files — it should fail if migrations are missing
2. `drizzle-kit generate` is interactive by default (it prompts for migration names)

Instead, keep `db:generate` as a manual developer task:
```bash
# Developer workflow:
turbo run db:generate --filter=@dorkos/db
# Then commit the generated files
git add packages/db/drizzle/
git commit -m "feat: add migration for X"
```

**Claude Code integration:** You could add a `.claude/commands/db:generate.md` slash command that wraps `turbo run db:generate --filter=@dorkos/db` — Claude Code can then run this as part of a schema-change task. However, making it automatic (e.g., via a file watcher) is not feasible within Claude Code's tool model.

**Husky pre-commit hook (alternative):**

```bash
# .husky/pre-commit
#!/bin/sh
# Check if any schema files were staged
if git diff --cached --name-only | grep -q "packages/db/src/schema"; then
  echo "Schema files changed. Checking for migration..."
  cd packages/db && npx drizzle-kit generate
  git add packages/db/drizzle/
  echo "Migration files auto-staged. Review before committing."
fi
```

**CAVEAT:** Auto-staging migration files in a pre-commit hook is controversial. Many teams prefer to fail the commit and require the developer to run generate manually, to ensure they review the generated SQL.

---

## Sources & Evidence

- [Integrating Drizzle ORM into a Turborepo Monorepo — marwanhisham.dev](https://www.marwanhisham.dev/blog/drizzle-orm-turborepo) — packages/db structure, drizzle.config.ts in packages/db, drizzle-kit as devDep
- [Shared database schema with DrizzleORM and Turborepo — pliszko.com](https://pliszko.com/blog/post/2023-08-31-shared-database-schema-with-drizzleorm-and-turborepo) — packages/database structure, package.json scripts, turbo.json db tasks with `"cache": false`
- [drizzle-kit check — official docs](https://orm.drizzle.team/docs/drizzle-kit-check) — validates migration history consistency, useful for parallel branch teams
- [drizzle-kit generate — official docs](https://orm.drizzle.team/docs/drizzle-kit-generate) — no `--check` or `--dry-run` flag; only `--custom`, `--name`, `--config`
- [Drizzle ORM Migrations — official docs](https://orm.drizzle.team/docs/migrations) — `__drizzle_migrations` table, migrationsFolder option
- [Add Drizzle ORM to Remix with SQLite — jacobparis.com](https://www.jacobparis.com/content/remix-drizzle-sqlite) — `import { migrate } from 'drizzle-orm/better-sqlite3/migrator'`, `migrationsFolder`, `meta/_journal.json` requirement
- [drizzle-migrate doesn't exit 1 on error — GitHub issue #2354](https://github.com/drizzle-team/drizzle-orm/issues/2354) — exit code reliability bug, partially fixed in 0.21.3, reportedly persists in later versions
- [FEATURE: Add drizzle-kit command for CI schema check — GitHub issue #5059](https://github.com/drizzle-team/drizzle-orm/issues/5059) — open as of January 2026, no native solution yet
- [esbuild Content Types — official docs](https://esbuild.github.io/content-types/) — text loader embeds file as string; copy loader copies file to output; no built-in SQL loader
- [Using Drizzle as a package in Turborepo — AnswerOverflow](https://www.answeroverflow.com/m/1099272972100972674) — drizzle-orm deduplication requirement
- [TypeScript packages in Turborepo — turborepo.dev](https://turborepo.dev/docs/guides/tools/typescript) — JIT vs compiled package patterns, exports field shapes
- [Alternatives to __dirname in Node.js with ES modules — LogRocket](https://blog.logrocket.com/alternatives-dirname-node-js-es-modules/) — `fileURLToPath(import.meta.url)` pattern, `import.meta.dirname` (Node 20.11+)
- [Git diff CI workaround for uncommitted migrations — GitHub issue #5059 comments](https://github.com/drizzle-team/drizzle-orm/issues/5059) — `git diff --exit-code` as the community workaround

---

## Research Gaps & Limitations

1. **`drizzle-kit check` exit codes:** The documentation does not explicitly state whether `drizzle-kit check` exits non-zero when it finds inconsistencies. Given the known `migrate` exit-code bug, treat this as uncertain. Test it empirically before relying on it in CI.

2. **`migrationsFolder` with absolute vs relative paths:** All examples in docs use relative paths. In a bundled app where `process.cwd()` may differ from the binary location, relative paths are unreliable. Always use `path.join(__dirname, ...)` or `path.join(import.meta.dirname, ...)` for absolute path construction. Not explicitly documented by Drizzle.

3. **JIT exports with better-sqlite3 in esbuild:** The `better-sqlite3` native module requires special esbuild handling (`--external:better-sqlite3` or marking it as external). When `packages/db` is a JIT package, esbuild will follow the TypeScript source imports and encounter the `better-sqlite3` import. This is already handled in DorkOS's CLI build (better-sqlite3 is already external), but confirm that `@dorkos/db` is not accidentally bundling the native module.

4. **`drizzle-kit generate` interactivity in CI:** By default, `drizzle-kit generate` can prompt interactively when it detects a destructive schema change. In CI, use `--custom` flag or set the `breakpoints` option, or pipe input to accept defaults. Not fully researched.

5. **Obsidian plugin (Electron) and better-sqlite3:** The Obsidian plugin already uses `better-sqlite3` via the Electron compatibility layer. If `packages/db` is shared with the plugin, ensure the same native module version is used and the Electron-specific rebuild step is applied.

---

## Contradictions & Disputes

- **`drizzle-kit check` purpose:** The official docs describe it for "migration history consistency" (detecting parallel-branch conflicts). Community feature request #5059 confirms it does NOT detect schema-without-migration situations. These are different use cases that are easy to conflate.
- **`migrationsFolder` option name:** All sources agree it is `migrationsFolder` for all drivers. No naming discrepancy exists between SQLite and PostgreSQL migrators. (The `migrations.table` config in `drizzle.config.ts` is separate and only affects CLI tooling, not the runtime API.)
- **JIT vs compiled package:** The DorkOS `packages/shared` already uses JIT exports (`.ts` files directly). Consistency suggests `packages/db` should do the same. Some older Turborepo examples use compiled packages with `tsup`; this is unnecessary overhead for an internal-only package.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: `"drizzle migrate programmatic startup better-sqlite3 migrationsFolder"`, `"drizzle-kit generate CI check committed migrations"`, `"esbuild bundle static files sql migrations copy step"`, `"drizzle-kit check exit code"`, `"turborepo JIT typescript exports"`
- Primary information sources: orm.drizzle.team (official docs), GitHub drizzle-team/drizzle-orm issues/discussions, community blogs (marwanhisham.dev, pliszko.com, jacobparis.com), turborepo.dev official docs, esbuild.github.io
