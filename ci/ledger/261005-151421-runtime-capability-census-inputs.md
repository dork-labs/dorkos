---
id: 261005-151421
title: Rerun the runtime capabilities census when its generated doc changes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The runtime capabilities census (`apps/server/src/services/runtimes/__tests__/runtime-capability-census.test.ts`, DOR-2720) compares the committed `contributing/runtime-capabilities.md` to the registry and reads titles with `scripts/lib/code-only.mjs`. Neither file is in `@dorkos/server#test`'s default inputs, so an edit to either alone would replay a cached green. The override adds exactly those two, the same fix `@dorkos/harness#test` carries for its census. Revert if the server test cache hit rate drops noticeably (the two files change rarely, so it should not).
