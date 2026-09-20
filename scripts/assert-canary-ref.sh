#!/usr/bin/env bash
# A main-canary run is against `main`, or it is nothing (DOR-2150).
#
# `test.yml`, `browser-test.yml`, `typecheck.yml` and `lint.yml` run their own
# suites against `main` HEAD on a `schedule`, and carry `workflow_dispatch` so
# one can be run on demand. A `schedule` run is always on the default branch. A
# DISPATCH IS NOT: `gh workflow run test.yml --ref some-pr-branch` runs the
# workflow against that branch's head, and the check run it posts lands on that
# SHA — which is a pull request's head, under the name of a required context.
#
# This refuses that run, and it refuses it by FAILING rather than by skipping.
# A skipped job posts a skipped check run, and GitHub counts skipped as passing
# (contributing/ci.md, "A skipped job satisfies a required context"), so a
# skip here would be a way to hand a pull request a green required check that
# tested a different tree. A failure is loud, costs whoever dispatched it one
# push to clear, and can never be mistaken for a pass.
#
# It runs FIRST in every job on the canary path, before any checkout or
# install, so a misdirected dispatch costs seconds rather than 150 job minutes.
#
# On `pull_request` and `merge_group` it does nothing at all: those events are
# the gate, and their ref is whatever GitHub built. Deliberately NO `if:` on
# the step that calls it — an event-branching `if:` in a required job needs a
# census allowlist entry, and a three-line shell test that is a no-op on both
# gating events needs none while gating exactly the same thing.
#
# Fixtures: scripts/__tests__/assert-canary-ref.test.ts.
set -euo pipefail

event="${EVENT:-}"
ref="${REF:-}"
main_ref="${MAIN_REF:-refs/heads/main}"

if [ "$event" != 'schedule' ] && [ "$event" != 'workflow_dispatch' ]; then
  echo "event '$event' is not a canary event; nothing to check."
  exit 0
fi

if [ "$ref" != "$main_ref" ]; then
  echo "::error title=The main canary runs against main only::this $event run is on '$ref', not '$main_ref'. Nothing was tested. Dispatch it with --ref main; a run on a branch would post this check on that branch's head, under the name of a required context."
  exit 1
fi

echo "canary $event run against $ref."
