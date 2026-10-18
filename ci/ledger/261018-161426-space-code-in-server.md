---
id: 261018-161426
title: The space server's code runs in the server package; caches see both halves
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.community-pg, wf.test.community-packaged]
prs: []
ratchet-release: []
field-changes: []
---

Server-merge step 7d (DOR-3008) moves the space server's code, as pure
renames, from `apps/community/src/` to `apps/server/src/services/spaces/`. Its
package, Dockerfile, migrations, web page, browser tests, load harness and
scripts stay in `apps/community` until the web page joins `apps/client` and
the image builds from the server package.

What the pipeline sees:

- The unit tests run in the `server` vitest project, so the shards pick them
  up from `apps/server`. An affected-only run picks packages by the files a
  change touched and ignores task inputs, so it no longer crosses between the
  halves: a change to `apps/community` alone skips the server's space tests,
  and a change to the space code alone skips `apps/community`'s typecheck and
  web page tests. The always-running `community-pg` job therefore checks both
  halves on every pull request (`Check both halves of the space server`),
  building `@dorkos/decisions` and `@dorkos/icons` for it. The Postgres and S3 suites still run
  from `apps/community`'s configs (`dir: ../server/src/services/spaces`), so
  `community-pg` runs the same command as before.
- `ci/space-server.env` now names `SPACE_SRC_DIR=apps/server/src/services/spaces`;
  `SPACE_DIR` stays `apps/community`. The packaged-scope rule keys on both, and
  the rest of `apps/server` stays out of it.
- Each half now reads the other's files, so their turbo cache keys must too:
  `@dorkos/server#test` and `#typecheck` take the `apps/community` files the
  space tests read, and `@dorkos/community#build`, `#typecheck` and `#test`
  take `apps/server/src/services/spaces/**`. Without that, a cached run could
  report green on code it never saw.
- The vocabulary gate scans the web page (`SPACE_WEB_DIR`) as its own root,
  since `apps/server/src` now covers only the code.

Hygiene, not an experiment: the `community-pg` job gains a few minutes and no
catch rate should move. Revert the cache inputs and the extra step only
together with the move, once the image builds from the server package and one
package holds both halves.
