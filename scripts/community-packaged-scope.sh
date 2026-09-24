#!/usr/bin/env bash
# Decide whether a pull request can reach the packaged Community proof, the
# `community-packaged` job of test.yml (DOR-2220).
#
# WHY THIS EXISTS. `community-packaged` is a REQUIRED check. Until DOR-2220 it
# ran the proof only on `merge_group` and the main canary, and on a pull request
# it reported green having run nothing. So a change that broke the proof was
# first seen in the merge queue, where a red is an ejection (#1987: the browser
# spec gained an "Open community" step, the sealed driver did not, and the queue
# ejected it). The proof takes about six minutes on a runner, too slow to pay on
# every push of every pull request, so this list decides which pull requests pay
# it. A required check cannot be scoped by a workflow-level `paths:` filter or a
# job-level `if:` (either can leave the context skipped, and a skipped required
# check counts as passing), so the job runs on every event and this list only
# gates its steps. The merge queue and the main canary ignore it: they always
# run the proof.
#
# WHAT IS IN, AND WHY. The proof builds a Docker image from the whole of apps/,
# packages/ and scripts/ and drives the packaged local DorkOS app against two
# packaged Communities, so strictly almost every change can reach it; matching
# that would run it on about three PRs in four (153 of the 200 merges before
# 2026-09-23) and buy little, because the proof's breaks come from the community
# slice. Every change to the driver on record came with one of these (#1916,
# #1958, #1974, #1987, #1992, #2021):
#
#   apps/community/                      the service, its browser pages, its
#                                        migrations, and the proof itself:
#                                        acceptance/{Dockerfile,run.sh,run.mjs,
#                                        driver.spec.ts}
#   apps/{client,server}/src/…communit…  the local app's half of the journey
#                                        (entities/community, features/
#                                        community-*, services/communities, the
#                                        community routes)
#   packages/shared/src/…communit…       the contracts both halves speak
#                                        (community-adapter, community schemas)
#   packages/cloud-api/                  built inside the image before shared
#   packages/cli/scripts/build.ts        how the packaged `dorkos` is bundled
#   pnpm-lock.yaml, pnpm-workspace.yaml  the image's install and the
#                                        `deploy --prod` of the Community
#   scripts/sweep-ephemeral-docker.sh    run.sh calls it before anything starts
#   scripts/community-packaged-scope.sh  this list
#   .github/workflows/test.yml           the job that runs the proof
#
# WHAT IS OUT, ON PURPOSE. The rest of apps/client, apps/server and packages/
# (relay, rooms, onboarding and so on), which the proof also touches. A break
# there is still caught before `main`, by the queue, and on `main` by the
# canary; it is just not caught at PR time. That is about 65 of 200 merges in
# scope, not 153. Widen the list when an ejection on record came from outside
# it, and cite the PR beside the entry.
#
# Translated from glob to extended regular expressions the same way as
# scripts/scripts-test-scope.sh, which this mirrors:
#
#   dir/**           ^dir/
#   file.ext         ^file\.ext$
#
# Usage:
#   git diff --no-renames --name-only <base> <head> | scripts/community-packaged-scope.sh
#
# Reads changed paths, one per line, on stdin. Prints exactly one line:
#   true    at least one path can reach the packaged proof; run it
#   false   none can; the job reports green without running it
# The matching path (or the absence of one) goes to stderr. An EMPTY stdin
# prints `false`. Exit status is 0 for a verdict.
#
# Hermetic, and pinned by scripts/test-community-packaged-scope.sh.

set -euo pipefail

SCOPE_PATTERNS=(
  '^apps/community/'
  '^apps/(client|server)/src/.*communit'
  '^packages/shared/src/.*communit'
  '^packages/cloud-api/'
  '^packages/cli/scripts/build\.ts$'
  '^pnpm-lock\.yaml$'
  '^pnpm-workspace\.yaml$'
  '^scripts/sweep-ephemeral-docker\.sh$'
  '^scripts/community-packaged-scope\.sh$'
  '^\.github/workflows/test\.yml$'
)

pattern=$(
  IFS='|'
  printf '%s' "${SCOPE_PATTERNS[*]}"
)

# Drain stdin first and match from a here-string, for the reason
# scripts-test-scope.sh gives: `grep -m 1` on a pipe under `pipefail` scores a
# late match on a large diff as "nothing matched" once the writer takes SIGPIPE.
changed=$(cat)
if hit=$(grep -E -m 1 "$pattern" <<<"$changed"); then
  echo "can reach the packaged community proof: $hit" >&2
  echo true
else
  echo 'nothing that can reach the packaged community proof changed' >&2
  echo false
fi
