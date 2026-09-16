/**
 * The runtime Drizzle schema for the apps/site Neon Postgres database — the
 * union of both halves of the split.
 *
 * **This file is not what drizzle-kit reads any more.** The schema is split in
 * two, and each half has its own drizzle config, its own migration folder and
 * its own journal table:
 *
 * | Half          | Barrel                    | Config                          | Folder                   | Journal table                         |
 * | ------------- | ------------------------- | ------------------------------- | ------------------------ | ------------------------------------- |
 * | public        | `public-schema.ts`        | `drizzle.public.config.ts`        | `drizzle-public/`        | `drizzle.__drizzle_migrations_public` |
 * | control plane | `control-plane-schema.ts` | `drizzle.control-plane.config.ts` | `drizzle-control-plane/` | `drizzle.__drizzle_migrations_control_plane` |
 *
 * A new table goes in one of those two barrels, never here. This file exists
 * only so the one database client (`client.ts`, `transaction-client.ts`) still
 * sees one schema namespace — there is one Neon database, and a caller writing
 * `db.select().from(schema.marketplaceInstallEvents)` should not have to know
 * which half owns the table.
 *
 * The two halves are disjoint and there are no foreign keys across them;
 * `__tests__/migration-histories.test.ts` asserts both properties against a real
 * database, and that the union of the two migration folders reproduces exactly
 * the table set the frozen `drizzle/` history built.
 *
 * @module db/schema
 */
export * from './control-plane-schema';
export * from './public-schema';
