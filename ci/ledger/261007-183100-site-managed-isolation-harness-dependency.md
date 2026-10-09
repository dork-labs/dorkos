---
id: 261007-183100
title: Build the harness before the site managed isolation test
kind: hygiene
status: active
actor: agent
gates: []
prs: [2673]
ratchet-release: []
field-changes: []
---

The site managed isolation test imports the original server protocol driver, whose native Room graph imports `@dorkos/harness/scan`. That package exports built JavaScript. In PR 2673 run 37654109916, shard 2 ran `@dorkos/site#test` before `@dorkos/harness#build` and failed with `ERR_MODULE_NOT_FOUND` for that public subpath. Add the harness build to the site's existing explicit build dependencies; its own dependency builds retain their normal ordering. No test, required check, retry, worker, timeout or package export changes. Revert if this dependency does not correspond to the original server-source import or introduces a task cycle.
