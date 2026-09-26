import type { Config } from 'drizzle-kit';

import { refuseControlPlaneMigrationOnVercel } from './scripts/control-plane-deploy-guard';

// Loading this config inside a Vercel build is refused outright, so no drizzle-kit
// command can reach the shared database's control-plane tables from a deploy.
refuseControlPlaneMigrationOnVercel();

/**
 * Drizzle config for the **control-plane** half of the site schema.
 *
 * **Deploys never apply this history** (`scripts/control-plane-deploy-guard.ts`
 * says why): the DorkOS Cloud control plane owns these tables' schema. This
 * history builds the tables in local and test databases
 * (`pnpm db:migrate:control-plane`), and changes only to mirror a change the
 * control plane has already made.
 *
 * `migrations.table` is not optional here and must never be deleted — see
 * `drizzle.public.config.ts` for why a shared default journal would replay this
 * history against live data.
 *
 * This half's `0000_baseline` is the one migration that may already be true of a
 * database before it runs. `scripts/baseline-migrations.ts` records it as
 * applied, without executing it, on a database that already has these tables;
 * on a fresh database it records nothing and the baseline runs normally.
 */
export default {
  schema: './src/db/control-plane-schema.ts',
  out: './drizzle-control-plane',
  dialect: 'postgresql',
  migrations: {
    table: '__drizzle_migrations_control_plane',
    schema: 'drizzle',
  },
  dbCredentials: {
    // Prefer the unpooled (direct) connection for DDL: Neon's pooler (pgbouncer)
    // can choke on migration statements/advisory locks, so use DATABASE_URL_UNPOOLED
    // when the integration provides it and fall back to the pooled URL otherwise.
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
