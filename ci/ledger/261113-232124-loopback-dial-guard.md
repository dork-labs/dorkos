---
id: 261113-232124
title: A repo-wide guard keeps hard-coded loopback dials out of the server and the Mac app (DOR-4294)
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
prs: [3719]
ratchet-release: []
field-changes: []
---

One new suite, `scripts/__tests__/loopback-dial-boundary.test.ts`, is added to
`REPO_WIDE_SUITES`, so `typecheck` parses `apps/server/src` and
`apps/desktop/src` and fails on a hard-coded `127.0.0.1` / `localhost` /
`[::1]` dial outside a listed, counted exception. The Mac app's event stream
dialled `127.0.0.1` while its server bound `::1`, and nothing caught it.

No workflow, timeout, retry, required check or permission changes. Nothing
measurable should move except a few seconds of job time.
