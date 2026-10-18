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
# to show what it stops catching. A copy outside this repository cannot find
# ci/space-server.env beside it, so give it SPACE_SERVER_ENV=<repo>/ci/space-server.env.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/community-packaged-scope.sh}

# The space server's folders, from the same file the scope script reads, so the
# fixtures below follow it when the folder moves (DOR-3007).
# shellcheck source=../ci/space-server.env
source "$repo_root/ci/space-server.env"

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
  "$SPACE_DIR"/acceptance/driver.spec.ts \
  "$SPACE_DIR"/acceptance/run.sh \
  "$SPACE_DIR"/acceptance/Dockerfile \
  "$SPACE_DIR"/src/browser/components/JoinPage.tsx \
  "$SPACE_DIR"/migrations/0007_membership.sql \
  "$SPACE_DIR"/package.json \
  "$SPACE_SRC_DIR/app.ts" \
  "$SPACE_WEB_DIR/components/Channel.tsx" \
  apps/client/src/layers/entities/community/model/use-communities.ts \
  apps/client/src/layers/features/community-connections/ui/CommunityConnectionCard.tsx \
  apps/client/src/app/__tests__/community-route-memory.test.ts \
  apps/client/src/layers/widgets/room-view/ui/RemoteCommunitySurface.tsx \
  apps/client/src/layers/widgets/room-view/ui/RemoteCommunityAgents.tsx \
  apps/client/src/layers/features/dashboard-sidebar/ui/context/CommunityContextSwitcher.tsx \
  apps/server/src/services/core/COMMUNITY_NOTES.ts \
  packages/shared/src/CommunitySchemas.ts \
  packages/db/src/schema/communities/community-mirrors.ts \
  "$SPACE_DIR/src/browser/naïve-välkommen.tsx" \
  apps/server/src/services/communities/remote/remote-community-adapter.ts \
  apps/server/src/routes/communities.ts \
  packages/shared/src/community-adapter.ts \
  packages/shared/src/community-schemas.ts \
  packages/cloud-api/src/index.ts \
  packages/connector-providers/src/connector-schemas.ts \
  packages/connector-providers/package.json \
  packages/cli/scripts/build.ts \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  scripts/sweep-ephemeral-docker.sh \
  scripts/community-packaged-scope.sh \
  .github/workflows/test.yml; do
  expect true "in scope: $path" "$path"
done

