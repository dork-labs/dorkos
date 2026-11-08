---
id: 261108-111800
title: Native Codex job runs the default-permissions rebuild rows
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: []
ratchet-release: []
field-changes: []
---

The `codex-sandbox` job now also runs
`app-server/__tests__/default-permissions.binary.test.ts`, and its report check
requires that file to execute. The suite starts a thread and a turn with the
config DorkOS builds and no `permissions` field, the way Codex rebuilds the
config for ChatGPT workspace routing, and checks from inside the sandbox that
the protected profile still applies at Ask, Workspace write and Full.

No timeout, retry, required check or permission changes. Three rows add a few
seconds of job time. Revert the rows only together with the fix: without
`default_permissions` in the config, they turn the job red on purpose.
