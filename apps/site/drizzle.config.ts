import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Prefer the unpooled (direct) connection for DDL: Neon's pooler (pgbouncer)
    // can choke on migration statements/advisory locks, so use DATABASE_URL_UNPOOLED
    // when the integration provides it and fall back to the pooled URL otherwise.
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '',
  },
} satisfies Config;
