#!/usr/bin/env bash
# Decide whether a change can reach the `harness` job of scripts-test.yml.
#
# WHY THIS EXISTS. scripts-test.yml used to scope itself with a workflow-level
# `paths:` filter, written out twice (once per event). That filter had to go
# when its `fixtures` job became a REQUIRED check: a workflow skipped by a path
# filter reports nothing at all, and a required context that never reports keeps
# every unrelated pull request out of the merge queue until it times out. So
# `fixtures` now runs on every event, unscoped (it is about a minute of bash and
# Node with no install), and this list is the ONE copy of the scope that is left.
# It decides only whether `harness` (pnpm install, a turbo build, a typecheck
# and a vitest run: about four minutes) is worth starting. `harness` is not a
# required check, so skipping it satisfies nothing and blocks nothing.
#
# The entries are the old filter, one for one, translated from GitHub's glob
# syntax to extended regular expressions:
#
#   dir/**           ^dir/
#   apps/*/x.json    ^apps/[^/]+/x\.json$
#   file.ext         ^file\.ext$
#
# Every entry was added after a regression in a file OUTSIDE scripts/ sat out the
# suite that pins it (DOR-668, DOR-670, DOR-1644, DOR-1701, DOR-1781, DOR-1856,
# DOR-2081); scripts-test.yml's header keeps each reason. Removing one is the same
# regression again, so do not prune this list to make a PR cheaper.
#
# Usage:
#   git diff --no-renames --name-only <base>...<head> | scripts/scripts-test-scope.sh
#
# Reads changed paths, one per line, on stdin. Prints exactly one line:
#   true    at least one path can reach `harness`; run it
#   false   none can; skip it
# The matching path (or the absence of one) goes to stderr. An EMPTY stdin
# prints `false`: no change reaches nothing. Exit status is 0 for a verdict.
#
# Hermetic, and pinned by scripts/test-scripts-test-scope.sh.

set -euo pipefail

SCOPE_PATTERNS=(
  '^scripts/'
  '^\.agents/skills/creating-pull-requests/scripts/'
  '^\.claude/scripts/'
  '^package\.json$'
  '^lefthook\.yml$'
  '^apps/[^/]+/package\.json$'
  '^packages/[^/]+/package\.json$'
  '^packages/harness/src/'
  '^packages/shared/src/'
  '^vitest\.config\.ts$'
  '^pnpm-workspace\.yaml$'
  '^\.claude/hooks/'
  '^contributing/INDEX\.md$'
  '^apps/server/eslint\.config\.js$'
  '^packages/eslint-config/'
  '^\.github/workflows/scripts-test\.yml$'
  '^\.github/workflows/claude-code-review\.yml$'
  '^\.github/workflows/merge-tail\.yml$'
  '^\.github/workflows/operating-skills-version-check\.yml$'
  '^\.github/workflows/test\.yml$'
  '^\.github/workflows/credential-free-build\.yml$'
  '^\.github/dependabot\.yml$'
)

pattern=$(
  IFS='|'
  printf '%s' "${SCOPE_PATTERNS[*]}"
)

# Read the whole list first, then match from a here-string rather than a pipe:
# `grep -m 1` stops at the first match, and a writer still feeding it through a
# pipe would take SIGPIPE, which `pipefail` scores as a failed pipeline, i.e. as
# "nothing matched", on exactly the large diffs that do match. Draining stdin
# up front also spares the CALLER's `git diff` the same fate.
changed=$(cat)
if hit=$(grep -E -m 1 "$pattern" <<<"$changed"); then
  echo "can reach harness: $hit" >&2
  echo true
else
  echo 'nothing that can reach harness changed' >&2
  echo false
fi
