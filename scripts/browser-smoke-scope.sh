#!/usr/bin/env bash
# Decide whether a pull request's diff can reach anything the PR browser smoke
# boots, for the four `browser-smoke (n/4)` jobs of browser-test.yml (DOR-5111).
#
# WHY THIS EXISTS. browser-smoke builds @dorkos/server and @dorkos/client,
# boots them, and drives them with the @smoke Playwright specs in apps/e2e:
# four hosted runners, about 20 minutes each, on every pull request push. A
# pull request that changes only a workflow, a test file, a fixture suite, a
# ledger entry or the docs pays all of that for code no page loads. smoke feeds
# the REQUIRED `browser-test` context, so it cannot be scoped by a
# workflow-level `paths:` filter (a skipped workflow never reports, and the
# queue waits on it); the text-only-scope job runs this script on every pull
# request and, when it answers `false`, sets browser-smoke's lane to `none`, the
# same answer the text-only lane (DOR-4834) already gives and the fan-in already
# accepts. The merge queue and the main canary never run it: they always run
# every browser shard and the first-run journey, so nothing reaches `main`
# without the full browser suite.
#
# DENY BY DEFAULT. The list below is what CANNOT reach a browser leg. Every
# changed path (both sides of a rename) must match one entry, or the smoke runs.
# A new folder, a new kind of file or anything this list does not name runs the
# smoke, so the list can only be wrong by being too short, never by letting an
# unknown path through. The entries:
#
#   CHANGELOG.md, README.md      the ROOT files only; prose no page loads
#   changelog/ docs/ blog/       fragments, user docs, posts and reports. The
#   research/                    smoke runs with the marketing site off
#                                (E2E_SITE=0), and the server under test is
#                                fenced to a throwaway home, not this checkout
#   contributing/**.md           contributor guides (Markdown only)
#   ci/ledger/                   CI ledger entries (not ci/config.yaml: the
#                                heavy-run lock the e2e script runs reads it)
#   .github/workflows/*.yml      every workflow EXCEPT browser-test.yml, which
#                                is the browser legs themselves
#   scripts/__tests__/           the scripts' vitest suites and the
#   scripts/test-*.sh            fixture suites; never the scripts they test
#   <workspace>/__tests__/       a test folder at a package's root or anywhere
#   <workspace>/src/**/__tests__/   under its src/, in any apps/* or packages/*
#                                package except apps/e2e. Every package build
#                                the smoke runs excludes src/**/__tests__ from
#                                its emit (tsconfig.build.json), and no
#                                non-test module imports from one. A test file
#                                beside its source (foo.test.ts outside a
#                                __tests__ folder) still runs the smoke: a
#                                build would compile it.
#   an INERT WORKSPACE           the packages listed in INERT_WORKSPACES below,
#                                except their package.json (pnpm install runs
#                                every workspace's lifecycle scripts on every
#                                leg) and except packages/ci-steward/bin/, which
#                                scripts/heavy-run-lock.sh sources on every
#                                `pnpm --filter @dorkos/e2e run e2e`.
#
# Everything else runs the smoke: apps/client, apps/server outside its test
# folders, apps/e2e (all of it), every package the browser apps depend on, any
# package.json, the lockfile, turbo.json and every root config, scripts/ itself
# (the e2e script runs scripts/heavy-run-lock.sh and what it sources), ci/
# outside the ledger, .github/ outside workflows, and browser-test.yml.
#
# INERT WORKSPACES are packages outside the workspace dependency closure of
# @dorkos/client, @dorkos/server and @dorkos/e2e that nothing on the smoke
# path imports or reads by path. scripts/test-browser-smoke-scope.sh checks
# both against the real tree on every run, so adding a dependency on one of
# them (or a path into one) turns that suite red until the entry is removed.
#
# THE PR CANNOT GRADE ITSELF. browser-test.yml runs this script as it stands on
# the pull request's BASE commit, never the copy in the PR's checkout, so a PR
# that edits this file is scored by the old rules (and, touching scripts/, runs
# the smoke anyway).
#
# Usage:
#   scripts/browser-smoke-scope.sh <base-sha> <head-sha>
#   scripts/browser-smoke-scope.sh --inert-workspaces   (print the list)
#
# Prints exactly one line and exits 0:
#   true    something a browser leg loads may have changed; run the smoke
#   false   nothing a browser leg loads changed; the smoke stands down
# Every way of failing to decide FAILS OPEN to `true`: wrong arguments, a
# revision git cannot resolve, a diff that errors, or an empty diff. The reason
# goes to stderr.
#
# Reads only the git repository it runs in, and is pinned by
# scripts/test-browser-smoke-scope.sh.

set -uo pipefail

INERT_WORKSPACES=(
  apps/design-system
  apps/desktop
  apps/site
  packages/ci-steward
  packages/evals
)

if [ "${1:-}" = --inert-workspaces ] && [ $# -eq 1 ]; then
  printf '%s\n' "${INERT_WORKSPACES[@]}"
  exit 0
fi

run_smoke() {
  echo "$1; running the browser smoke" >&2
  echo true
  exit 0
}

[ $# -eq 2 ] && [ -n "$1" ] && [ -n "$2" ] || run_smoke 'usage: browser-smoke-scope.sh <base-sha> <head-sha>'
base=$1
head=$2

git rev-parse --verify --quiet "$base^{commit}" >/dev/null || run_smoke "cannot resolve base '$base'"
git rev-parse --verify --quiet "$head^{commit}" >/dev/null || run_smoke "cannot resolve head '$head'"

# Captured before it is read, so a git failure is a failure and never an empty
# diff. `core.quotePath=false` so a non-ASCII path comes out as itself;
# `--no-renames` so a file moved out of a browser folder reports its source as
# well as its destination.
changed=$(git -c core.quotePath=false diff --no-renames --name-only "$base" "$head") ||
  run_smoke 'git diff failed'
[ -n "$changed" ] || run_smoke 'the diff is empty'

# True when <path> sits in an inert workspace, outside the parts of it the
# smoke path does read.
in_inert_workspace() {
  local ws
  case $1 in
    */package.json | packages/ci-steward/bin/*) return 1 ;;
  esac
  for ws in "${INERT_WORKSPACES[@]}"; do
    case $1 in "$ws"/*) return 0 ;; esac
  done
  return 1
}

while IFS= read -r path; do
  case $path in
    .github/workflows/browser-test.yml) run_smoke "the browser workflow itself: $path" ;;
    apps/e2e/*) run_smoke "a browser spec, helper or config: $path" ;;
    CHANGELOG.md | README.md | changelog/* | docs/* | blog/* | research/*) continue ;;
    contributing/*.md | ci/ledger/*) continue ;;
    scripts/__tests__/* | scripts/test-*.sh) [[ $path == scripts/test-*/* ]] || continue ;;
  esac
  if [[ $path =~ ^\.github/workflows/[^/]+\.ya?ml$ ]]; then continue; fi
  if [[ $path =~ ^(apps|packages)/[^/]+/(src/(.+/)?)?__tests__/ ]]; then continue; fi
  in_inert_workspace "$path" && continue
  run_smoke "a browser leg can load: $path"
done <<<"$changed"

echo 'nothing a browser leg loads changed' >&2
echo false
