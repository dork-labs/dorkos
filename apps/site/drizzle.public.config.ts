import type { Config } from 'drizzle-kit';

/**
 * Drizzle config for the **public** half of the site schema.
 *
 * `migrations.table` is not optional here and must never be deleted. Drizzle's
 * default journal is `drizzle.__drizzle_migrations`, so two configs over one
 * database with no explicit table would share one journal: whichever ran second
 * would find the other's rows, conclude its own migrations were already applied
 * (or, worse, replay them), and the frozen `drizzle/` history's own rows are
 * already sitting in that default table on the live database. Each half gets its
 * own journal table, and the two never see each other's rows.
 */
export default {
  schema: './src/db/public-schema.ts',
  out: './drizzle-public',
  dialect: 'postgresql',
  migrations: {
    table: '__drizzle_migrations_public',
    schema: 'drizzle',
  },
  dbCredentials: {
    // Prefer the unpooled (direct) connection for DDL: Neon's pooler (pgbouncer)
    // can choke on migration statements/advisory locks, so use DATABASE_URL_UNPOOLED
    // when the integration provides it and fall back to the pooled URL otherwise.
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
