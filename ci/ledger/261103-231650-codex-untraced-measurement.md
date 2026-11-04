---
id: 261103-231650
title: Preserve failed Codex argv and measure untraced sandbox costs
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: [3480]
ratchet-release: []
field-changes:
  - gate: wf.test.codex-sandbox
    field: timeout-minutes
    from: 20
    to: 110
---

Security requested diagnostics after run 41732737007: traced default-mode
thread starts took 49059ms and 20752ms at 10000 home files, and the AGENTS.md
filesystem helper failed creating /.git. The trace was not uploaded.

Upload argv traces even on failure. In a separate step without strace, run
the unchanged protection assertions at 10000 and 500000 home files and at
10000 home files plus 500000 cwd files (90 percent inside node_modules).
Each mode gets its own invocation, so a default failure cannot hide Full.
Record fixture setup separately, thread start, three trivial shell-call round
trips and their public controls. These times include local provider/transport
overhead; they are not kernel-only sandbox timings. Record failures too.

The diagnostic job budget grows from 20 to 90 minutes: nine sequential child
runs are capped at seven minutes each, leaving 27 minutes for traced proof,
setup and uploads. Native tests retain 180-second limits and production RPCs
retain 60-second limits. This budget change is explicitly proposed for Security
review, not a startup fix. No retries, coverage, sandbox, triggers, secrets or
permissions change. The existing required gate remains red on native failure.

This is evidence collection, not a performance claim, so no unmeasured baseline
or improvement target is invented. Remove the large diagnostic step and restore
the 20-minute job budget once Security has the numbers and chooses the next
strategy. Keep the trace upload for future native failures.

Security's final-label gate: before any label at the final head, restore the
job budget to 20 minutes and review the 20/64-minute step caps again; remove
run-codex-untraced.mjs, its test and its CI step; remove all
DORKOS_CODEX_PROBE_* handling, including the selectedMode continue. The normal
receipt cannot detect that environment-based narrowing of its mode loop.
The 90 minutes is approved for diagnostics only, not for the final label.

Never add -v to strace: environment values must stay out of the public trace
artifact. Test diagnostics emit fixtureMs, startMs and each returned shell
time immediately, before later native failures or test timeouts can hide them.

Security revision after 99dd7c6ac0 authorizes a 110-minute diagnostic job:
native proof 20, small traces 10, main comparison separately 15, untraced 64.
The caps total 109 minutes; setup/upload overhead can still cancel incomplete
evidence. Upload small traces before the separate comparison. Every other
step cap remains unchanged. Main comparison output has its own single-path
upload outside the witness directory. Restore the job to 20 before any final
label, remove the diagnostic comparison/rg/narrowing machinery and review
all step caps. This is evidence collection only, never a startup remedy.
