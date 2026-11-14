---
id: 261114-220900
title: Register the chat memory proof's unit suite for repo-wide checks
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, wf.scripts-test.harness]
prs: [3737]
ratchet-release: []
field-changes: []
---

The suite-list guard fails at `6101747897` because the new chat memory suite
is unclassified. It imports the production observation limit outside scripts,
so register it in REPO_WIDE_SUITES. Its unarmed entry-point test refuses before
loading a browser; the suite does not run the Docker or real-Chrome proof.

This restores the existing classification contract and adds coverage to the
repo-wide checks. No gate, retry, timeout or required status changes. Revert the
registration only if the suite is removed or no longer depends on repository
state outside the scripts harness.
