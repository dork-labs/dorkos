---
id: 261015-131044
title: Keep local browser proof output out of root lint
kind: hygiene
status: proposed
actor: agent
gates: [wf.lint.lint, wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

Root lint walks `.dork/local-browser/`, the gitignored local browser proof and
evidence directory. The normal verification run on 2026-10-15 passed all 819
script tests, then reported 1,111 ESLint errors across 42 files in that directory
and no errors elsewhere. These are local drafts and generated proof output;
maintained browser proof source lives under `scripts/local-browser/`.

Add only `.dork/local-browser/**` to the existing named runtime-directory ignores.
Keep the wider `.dork/` tree eligible for lint. A regression test uses ESLint's
actual resolver to check the ignored output and three maintained/sibling controls.
Revert if the ignore reaches maintained scripts or unrelated `.dork/` source.

This is hygiene, with no metric or performance claim. `pnpm ci:status`, after
fetching `ci-steward-data`, reported the 2026-10-14 snapshot and a stale local
timing export from another clone; this change does not address that collector
health problem. Required checks, ratchets, retries and timeouts stay unchanged.

The final CI file-size check also rejected two new proof scripts over 500 lines,
a small increase in the test-control route, and a stale baseline entry for the
removed MCP showcase. Split the proof responsibilities and extract the existing
test-only request-abort helper without changing their behavior. Regenerate only
the measured lower test-control baseline and remove the gone showcase entry.
The 500-line limit and gate source stay unchanged; no baseline increase is allowed.
