import type { Config } from 'drizzle-kit';

/**
 * Drizzle config for the **control-plane** half of the site schema.
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