# Literal paths of the layout while apps/community is a build shell (server-merge
# step 7, between the move and the image from the server package): the code in
# apps/server/src/services/spaces, the rest still in apps/community. The fixtures
# above follow the file, so a wrong value (SPACE_DIR=apps, say) could pass them
# while widening or emptying the scope; these pin the real one. Retire the block
# when apps/community goes (7g).
if [ -d "$repo_root/apps/community" ]; then
  if [ "$SPACE_DIR" = apps/community ] && [ "$SPACE_SRC_DIR" = apps/server/src/services/spaces ] &&
    [ "$SPACE_WEB_DIR" = apps/community/src/browser ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: apps/community exists, but ci/space-server.env names $SPACE_DIR, $SPACE_SRC_DIR, $SPACE_WEB_DIR" >&2
  fi
  for path in apps/server/src/services/spaces/app.ts apps/community/migrations/0001_foundation.sql \
    apps/community/src/browser/CommunityApp.tsx apps/community/Dockerfile; do
    expect true "in scope (build-shell layout): $path" "$path"
  done
  for path in apps/communityx/src/app.ts apps/server/src/index.ts apps/server/src/services/spacesx/a.ts \
    apps/server/src/services/relay/relay-service.ts apps/client/src/main.tsx; do
    expect false "out of scope (build-shell layout): $path" "$path"
  done
fi

# --- the near-misses stay out ------------------------------------------------
for path in \
  apps/client/src/layers/features/chat/ui/ChatPanel.tsx \
  apps/server/src/services/relay/relay-service.ts \
  apps/client/package.json \
  packages/shared/src/transport.ts \
  packages/shared/package.json \
  packages/connector-providersx/package.json \
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
  "${SPACE_DIR}x/src/index.ts" \
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
expect true 'one relevant file among unrelated ones' apps/client/src/a.ts "$SPACE_DIR/src/x.ts" docs/c.mdx

# A large diff whose only match is LAST: the shape a pipe into `grep -m 1` under
# `pipefail` scores as "no match" once the writer takes SIGPIPE.
big=()
for i in $(seq 1 20000); do big+=("apps/client/src/generated/file-$i.ts"); done
expect true 'a 20k-line diff whose one match is last' "${big[@]}" "$SPACE_DIR/acceptance/run.mjs"
expect false 'a 20k-line diff with no match' "${big[@]}"

# --- where the space server lives (DOR-3007) ----------------------------------
# The folders come from ci/space-server.env. The file itself is in scope: moving
# the folder changes what the proof covers.
expect true 'in scope: ci/space-server.env' ci/space-server.env
for path in ci/space-server.envx ci/space-server.env.orig ci/gates.yaml; do
  expect false "out of scope: $path" "$path"
done

# The layout after the program merge (specs/server-merge step 7): the space
# server inside apps/server, its web pages inside apps/client. Its own folders
# reach the proof; the rest of apps/server and apps/client must not, or every
# pull request would pay for it.
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
future_env=$fixture_dir/future.env
cat >"$future_env" <<'ENV'
# the layout after the move
SPACE_DIR=apps/server/src/services/spaces
SPACE_SRC_DIR=apps/server/src/services/spaces
SPACE_WEB_DIR=apps/client/src/layers/features/spaces
ENV

# expect_future <want> <label> <paths...>: as expect, scored under the future layout.
expect_future() {
  local want=$1 label=$2
  shift 2
  local got
  got=$(printf '%s\n' "$@" | SPACE_SERVER_ENV=$future_env bash "$scope" 2>/dev/null)
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: after the move: $label: expected '$want', got '$got' for: $*" >&2
  fi
}

for path in \
  apps/server/src/services/spaces/app.ts \
  apps/server/src/services/spaces/acceptance/driver.spec.ts \
  apps/server/src/services/spaces/migrations/0007_membership.sql \
  apps/client/src/layers/features/spaces/ui/JoinPage.tsx \
  apps/server/src/services/communities/remote/remote-community-adapter.ts \
  packages/shared/src/community-adapter.ts \
  ci/space-server.env; do
  expect_future true "in scope: $path" "$path"
done
for path in \
  apps/server/src/services/relay/relay-service.ts \
  apps/server/src/index.ts \
  apps/server/package.json \
  apps/server/src/services/spacesx/app.ts \
  apps/server/src/services/space/app.ts \
  apps/client/src/layers/features/chat/ui/ChatPanel.tsx \
  apps/client/src/layers/features/spaces-other/ui/X.tsx \
  apps/community/src/app.ts; do
  expect_future false "out of scope: $path" "$path"
done
expect_future false 'a server-only pull request' \
  apps/server/src/services/relay/relay-service.ts apps/server/src/routes/sessions.ts apps/server/package.json

# A dot in a folder name matches only a dot.
dotted_env=$fixture_dir/dotted.env
printf '%s\n' SPACE_DIR=apps/space.server SPACE_SRC_DIR=apps/space.server/src SPACE_WEB_DIR=apps/space.server/web >"$dotted_env"
got=$(printf '%s\n' apps/spaceXserver/src/a.ts | SPACE_SERVER_ENV=$dotted_env bash "$scope" 2>/dev/null)
if [ "$got" = false ]; then pass=$((pass + 1)); else
  fail=$((fail + 1))
  echo "FAIL: a dot in a folder name matched any character: got '$got'" >&2
fi

# No file, or a folder left empty: no verdict and a non-zero exit, which the
# job's step turns into running the proof. Never a `false`.
empty_env=$fixture_dir/empty.env
printf '%s\n' SPACE_DIR=apps/community SPACE_SRC_DIR= SPACE_WEB_DIR=apps/community/src/browser >"$empty_env"
for env_file in "$fixture_dir/missing.env" "$empty_env"; do
  if out=$(printf '%s\n' docs/a.mdx | SPACE_SERVER_ENV=$env_file bash "$scope" 2>/dev/null); then
    fail=$((fail + 1))
    echo "FAIL: $env_file gave a verdict ('$out') instead of failing" >&2
  elif [ -n "$out" ]; then
    fail=$((fail + 1))
    echo "FAIL: $env_file printed '$out' before failing" >&2
  else
    pass=$((pass + 1))
  fi
done

# --- the caller's side: a real pipeline under pipefail ------------------------
if out=$(set -o pipefail; printf '%s\n' "${big[@]:0:10000}" "$SPACE_DIR/src/a.ts" "${big[@]:10000}" | bash "$scope" 2>/dev/null) && [ "$out" = true ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: a mid-stream match under pipefail: got '${out:-}' (status $?)" >&2
fi

echo "community-packaged-scope: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
