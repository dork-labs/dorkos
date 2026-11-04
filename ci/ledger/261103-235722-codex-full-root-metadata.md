---
id: 261103-235722
title: Trace the acceptEdits filesystem helper with its complete profile
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: [3480]
ratchet-release: []
field-changes: []
---

Security's round-three ruling retains the unbounded globs and the diagnostic
90-minute job while the Full root-metadata render is tested. There is no
depth cap, scanner, production timeout or missing-path-deny change.

Add one always-run traced app-server/acceptEdits row at 10000 home files,
with the agent home itself as writable cwd and .claude initially absent,
before the trace upload. strace -s 1048576 retains the complete serialized
permission profile for this bounded fixture; no -v, so environment values
remain abbreviated. Its JSON report joins the argv artifact on failure.
The original traced suite and its report remain intact. The inventory guard
still requires every native file, allowing the diagnostic to repeat one.

This diagnostic adds a four-minute step cap. Combined with 20 and 64, the
step ceilings total 88 of the existing 90 minutes; setup/upload overhead can
still cause whole-job cancellation. The complete acceptEdits trace uploads
before the long untraced diagnostic, preserving it if a later step is cut.
Incomplete or cancelled measurements remain unproven, never a green result.

No new gate, trigger, permission, secret or retry. This records evidence
collection, not an invented improvement metric. Remove this environment-armed
trace row before the final label along with the other DORKOS_CODEX_PROBE_*
diagnostics, and restore/review the existing ledger's final-label deadlines.

Security subsequently authorized the missing-parent candidate for this run.
Before launch, derive parents from rendered literal rules in captured own
homes only; discovered Claude account homes are not preparation targets.
Walk with lstat and non-recursive mkdir; leave files, links and
failures alone without changing any rule. The native row attempts all five
.claude self-grants and requires their absence plus returned public controls.
This is a candidate until CI proves it; if ENOENT survives, stop with argv.

Security revision after 9e7b98e93c: remove the person home from preparation,
restrict it to writable modes and create new directories with mode 0700.
The same four-minute traced step also runs Full and acceptEdits with a
second unowned home inside writable scope. All three commands run even if
an earlier row fails; their aggregate status stays failed. Preserve separate
JSON/argv for each row. Do not prepare the unowned home or the fixture
person home (missing .config and .docker). If either fails, return its argv
without another workaround. This adds no step or job time allowance.
The final-label removal list includes this trace step and agent-home-10k
and other-home-10k selection along with all other diagnostic narrowing.
