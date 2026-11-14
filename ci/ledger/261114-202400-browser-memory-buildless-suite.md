---
id: 261114-202400
title: Keep the browser memory unit suite independent of workspace builds
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, wf.test.test-shard]
prs: [3737]
ratchet-release: []
field-changes: []
---

At 5113df04a2, the repo-wide suite step fails before workspace builds: the
memory test imports the production observation module, whose error helpers
need an unbuilt shared export. A local probe refusing workspace imports
reproduces the same cloud-origin import chain.

Move only the fixture-to-production budget comparison to the existing server
observation tests. Keep the fixture validation and unarmed entry-point tests in
the repo-wide suite. Add the fixture to the server test task's cache inputs so
changing that outside-package file invalidates the relocated assertion.

No test is skipped, no gate changes, and no browser runs. Revert the input only
if the server suite stops importing this fixture. The buildless suite must
continue to run before workspace builds without importing production services.
