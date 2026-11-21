---
id: 261120-111849
title: pnpm verify records a proof only for a run that finished
kind: incident-fix
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.unfinished-verify-proofs
  baseline: 1
  baseline_source: "the one known case in the DOR-4616 brief (#3894): a pnpm verify stopped with SIGTERM printed turbo's summary, 29 of 35 tasks successful, and exited 0. The client test task was cancelled by the stop, not failed: pnpm printed ELIFECYCLE as its process was killed, and turbo counts a cancelled task as neither a success nor a failure. A proof was recorded and the arm script would have accepted the head"
  target: 0
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4616. A proof meant "the gate exited 0", and that is not the same as "the gate ran".
turbo answers a signal by shutting its tasks down, printing its summary and returning the
run's result: a task it cancelled is not a failure, so it exits 0. `scripts/verify-proof/cli.ts`
recorded a pass on that 0.

The change, all fail-closed:

- Each turbo step in `verify:checks` and `verify:preopen:turbo` runs with `--summarize`, and
  the CLI records a proof only when it finds exactly the summaries it expects (two for the full
  gate, one for preopen) and each shows every started task finished
  (`success + cached == attempted`), none failed, exit code 0. Every way out of the gate removes
  the summaries the run wrote except the newest unfinished one, whose path it prints.
- A proof now says so: `finished: true` and `turboRuns`, and `check` accepts no proof without
  them, at either level. That refuses every proof recorded before this change, real or not, and
  every one a branch cut before it records with its own older CLI. Re-running `pnpm verify` is
  the cost; an unmarked proof cannot be told from a false one.
- Every refusal is a line in `refusals.jsonl` beside the proofs, with its reason (`stopped` or
  `unfinished`), and a `verify_stopped` or `verify_unfinished` note when the run is inside a
  hook's time-wrap.
- The CLI catches TERM, HUP and INT for the whole run, passes TERM and HUP on to pnpm (INT
  already reached the whole process group from the terminal), and exits 128+n with no proof.
- `scripts/heavy-run-lock.sh` traps INT and QUIT around its command and exits 128+n. bash
  waiting on a foreground command that caught INT and exited 0 carried on as if nothing
  happened, so a Ctrl-C'd step exited 0. TERM and HUP already ended the wrapper by the signal.

Revert, or narrow it, if a run that really finished is refused more than once in the window,
counted from `refusals.jsonl` (a turbo release that changes the run summary's `execution`
counts, or a step that writes no summary when nothing is affected). A test pins the turbo
version the summary was read against, so an upgrade has to re-read it first.
