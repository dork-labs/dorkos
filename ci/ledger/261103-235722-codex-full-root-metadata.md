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

Evidence collection repair after 58a376be60: return to one bounded trace
folder upload, with the three JSON reports inside it. Do not enable hidden
files. This supersedes the uncommitted multi-path/hidden-file proposal.

Security diagnostic additions: after each probe row, even on failure, log
host .claude/.dork/.config/.docker types under person, data and agent roots
and require absent or directory. The small traced rows add -ttt plus mount,
umount2, unlink and unlinkat; never -v. Add default-mode native scenarios
with a chmod-000 home subtree and a subtree repeatedly removed during scan.
Keep all refusal, public-control and canary assertions; a reproduced scan
refusal remains red, with the user-visible error in its report.

Within the existing 20-minute traced-suite step, collect an isolated branch
control and main source comparison (main suite traced and untraced). Main
gets its own worktree, frozen offline install and workspace dependency build;
record its SHA and any setup failure as unproven. Main has no new protected
control row, so compare its existing native/background rows, not an invented
equivalence. All output stays inside the bounded trace upload. The existing
four-minute small-row cap and 64-minute measurements stay: total caps still
88/90, with more work within them and a real risk of partial evidence.

No security strategy, timeout, deny, profile or production behavior change.
Before final label, remove the main comparison script and invocation, rg
scenario/worker diagnostics and the new trace diagnostics together with the
previous must-go list. No claim that red or missing rows passed.

Security revision after 99dd7c6ac0 supersedes the preceding 88/90 layout.
Restore the pre-existing community acceptance include-hidden-files flag;
only the new trace upload omits it. Use the previously working single
relative .temp/codex-bwrap-trace/ path. Move main output to its own sibling
.temp/codex-main-comparison/ so the flat-file bwrap witness cannot hit EISDIR.
Upload that folder separately. Main comparison has its own always-run
15-minute step; small traces get 10, native stays 20 and untraced stays 64.
Job budget is 110, recorded in ledger 261103-231650; restore to 20 before
any final label and remove/review every diagnostic step and cap. Caps total
109, so overhead can still leave incomplete evidence. No production change.
