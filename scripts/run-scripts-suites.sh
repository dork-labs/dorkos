#!/usr/bin/env bash
# run-scripts-suites.sh — every scripts suite `pnpm verify` runs (`pnpm test:scripts`),
# and the one place CI's scripts-test.yml runs the shell fixture suites from.
#
#   bash scripts/run-scripts-suites.sh                # everything `pnpm test:scripts` runs
#   bash scripts/run-scripts-suites.sh --suites LANE  # only the shell fixture suites in LANE
#   bash scripts/run-scripts-suites.sh --list         # "<lane> <path>" for every suite found
#
# LANE is `fixtures`, `harness` or `all`.
#
# THE SUITES ARE FOUND BY GLOB, NOT LISTED (ledger fixture-suites-by-glob). Every
# `scripts/test-*.sh` and `.agents/skills/*/scripts/test-*.sh` is a suite. They
# used to be written out twice, one line here and one step in scripts-test.yml,
# and two PRs that each added a suite conflicted at the same spot in both files,
# which took them out of the merge queue (#4206 and #4258, Nov 24). Now a new
# suite is a new file and nothing else. A file matching the globs that is not a
# suite goes in SUITE_EXCLUDE below (none today). This file's own name does not
# match `test-*.sh` on purpose.
#
# LANES. A suite runs in scripts-test.yml's required `fixtures` job, which has
# no node_modules, unless one of its first 15 lines says
#
#   # scripts-suite-lane: harness
#
# which puts it in the `harness` job (it needs the real ESLint, prettier or
# tsx). Locally every lane runs.
#
# --suites runs every suite in the lane even after one fails, groups each one's
# output (a collapsible ::group:: in Actions), and ends with a summary naming
# each failing suite. It fails if any suite failed or if it found none, so an
# emptied glob cannot pass. scripts/__tests__/shell-suite-parity.test.ts pins
# the globs against the tree and checks that no workflow step or line here
# names a suite by hand.
#
# Bash 3.2 (macOS /bin/bash): no mapfile, no empty "${arr[@]}" under `set -u`.
# This lives here, not in the root package.json, on purpose (DOR-4190):
# Turborepo hashes the root package.json into every package.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Space-separated paths, relative to the repo root, that match the globs but
# are not suites.
SUITE_EXCLUDE=''

# The lane a suite declares in its first 15 lines, or `fixtures`.
lane_of() {
  local lane
  lane=$(sed -n '1,15s/^# scripts-suite-lane: *\([A-Za-z0-9_-]*\).*$/\1/p' "$1")
  lane=${lane%%$'\n'*}
  printf '%s\n' "${lane:-fixtures}"
}

# Prints "<lane> <path>" for every suite, in glob order. Fails on an unknown lane.
discover() {
  local f lane bad=0
  shopt -s nullglob
  for f in scripts/test-*.sh .agents/skills/*/scripts/test-*.sh; do
    case " $SUITE_EXCLUDE " in *" $f "*) continue ;; esac
    lane=$(lane_of "$f")
    case "$lane" in
      fixtures | harness) printf '%s %s\n' "$lane" "$f" ;;
      *)
        echo "run-scripts-suites: $f declares unknown lane '$lane' (use fixtures or harness)" >&2
        bad=1
        ;;
    esac
  done
  shopt -u nullglob
  return "$bad"
}

# Runs every suite in lane $1, keeps going past a failure, and summarizes.
run_suites() {
  local want=$1 listing lane path rc start secs
  local count=0 failed='' nfailed=0 in_actions=${GITHUB_ACTIONS:-}
  case "$want" in
    fixtures | harness | all) ;;
    *)
      echo "run-scripts-suites: unknown lane '$want' (fixtures, harness or all)" >&2
      return 2
      ;;
  esac
  listing=$(discover) || return 1
  # Each suite reads /dev/null, never the listing this loop reads.
  while IFS=' ' read -r lane path; do
    [ -n "$path" ] || continue
    [ "$want" = all ] || [ "$lane" = "$want" ] || continue
    count=$((count + 1))
    if [ -n "$in_actions" ]; then
      echo "::group::$path"
    else
      echo "==> $path"
    fi
    start=$SECONDS
    rc=0
    bash "$path" </dev/null || rc=$?
    secs=$((SECONDS - start))
    [ -z "$in_actions" ] || echo "::endgroup::"
    if [ "$rc" -eq 0 ]; then
      echo "ok    $path (${secs}s)"
    else
      nfailed=$((nfailed + 1))
      failed="$failed $path"
      echo "FAIL  $path exited $rc (${secs}s)"
      [ -z "$in_actions" ] || echo "::error title=Fixture suite failed::$path exited $rc. Run it alone: bash $path"
    fi
  done <<<"$listing"

  echo
  if [ "$count" -eq 0 ]; then
    echo "run-scripts-suites: found no suites in lane '$want'; the globs or the lane markers are broken" >&2
    [ -z "$in_actions" ] || echo "::error title=No fixture suites found::lane '$want' matched nothing"
    return 1
  fi
  echo "Fixture suites, lane $want: $count run, $((count - nfailed)) passed, $nfailed failed."
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Fixture suites, lane \`$want\`: $count run, $nfailed failed"
      for path in $failed; do echo "- FAILED \`$path\` (run it alone: \`bash $path\`)"; done
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  if [ "$nfailed" -gt 0 ]; then
    echo "Failing suites (run one alone with bash <path>):"
    for path in $failed; do echo "  $path"; done
    return 1
  fi
}

case "${1:-}" in
  --list)
    discover
    ;;
  --suites)
    run_suites "${2:-all}"
    ;;
  '')
    pnpm typecheck:scripts
    run_suites all
    node --experimental-strip-types --disable-warning=ExperimentalWarning --test .claude/scripts/__tests__/*.test.ts
    node .claude/scripts/docs-coverage-map.mjs --check
    vitest run --config scripts/vitest.config.ts --project scripts
    ;;
  *)
    echo "usage: bash scripts/run-scripts-suites.sh [--list | --suites fixtures|harness|all]" >&2
    exit 2
    ;;
esac
