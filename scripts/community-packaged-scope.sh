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
# #1958, #1974, #1981, #1987, #1992, #2021):
#
#   $SPACE_DIR/, $SPACE_SRC_DIR/,        the service, its browser pages, its
#   $SPACE_WEB_DIR/                      migrations, and the proof itself:
#                                        acceptance/{Dockerfile,run.sh,run.mjs,
#                                        driver.spec.ts}. The three folders come
#                                        from ci/space-server.env (DOR-3007):
#                                        all apps/community today, and after the
#                                        program merge the space's own folders
#                                        inside apps/server and apps/client, so
#                                        the rest of apps/server stays out
#   ci/space-server.env                  where those folders are
#   apps/client/vite.space.config.ts     the build of the space's web pages
#   apps/{client,server}/src/…communit…  the local app's half of the journey:
#                                        any file or directory named for
#                                        communities, in ANY case, so the
#                                        PascalCase components the driver
#                                        asserts against count
#                                        (RemoteCommunitySurface.tsx,
#                                        RemoteCommunityAgents.tsx,
#                                        CommunityContextSwitcher.tsx,
#                                        CommunityChannelGroups.tsx) as well as
#                                        entities/community, features/
#                                        community-*, services/communities and
#                                        the community routes
#   packages/shared/src/…communit…       the contracts both halves speak
#                                        (community-adapter, community schemas),
#                                        same case rule
#   packages/shared/src/space-page/      what the space page and the space
#                                        server share (server-merge step 7)
#   packages/db/src/schema/communities/  the local mirror tables
#                                        (community-mirrors.ts backs the
#                                        proof's offline step)
#   packages/cloud-api/                  built inside the image before shared
#   packages/connector-providers/        built inside the image before shared,
#                                        which re-exports its connector schemas
#   packages/cli/scripts/build.ts        how the packaged `dorkos` is bundled
#   pnpm-lock.yaml, pnpm-workspace.yaml  the image's install and the
#                                        `deploy --prod` of the Community
#   scripts/sweep-ephemeral-docker.sh    run.sh calls it before anything starts
#   scripts/community-packaged-scope.sh  this list
#   .github/workflows/test.yml           the job that runs the proof
#
# WHAT IS OUT, ON PURPOSE. The rest of apps/client, apps/server and packages/
# (relay, rooms, onboarding and so on), which the proof also touches. That
# includes the shared contracts the community code imports but that are not
# named for it (packages/shared/src/handle.ts, room-schemas.ts,
# config-schema.ts, mesh-schemas.ts, relay-envelope-schemas.ts) and the drizzle
# migrations under packages/db/drizzle/. They change often for reasons that have
# nothing to do with communities, so matching them would run the proof on far
# more PRs than it catches. A break there is still caught before `main`, by the
# queue, and on `main` by the canary; it is just not caught at PR time. That
# leaves 66 of the 200 merges before 2026-09-23 in scope, not 153. Widen the
# list when an ejection on record came from outside it, and cite the PR beside
# the entry.
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
# The space server's folders come from ci/space-server.env beside this
# script's repository, or from the file SPACE_SERVER_ENV names (the fixture
# suite uses that to score the layout after the program merge). A file that is
# missing, or that leaves a folder empty, exits non-zero with no verdict, and
# the job's step treats that as "run the proof".
#
# Hermetic, and pinned by scripts/test-community-packaged-scope.sh.

set -euo pipefail

space_env=${SPACE_SERVER_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ci/space-server.env}
# shellcheck source=../ci/space-server.env
source "$space_env"
for key in SPACE_DIR SPACE_SRC_DIR SPACE_WEB_DIR; do
  if [ -z "${!key:-}" ]; then
    echo "$space_env does not set $key" >&2
    exit 2
  fi
done

# A folder as an anchored prefix: every regex metacharacter in it escaped, so a
# dot in a folder name matches only a dot.
folder() {
  printf '^%s/' "$(printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g')"
}

# "communit" in any case: `grep -i` would also loosen every other entry, so the
# case rule lives in this one fragment instead.
communit='[Cc][Oo][Mm][Mm][Uu][Nn][Ii][Tt]'

SCOPE_PATTERNS=(
  "$(folder "$SPACE_DIR")"
  "$(folder "$SPACE_SRC_DIR")"
  "$(folder "$SPACE_WEB_DIR")"
  '^ci/space-server\.env$'
  '^apps/client/vite\.space\.config\.ts$'
  "^apps/(client|server)/src/.*${communit}"
  "^packages/shared/src/.*${communit}"
  '^packages/shared/src/space-page/'
  '^packages/db/src/schema/communities/'
  '^packages/cloud-api/'
  '^packages/connector-providers/'
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
