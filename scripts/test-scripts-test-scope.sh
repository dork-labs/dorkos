#!/usr/bin/env bash
# Fixture suite for scripts/scripts-test-scope.sh, the decision that starts or
# skips scripts-test.yml's `harness` job.
#
# Both directions fail quietly:
#
#   too narrow — a change to a file `harness` asserts against (a workflow, a
#                package manifest, the root vitest config) skips the suite that
#                pins it. The PR goes green having tested nothing, which is the
#                history behind every entry in the list.
#   too broad  — every PR pays four minutes of install and build for nothing.
#
# The first is the one that matters, so every entry of the old workflow-level
# `paths:` filter has a path here that must match, and the near-misses a regex
# translation gets wrong (an unanchored dot, a `*` that crosses a `/`, a prefix
# without its slash) have a path that must not.
#
# Hermetic: stdin in, one word out, no git and no network.
#
#   bash scripts/test-scripts-test-scope.sh
#   SCOPE=/path/to/other.sh bash scripts/test-scripts-test-scope.sh
#
# SCOPE exists so a neutered implementation can be run against the same fixtures
# to show what it stops catching.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/scripts-test-scope.sh}

pass=0
fail=0

# expect <want> <label> <paths...>: the paths, one per line, must score <want>.
expect() {
  local want=$1 label=$2
  shift 2
  local got
  got=$(printf '%s\n' "$@" | bash "$scope" 2>/dev/null)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label: expected '$want', got '$got' for: $*" >&2
  fi
}

# --- every entry of the old filter reaches harness ---------------------------
for path in \
  scripts/check-boundary.ts \
  scripts/__tests__/shell-suite-parity.test.ts \
  .agents/skills/creating-pull-requests/scripts/watch-prs.sh \
  .claude/scripts/docs-coverage-map.mjs \
  package.json \
  lefthook.yml \
  apps/server/package.json \
  packages/mesh/package.json \
  packages/harness/src/index.ts \
  packages/shared/src/transport.ts \
  vitest.config.ts \
  pnpm-workspace.yaml \
  .claude/hooks/git-guard.mjs \
  contributing/INDEX.md \
  apps/server/eslint.config.js \
  packages/eslint-config/base.js \
  .github/workflows/scripts-test.yml \
  .github/workflows/claude-code-review.yml \
  .github/workflows/merge-tail.yml \
  .github/workflows/operating-skills-version-check.yml \
  .github/workflows/test.yml \
  .github/workflows/credential-free-build.yml \
  .github/dependabot.yml; do
  expect true "in scope: $path" "$path"
done

# --- the near-misses stay out -------------------------------------------------
for path in \
  apps/client/src/App.tsx \
  docs/guides/getting-started.mdx \
  apps/server/src/package.json \
  apps/server/nested/deeper/package.json \
  packages/mesh/src/package.json \
  packages/harness/README.md \
  packages/shared/package-lock.json \
  scriptsx/tool.sh \
  my-scripts/tool.sh \
  apps/scripts/tool.sh \
  packageXjson \
  lefthook.yml.bak \
  contributing/INDEX.mdx \
  .github/workflows/lint.yml \
  .github/workflows/test.yml.orig \
  .github/workflows/docs-openapi-check.yml \
  .claude/rules/ci-pipeline.md \
  ci/required-checks.json; do
  expect false "out of scope: $path" "$path"
done

# --- whole diffs --------------------------------------------------------------
expect false 'an empty diff reaches nothing' ''
expect false 'several unrelated files' apps/client/src/a.ts apps/site/src/b.tsx docs/c.mdx
expect true 'one relevant file among unrelated ones' apps/client/src/a.ts scripts/x.sh docs/c.mdx

# A large diff whose only match is LAST: the shape that a pipe into `grep -m 1`
# (or `grep -q`) under `pipefail` scores as "no match" once the writer takes
# SIGPIPE. It must still say true.
big=()
for i in $(seq 1 20000); do big+=("apps/client/src/generated/file-$i.ts"); done
expect true 'a 20k-line diff whose one match is last' "${big[@]}" .github/dependabot.yml
expect false 'a 20k-line diff with no match' "${big[@]}"

# --- the caller's side: a real git pipeline under pipefail ---------------------
# The workflow pipes `git diff` into the script. Prove a match mid-stream does
# not kill the writer and flip the verdict.
if out=$(set -o pipefail; printf '%s\n' "${big[@]:0:10000}" scripts/a.sh "${big[@]:10000}" | bash "$scope" 2>/dev/null) && [ "$out" = true ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: a mid-stream match under pipefail: got '${out:-}' (status $?)" >&2
fi

echo "scripts-test-scope: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
