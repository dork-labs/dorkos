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

- The unit tests run in the `server` vitest project, so affected runs and the
  shards pick them up from `apps/server`. The Postgres and S3 suites still run
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

Hygiene, not an experiment: no gate timing or catch rate should move. Revert
the cache inputs only together with the move. Revisit if `test-shard` on a
pull request that touches only `apps/community/src/browser` stops running the
space server's unit tests, or the reverse.
