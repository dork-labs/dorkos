---
id: 261005-194801
title: Rerun the chat capabilities census when its doc or any test title changes
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

The chat capabilities census (`packages/test-utils/src/__tests__/chat-capabilities-census.test.ts`, DOR-2723) reads `contributing/capabilities/chat.md` and the test titles under apps/client, apps/server, apps/e2e and packages. None of those are in `@dorkos/test-utils#test`'s default inputs, so an edit to any of them alone would replay a cached green. The override lists them, as `@dorkos/harness#test` and `@dorkos/server#test` do for their censuses. The test-utils suite is small, so rerunning it on any test edit costs little. Revert if its cache hit rate drops enough to matter.
