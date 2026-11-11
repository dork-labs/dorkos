---
id: 261111-193636
title: Remove an unused helper from the former Codex fixture setup
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: []
ratchet-release: []
field-changes: []
---

Refs DOR-4187. Delete `scripts/codex-root-home-fixture.mjs`, an unreferenced
helper for the former privileged strace fixture. It defines `prepareRootHome`
but does not call it or start a process when loaded. Searches across tracked
source, tests, scripts, harness files and workflows find no reader or caller.
Both full and production Knip classify it as an unused file.

The current `wf.test.codex-sandbox` job uses distro bubblewrap and a scoped
AppArmor profile. Its existing receipt test rejects strace and requires both
protected probes to pass. That job, its receipt checks and every protected
binary test stay unchanged. No workflow, required context, retry, timeout or
execution arm changes.

This is hygiene, with no runtime or flake-rate improvement claimed: the helper
is not on an executing path. CI status for 2026-11-10 still names wasted queue
builds as the constraint (14.29%); removing an unused file does not address it.
The direct measure is one unused file removed, with no new Knip findings and
no unresolved imports. Raw before/after evidence accompanies the PR handoff.

QA checks the hosted-job receipt guard, and Security gives a light read before
merge. Revert the deletion if either review identifies a live reader outside
the scanned tree. The workflow freeze remains in force; this change edits no
workflow file.
