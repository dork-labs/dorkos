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

Security revision after be2f5b67e2 supersedes the small-row fail-fast driver
and its budget. Run every diagnostic row, retaining each failure's argv/log/
JSON; stopping means no further lane workaround, not stopping CI collection.
Move kill-midturn immediately after the two agent-home rows, then test an
owned .claude symlink with missing settings.json in acceptEdits. That row
requires either a specific crosses-writable-symlink refusal (logging what
the person sees), or actual swap/write attempts with all targets still absent.
Only its intentionally created .claude symlink is exempt from the host-type
check; stray files elsewhere still fail. Log person-symlink Full's launch
outcome and refusal events explicitly, even when that row remains red.

Canonicalization is now limited to captured bases (person/data/cwd/write/
agent-folder/agent-home/account), preserving path components inside each
base. Links below a base stay in logical refusal keys so Codex can reject
writable symlink crossings. Aliases at or above a captured base may resolve.
Globs stay unchanged; no mkdir, scan change or weakened rg error is added.
Unit tests cover an internal writable link and an alias above a base with
an internal link, as well as strongest access and ordinary base aliases.

Small traced step: 10 to 15 minutes. Untraced measurement step: 64 to 50.
Native 20 plus small 15 plus main comparison 15 plus untraced 50 total 100
of the 110-minute job. The trace driver has 870 seconds inside its 900-second
step, reserving a share for every remaining row, each capped at 190 seconds.
A timed-out or unattempted row stays unproven, never green. Thirteen rows now
include the new internal-link case. Keep no-retry behavior and owned process
group cleanup. Restore job to 20 and remove/review every diagnostic script,
scenario, test narrowing and step cap before final label; this includes the
new agent-symlink-10k case and revised 15/50-minute caps.

The PM decided to ship the unbounded scan. The Linux-only changelog now
separates unreadable-folder startup refusal from a disappearing-folder command
failure and advises retry for the latter. DOR-3812 remains outside this round.
