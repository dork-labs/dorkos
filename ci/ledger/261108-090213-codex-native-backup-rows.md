---
id: 261108-090213
title: Native Codex rows carry Claude Code sign-in backups (DOR-3949)
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: []
ratchet-release: []
field-changes: []
---

The native fixture now plants a `.claude.json.backup.*` in every protected
`backups` folder, so every row in the `codex-sandbox` job runs on the file that
stopped Codex from starting on Linux (DOR-3949). Four new rows in
`app-server.binary.test.ts` check, from inside the sandbox, that the backups
stay unreadable, the hidden folders list empty, an unprotected project backup
stays masked, and a linked backups folder's target is never read.

No workflow, timeout, retry, required check or permission changes. Nothing
measurable should move except a few seconds of job time. Revert the rows only
together with the fix: without the fix, they turn the job red on purpose.
