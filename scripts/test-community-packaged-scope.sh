#!/usr/bin/env bash
# Fixture suite for scripts/community-packaged-scope.sh, the list that decides
# whether a pull request runs the packaged Community proof (DOR-2220).
#
# Both directions fail quietly:
#
#   too narrow — a change that can break the sealed driver skips it at PR time,
#                goes green, and is ejected from the merge queue instead: the
#                exact failure the list exists to prevent (#1987).
#   too broad  — every PR pays about six runner-minutes for a proof it cannot
#                affect.
#
# So every entry has a path that must match, including the real paths of the
# PRs that changed the driver, and the near-misses a regex gets wrong (an
# unanchored dot, a prefix without its slash, a community-named file outside the
# three source roots) have a path that must not.
#
# Hermetic: stdin in, one word out, no git and no network.
#
#   bash scripts/test-community-packaged-scope.sh
#   SCOPE=/path/to/other.sh bash scripts/test-community-packaged-scope.sh
#
# SCOPE exists so a neutered implementation can be run against the same fixtures
# to show what it stops catching.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/community-packaged-scope.sh}

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

# --- every entry reaches the proof ------------------------------------------
for path in \
  apps/community/acceptance/driver.spec.ts \
  apps/community/acceptance/run.sh \
  apps/community/acceptance/Dockerfile \
  apps/community/src/browser/components/JoinPage.tsx \
  apps/community/migrations/0007_membership.sql \
  apps/community/package.json \
  apps/client/src/layers/entities/community/model/use-communities.ts \
  apps/client/src/layers/features/community-connections/ui/CommunityConnectionCard.tsx \
  apps/client/src/app/__tests__/community-route-memory.test.ts \
  apps/client/src/layers/widgets/room-view/ui/RemoteCommunitySurface.tsx \
  apps/client/src/layers/widgets/room-view/ui/RemoteCommunityAgents.tsx \
  apps/client/src/layers/features/dashboard-sidebar/ui/context/CommunityContextSwitcher.tsx \
  apps/server/src/services/core/COMMUNITY_NOTES.ts \
  packages/shared/src/CommunitySchemas.ts \
  packages/db/src/schema/communities/community-mirrors.ts \
  'apps/community/src/browser/naïve-välkommen.tsx' \
  apps/server/src/services/communities/remote/remote-community-adapter.ts \
  apps/server/src/routes/communities.ts \
  packages/shared/src/community-adapter.ts \
  packages/shared/src/community-schemas.ts \
  packages/cloud-api/src/index.ts \
  packages/cli/scripts/build.ts \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  scripts/sweep-ephemeral-docker.sh \
  scripts/community-packaged-scope.sh \
  .github/workflows/test.yml; do
  expect true "in scope: $path" "$path"
done

# --- the near-misses stay out ------------------------------------------------
for path in \
  apps/client/src/layers/features/chat/ui/ChatPanel.tsx \
  apps/server/src/services/relay/relay-service.ts \
  apps/client/package.json \
  packages/shared/src/transport.ts \
  packages/shared/package.json \
  packages/shared/src/handle.ts \
  packages/shared/src/room-schemas.ts \
  packages/db/src/schema/rooms.ts \
  packages/db/drizzle/0042_communities.sql \
  apps/site/src/app/Community/page.tsx \
  packages/cli/scripts/test-community-deploy-live.ts \
  packages/cli/package.json \
  packages/cli/scripts/build.tsx \
  apps/site/src/app/community/page.tsx \
  docs/guides/community.mdx \
  specs/community-server/02-specification.md \
  changelog/unreleased/260923-000000-community.md \
  apps/communityx/src/index.ts \
  apps/e2e/tests/community.spec.ts \
  research/apps/server/src/communities-notes.md \
  package.json \
  pnpm-lock.yamlx \
  scripts/sweep-ephemeral-docker.shx \
  scripts/test-sweep-ephemeral-docker.sh \
  .github/workflows/test.yml.orig \
  .github/workflows/browser-test.yml \
  .github/workflowsXtest.yml; do
  expect false "out of scope: $path" "$path"
done

# --- whole diffs --------------------------------------------------------------
expect false 'an empty diff reaches nothing' ''
expect false 'several unrelated files' apps/client/src/a.ts apps/site/src/b.tsx docs/c.mdx
expect true 'one relevant file among unrelated ones' apps/client/src/a.ts apps/community/src/x.ts docs/c.mdx

# A large diff whose only match is LAST: the shape a pipe into `grep -m 1` under
# `pipefail` scores as "no match" once the writer takes SIGPIPE.
big=()
for i in $(seq 1 20000); do big+=("apps/client/src/generated/file-$i.ts"); done
expect true 'a 20k-line diff whose one match is last' "${big[@]}" apps/community/acceptance/run.mjs
expect false 'a 20k-line diff with no match' "${big[@]}"

# --- the caller's side: a real pipeline under pipefail ------------------------
if out=$(set -o pipefail; printf '%s\n' "${big[@]:0:10000}" apps/community/src/a.ts "${big[@]:10000}" | bash "$scope" 2>/dev/null) && [ "$out" = true ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: a mid-stream match under pipefail: got '${out:-}' (status $?)" >&2
fi

echo "community-packaged-scope: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
