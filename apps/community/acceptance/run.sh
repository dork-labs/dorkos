#!/usr/bin/env bash
# Build and exercise the packaged apps on a fresh, isolated Docker network.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
image=""
if [[ $# -eq 2 && "$1" == --image ]]; then
  image="$2"
elif [[ $# -ne 0 ]]; then
  echo 'Usage: bash apps/community/acceptance/run.sh [--image already-built-image]' >&2
  exit 2
fi
cd "$repo_root"
if [[ -z "$image" ]]; then
  image="dorkos-community-acceptance:local"
  docker build -f apps/community/acceptance/Dockerfile -t "$image" .
fi
mkdir -p .temp/community-acceptance
output="$(mktemp -d "$repo_root/.temp/community-acceptance/run.XXXXXX")"
run_id="$$-$RANDOM"
network="dorkos-community-proof-$run_id"
postgres="dorkos-community-proof-pg-$run_id"
app="dorkos-community-proof-app-$run_id"
network_created=false
postgres_created=false
app_created=false
copy_evidence() {
  # This allowlist intentionally excludes service logs, databases, blobs and
  # /data/home. The Playwright directory contains only the configured
  # screenshot and trace output.
  for artifact in network-proof.json playwright-report.json; do
    docker cp "$app:/data/acceptance/$artifact" "$output/$artifact" 2>/dev/null || true
  done
  docker cp "$app:/data/acceptance/playwright-artifacts" "$output/playwright-artifacts" >/dev/null 2>&1 || true
}
cleanup() {
  if [[ "$app_created" == true ]]; then
    # Copy the bounded evidence before deleting the container, on both success
    # and failure. Cleanup still removes only resources this runner created.
    copy_evidence
    docker rm -f "$app" >/dev/null 2>&1 || true
  fi
  if [[ "$postgres_created" == true ]]; then docker rm -fv "$postgres" >/dev/null 2>&1 || true; fi
  if [[ "$network_created" == true ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  echo "Community acceptance reports: $output"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Pull on the host before starting any tested process. Neither runtime receives
# a second network, host network mode, a host port, or model credentials.
docker pull postgres:17-alpine >/dev/null
docker network create --internal "$network" >/dev/null
network_created=true
[[ "$(docker network inspect -f '{{.Internal}}' "$network")" == true ]]
docker run -d --name "$postgres" --network "$network" \
  -e POSTGRES_DB=community -e POSTGRES_PASSWORD=community-test-only postgres:17-alpine >/dev/null
postgres_created=true
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if docker exec "$postgres" pg_isready -U postgres -d community >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Isolated PostgreSQL did not become ready.' >&2; exit 1; }
docker create --name "$app" --network "$network" \
  -e "COMMUNITY_TEST_DATABASE_URL=postgres://postgres:community-test-only@$postgres:5432/community" \
  "$image" >/dev/null
app_created=true
# docker start's client exit is not the evidence; inspect the owned container's
# actual exit status even if attaching its output failed.
docker start -a "$app" || true
status="$(docker inspect -f '{{.State.ExitCode}}' "$app")"
[[ "$(docker inspect -f '{{.State.Running}}' "$app")" == false ]]
[[ "$status" == 0 ]] || { echo "Packaged community acceptance failed ($status)." >&2; exit 1; }
for artifact in network-proof.json playwright-report.json; do
  docker cp "$app:/data/acceptance/$artifact" "$output/$artifact"
  [[ -s "$output/$artifact" ]] || { echo "Missing acceptance evidence: $artifact" >&2; exit 1; }
done
