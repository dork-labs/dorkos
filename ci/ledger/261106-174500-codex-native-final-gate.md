---
id: 261106-174500
title: Keep started mask controls at every level and remove Codex diagnostics
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: [3480]
ratchet-release: []
field-changes:
  - gate: wf.test.codex-sandbox
    field: timeout-minutes
    from: 110
    to: 20
---

Security's final review at 9f0d529138 found that every diagnostic writable row
refused before start. Preserve complete-home positive controls at Edit and Full,
with both existing and fresh projects. The regular app-server and exec controls
also use complete synthetic homes and require an actual protected shell turn at
each level. A suite guard rejects zero started protection rows at any level.
Canaries, byte snapshots and the parent-kind host invariant stay required; the
parent-kind check is not a full host-tree digest.

Remove the temporary strace, missing-parent, main-comparison and large untraced
measurement drivers, their steps and driver-only tests/fixtures. Remove every
environment-selected scenario, root and mode override. Run the native suites
once without tracing, preserve their JSON receipt and reject skipped/missing
suites. Restore the 20-minute job ceiling as required by the earlier diagnostic
ledger and Security. No product code, mask, pre-create, retries, required check
or permissions change. Historical diagnostic artifacts remain on their runs.

This is completion of temporary evidence collection, not a performance claim.
Previous run 42239938316 native job took 31m32s including all diagnostics; its
initial controls passed. Keep the reduced gate red if any native assertion or
started-mode guard fails. No extra timeout or retry is authorized here.
