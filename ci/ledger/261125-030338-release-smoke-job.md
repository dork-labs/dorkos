---
id: 261125-030338
title: The release smoke job runs the packed tarballs before npm
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Row 6 of the daily-release design (DOR-5123, §6): `release-publish.yml` gains a `smoke` job, and
`publish` now needs `[prepare, gate, smoke]`. On ubuntu and macOS it checks the packed tarballs'
sha256 again, installs `dorkos.tgz` into a clean prefix, checks `dorkos --version`, runs main's
`scripts/smoke-test.sh`, runs one Playwright spec (`apps/e2e/release-smoke/`, its own config) that
starts a chat on the test runtime and sees a reply, and imports the two library tarballs. It is
read-only, holds no secret, names no environment and has no `id-token`.

It runs only when a release is published, so no PR or queue metric moves: hygiene. It replaces a
person's eyes on the packed build, not a measured gate. Revert it if it refuses good releases
(a flaky browser step), and fix the step rather than add retries.
