#!/usr/bin/env bash
# Decide whether a change can reach the real Codex binary suites on macOS, the
# `codex-binary-macos` job of codex-binary-macos.yml (DOR-4402).
#
# WHY THIS EXISTS. Codex sandboxes commands with Seatbelt on macOS and with
# bubblewrap on Linux, and test.yml's `codex-sandbox` runs the binary suites on
# Linux only. A secret-protection test failed on a Mac with no CI signal at all
# (DOR-4402, Nov 15). The macOS job closes that, but it holds a macOS runner,
# the scarcest hosted runner, for about five minutes. Its fan-in
# `codex-sandbox-macos` reports on every pull request and queue build (a
# required check must always report), and this list decides which of them pay
# for the macOS run. Everything else reports green without it.
#
# WHAT IS IN, AND WHY.
#
#   apps/server/src/services/runtimes/codex/   the runtime and the four suites
#   apps/server/package.json, pnpm-lock.yaml,  the pinned Codex packages and
#   pnpm-workspace.yaml                        their catalog
#   VERSION                                    every release PR edits it, so a
#                                              release gets a macOS result
#   apps/server/vitest.config.ts               how the suites run
#   runtimes/shared/policy/,                   the shared file policy and the
#   runtimes/shared/runtime-environment*.ts,   native environment the Codex
#   runtimes/claude-code/claude-config-dir.ts, runtime builds its sandbox from,
#   apps/server/src/lib/{boundary,dork-home}.ts and the shared git and grant
#   packages/shared/src/{safe-git,             helpers it imports (the list a
#     git-hardening,directory-grants,          reviewed candidate for this
#     marketplace-schemas}.ts                  issue scoped merge groups with)
#   .github/workflows/codex-binary-macos.yml   the job itself
#   scripts/codex-macos-scope.sh               this list
#
# WHAT IS OUT, ON PURPOSE. The root package.json, turbo.json and vitest.config.ts:
# they change on about one merge in twenty for reasons unrelated to Codex, and
# the Linux `codex-sandbox` job runs the same suites on every change.
#
# The workflow reads this file from the BASE commit, never from the change it
# grades, so a change cannot edit the rule that scores it. A change to this
# file is itself in scope under the base's copy.
#
# Usage:
#   git diff --no-renames --name-only <base> <head> | scripts/codex-macos-scope.sh
#
# Reads changed paths, one per line, on stdin. Prints exactly one line:
#   true    at least one path can reach the macOS suites; run them
#   false   none can; the fan-in reports green without the macOS run
# The matching path (or the absence of one) goes to stderr. An EMPTY stdin
# prints `false`. Exit status is 0 for a verdict.
#
# Hermetic, and pinned by scripts/test-codex-macos-scope.sh.

set -euo pipefail

runtimes='^apps/server/src/services/runtimes'
SCOPE_PATTERNS=(
  "${runtimes}/codex/"
  "${runtimes}/shared/policy/"
  "${runtimes}/shared/runtime-environment(-config|-catalog)?\.ts$"
  "${runtimes}/claude-code/claude-config-dir\.ts$"
  '^apps/server/src/lib/(boundary|dork-home)\.ts$'
  '^packages/shared/src/(safe-git|git-hardening|directory-grants|marketplace-schemas)\.ts$'
  '^apps/server/package\.json$'
  '^apps/server/vitest\.config\.ts$'
  '^pnpm-lock\.yaml$'
  '^pnpm-workspace\.yaml$'
  '^VERSION$'
  '^\.github/workflows/codex-binary-macos\.yml$'
  '^scripts/codex-macos-scope\.sh$'
)

pattern=$(
  IFS='|'
  printf '%s' "${SCOPE_PATTERNS[*]}"
)

# Drain stdin first and match from a here-string: `grep -m 1` on a pipe under
# `pipefail` scores a late match on a large diff as "nothing matched" once the
# writer takes SIGPIPE (scripts-test-scope.sh has the history).
changed=$(cat)
if hit=$(grep -E -m 1 "$pattern" <<<"$changed"); then
  echo "can reach the macOS Codex suites: $hit" >&2
  echo true
else
  echo 'nothing that can reach the macOS Codex suites changed' >&2
  echo false
fi
