---
id: 261113-194600
title: No pipe into grep -q in scripts, hooks or workflows
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

dorkos-cloud #463 found that `printf '%s' "$out" | grep -q x` under
`set -o pipefail` reads as a miss on input that matched: grep exits at its
first match, the writer dies of SIGPIPE, and pipefail reports the pipeline as
failed. On a loaded two-core runner that was 76 misses in 5,000; the
here-string form had 0. Under `if !`, or an `if` whose then-branch is the
refusal, the miss fails OPEN.

The first sites are already fixed on `main`: the six fail-open test
assertions and the shard pick and cask check workflows (#3710, ledger
261113-201500), and both sites in `assert-browser-tests-executed.sh` (#3928,
ledger 261118-065705). This entry carries the rest, 39 sites in 21 files,
ported from the draft #3709 (DOR-4684). None is a release, publish or deploy
guard that can fail open. One is the `test-check-banned-words.sh` flake
(DOR-4651), and the gate it tests, `check-banned-words.sh`, had four more.

Change: every site becomes `grep <<<"$v" -q …` (no pipe, so no writer to
kill) or `cmd | grep … >/dev/null` (grep reads to EOF). The pattern, the flags
and the branch each outcome takes are unchanged. A new step in the required
`fixtures` job, `bash scripts/test-no-early-exit-grep.sh`, fails on any pipe
into `grep -q`/`--quiet`/`--silent` in `scripts/`, `.claude/hooks/`,
`.claude/scripts/`, `.agents/skills/*/scripts/` and `.github/workflows/`, with
its own must-catch and must-allow fixtures, and refuses to pass if its globs
match fewer than 50 files. It is in `test:scripts` too, as the parity test
demands. A grep over files: milliseconds.

Nothing in CI counts SIGPIPE misses, so this is written here rather than as a
hypothesis. No required check, deadline, shard, retry or coverage rule changes.
Revert by removing the step and the `test:scripts` link together; the
rewritten lines are safe to keep either way.
