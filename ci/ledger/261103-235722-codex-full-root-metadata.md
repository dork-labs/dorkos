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

Round five, authorized after 84d31f79a1: remove production parent preparation.
The renderer now inspects literal paths with lstat and collapses missing
ancestors to one strongest-access rule, with no mkdir. Globs stay untouched.
Missing targets through two aliases of an existing parent share one canonical
key. Existing symlinks count as existing. Inaccessible/non-directory ancestors
refuse rather than lose rules. The load fingerprint includes the resulting
configuration; targeted tests exercise a newly created .claude causing one
reload, retaining backups, host-key and glob refusals in acceptEdits and Full.

The small trace step now invokes run-codex-missing-parents.mjs. Within its
unchanged ten-minute cap, it traces openat, mkdir, mkdirat, mknod and mknodat
in addition to the previous syscalls, with -ttt and no -v. Every native row
attempts person-home settings.json/skills writes, including mkdir of the
missing parent, and requires returned attempt markers plus absent targets.
Owned-home rows also attempt all five self-grants; unowned-home rows retain
their write attempts and empty-home check. Add owned Full, person-home cwd,
symlinked person-home, outside-/tmp and SIGKILL/relaunch scenarios. Existing
/tmp rows, public controls, Full Git write proof and every canary stay required.

The driver stops at the first failed protection row, preserving its log,
JSON and argv, rather than attempting another workaround. The rg refusal rows
stay last and both report their errors. Its total wall allowance is 570 seconds
inside the step's 600 seconds; it kills only its owned process group after
each invocation. Nothing reruns on failure. All artifacts remain flat files
under the already proven single relative trace upload path. No cap changed.

Keep the suite-wide shared root for now: per-test isolation and a FIFO reset
must wait for creation/SIGKILL evidence. The kill row checks host parent types
immediately after the exact Codex child exits with SIGKILL, before shutdown,
and again after the next launch. No scan/error strategy change; DOR-3812 and
the PM's performance decision remain external release gates. Remove the new
driver/test/scenarios along with every prior diagnostic before final label;
restore job timeout to 20. Native results for this round are pending CI.

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

Step-one leak attribution after 5c954e4805: log EOF, signal request/result and
child exit with sender PID, target PID, origin and wall-clock milliseconds in
the process pool. Instrument the intentional kill row and all three diagnostic
drivers' existing group SIGKILLs, including ESRCH outcomes and spawnSync timeout
SIGTERM observations. No stop order, wait, timeout, signal target, error handling
or cleanup behavior changes. The native suite and protected rows log teardown
boundaries to separate ordinary turn shutdown from failing-suite cleanup.

Add kill/tgkill/tkill and -ttt to the full traced suite; add those syscalls plus
creat to the small traces. Never -v. These identify upstream/helper senders and
the previously invisible file creation call. Existing caps and the 110-minute
job stay unchanged; no retries. Native correlation remains pending CI. Remove
step-one tracing/driver/test diagnostics with the prior must-go list before label.

Reconciliation is not built in this step. Source review finds the current pool
removes closing children from its list before they exit; list empty cannot be
used alone as proof of no live Codex. Safe persistent ledger/reconciliation,
registry/process coordination, server-start integration and concurrent native
proof are sized above one engineering day. Per lead instruction, report that
size for the PM decision before implementation. No per-test isolation yet.

PM scope decision: build the stub-leak fix, with green native evidence and
Security's label due Thu Nov 13 at 17:00 CT. First identify the SIGKILL sender
from the logging round. If the pool's own six-second escalation caused the
leak, report that before continuing so the PM can re-size. Reconciliation
remains required for crashes regardless of sender. Its no-live-Codex guard
must combine marker directories with processes proven exited, failing closed;
a pool list alone is insufficient, including while children are closing.

Final-head must-go addition: remove the new signal log lines or reduce them
to debug before the final head. Diagnostic information must not remain at
normal log level. This applies to the process-pool EOF/signal/exit logging.

Add one default-stub-10k/default native diagnostic after the kill row. Plant
empty regular files at person-home .claude and .config, require a real turn,
all existing public controls and canary checks, and compare both files' type,
size, owner, mode, device/inode, modification/change times and content before
and after. Only those two intentional files are exempt from the ordinary host
parent-kind check; any other stray still fails. Record this row separately.
Fourteen rows share the existing 870-second deadline with no new time cap,
retry, isolation or production behavior. A refusal remains red, not proof of
the proposed default-only fallback. The fallback refusal is not implemented.
Per-test roots and FIFO isolation wait for the reconcile proof round.
