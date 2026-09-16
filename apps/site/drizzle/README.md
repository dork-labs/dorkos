# `apps/site/drizzle/` — the frozen pre-split history

**Nothing appends to this folder any more.** No drizzle config points at it, and
`pnpm db:generate:*` cannot write here.

Until the schema split, `apps/site` had one Drizzle schema, one config, and this
one migration history covering every table the site owns. The schema is now in
two halves over the same Neon database, each with its own folder, its own config
and its own journal table:

| Half          | Barrel                           | Config                            | Folder                   | Journal table                                |
| ------------- | -------------------------------- | --------------------------------- | ------------------------ | -------------------------------------------- |
| public        | `src/db/public-schema.ts`        | `drizzle.public.config.ts`        | `drizzle-public/`        | `drizzle.__drizzle_migrations_public`        |
| control plane | `src/db/control-plane-schema.ts` | `drizzle.control-plane.config.ts` | `drizzle-control-plane/` | `drizzle.__drizzle_migrations_control_plane` |

These 17 migrations stay because they are the record of how the live database was
actually built, and because the live database's `drizzle.__drizzle_migrations`
table still holds their 17 rows. Deleting them would not remove those rows; it
would only remove the ability to reproduce the database they describe.

They also still do real work in the test suite. `src/db/__tests__/` replays this
folder to reconstruct pre-migration states, and
`src/db/__tests__/migration-histories.test.ts` seeds a database from it to prove
the two new histories adopt a database they did not create — which is exactly
the production case.

To add a migration, edit the relevant half's barrel and run
`pnpm --filter @dorkos/site db:generate:public` or `db:generate:control-plane`.
