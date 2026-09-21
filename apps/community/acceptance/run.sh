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
# Unique per run, and unique enough that a name can never be REUSED: bash seeds
# $RANDOM per shell from pid and time, so a recycled pid could in principle
# repeat a pair. A reused volume name would not be re-labelled by `volume
# create`, leaving a live run's data directory stamped with a dead owner for the
# next sweep to delete.
run_id="$$-$(date +%s)-$RANDOM"
network="dorkos-community-proof-$run_id"
postgres="dorkos-community-proof-pg-$run_id"
pgdata="dorkos-community-proof-pgdata-$run_id"
app="dorkos-community-proof-app-$run_id"
network_created=false
postgres_created=false
pgdata_created=false
app_created=false
# Reclaim what killed predecessors left behind, then stamp everything we create
# so a later run can do the same for us. `cleanup` below only runs on a clean
# exit; a SIGKILL skips it, and that is how this leaked 110.6 GB of Postgres data
# directories. Values are space-free by construction, so the unquoted expansion
# that turns them into arguments is safe (and bash 3.2 has no mapfile).
bash "$repo_root/scripts/sweep-ephemeral-docker.sh"
# shellcheck disable=SC2207
ephemeral_labels=($(bash "$repo_root/scripts/sweep-ephemeral-docker.sh" --print-labels "$$"))
copy_evidence() {
  # Keep the configured browser screenshots/traces and reports, never service
  # logs, databases, blobs or the runtime home directory.
  for artifact in network-proof.json playwright-report.json; do
    docker cp "$app:/data/acceptance/$artifact" "$output/$artifact" 2>/dev/null || true
  done
  docker cp "$app:/data/acceptance/playwright-artifacts" "$output/playwright-artifacts" >/dev/null 2>&1 || true
}
cleanup() {
  if [[ "$app_created" == true ]]; then
    # Preserve evidence on success and failure before deleting our container.
    copy_evidence
    docker rm -f "$app" >/dev/null 2>&1 || true
  fi
  if [[ "$postgres_created" == true ]]; then docker rm -fv "$postgres" >/dev/null 2>&1 || true; fi
  if [[ "$pgdata_created" == true ]]; then docker volume rm -f "$pgdata" >/dev/null 2>&1 || true; fi
  if [[ "$network_created" == true ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  echo "Community acceptance reports: $output"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Pull on the host before starting any tested process. Neither runtime receives
# a second network, host network mode, a host port, or model credentials.
docker pull postgres:17-alpine >/dev/null
docker network create --internal "${ephemeral_labels[@]}" "$network" >/dev/null
network_created=true
[[ "$(docker network inspect -f '{{.Internal}}' "$network")" == true ]]
# A named, labelled volume for the data directory. The postgres image declares a
# VOLUME there, so without this every run mints an ANONYMOUS volume that carries
# no labels, belongs to nobody, and can never be swept by owner.
docker volume create "${ephemeral_labels[@]}" "$pgdata" >/dev/null
pgdata_created=true
docker run -d --name "$postgres" --network "$network" "${ephemeral_labels[@]}" \
  -v "$pgdata:/var/lib/postgresql/data" \
  -e POSTGRES_DB=community -e POSTGRES_PASSWORD=community-test-only postgres:17-alpine >/dev/null
postgres_created=true
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U postgres -d community >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Isolated PostgreSQL did not become ready.' >&2; exit 1; }
docker create --name "$app" --network "$network" "${ephemeral_labels[@]}" \
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
