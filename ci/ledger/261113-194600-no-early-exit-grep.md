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

The same shape was at 81 sites here. None is a release, publish or deploy
guard that can fail open (every production guard either fails closed on a miss
or reads a one-line input). Six are fail-open test assertions, each asserting a
leak is absent from multi-line output: the "refusal never echoes the input"
cases in `test-release-version.sh` (2), `test-npm-tarball-sha256.sh`,
`test-wait-for-npm.sh`, plus `test-run-credential-free.sh:222` and
`test-heavy-run-lock.sh:91`. In `test.yml`, a miss on a server-touching PR
picked two shards instead of six; in `update-homebrew.yml`, it skipped the
desktop cask update with the DMG present.

Change: every site becomes `grep <<<"$v" -q …` (no pipe, so no writer to
kill) or `cmd | grep … >/dev/null` (grep reads to EOF). A new required-job step,
`bash scripts/test-no-early-exit-grep.sh`, fails on any pipe into
`grep -q`/`--quiet`/`--silent` in `scripts/`, `.claude/hooks/`,
`.claude/scripts/`, `.agents/skills/*/scripts/` and `.github/workflows/`, with
its own must-catch and must-allow fixtures, and refuses to pass if its globs
match fewer than 50 files. It is in `test:scripts` too, as the parity test
demands. A grep over files: milliseconds.

Nothing in CI counts SIGPIPE misses, so this is written here rather than as a
hypothesis. No required check, deadline, shard, retry or coverage rule changes.
Revert by removing the step and the `test:scripts` link together; the rewritten
lines are safe to keep either way.
