---
id: 261125-095912
title: The Codex default-permissions binary test also reads four home-wide sign-in files
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4388. `~/.git-credentials`, `~/.kube/config`, `~/.pypirc` and `~/.gnupg`
join the home-wide protected list. The existing `default-permissions.binary.test.ts`
(run by the `codex-sandbox` job) plants a canary in each and reads it at every
permission level, so the real sandbox proves the deny, plus a listing of
`~/.kube` to show the file is denied exactly. Four more `cat`s in one existing
probe command: no new job, no measurable change in run time. Revert if the
probe turns flaky on a runner that lacks one of these paths' parents.
