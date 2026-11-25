#!/usr/bin/env bash
# release-watch.sh — watch the newest release for its first 24 hours.
#
#   scripts/release-watch.sh due [--gap <minutes>] [X.Y.Z]
#   scripts/release-watch.sh checks-plan
#   scripts/release-watch.sh check <npx|npm-view|docker|homebrew|download|issues> <X.Y.Z>
#   scripts/release-watch.sh report <results-dir> <X.Y.Z> <run-url>
#
# DOR-5123, design §6 "Watch" (one release a day, release fast, fix forward).
# Smoke runs before npm; this runs after, where people install from:
#
#   due          prints `DUE <X.Y.Z> <published-at> <marker>` or `NOT_DUE <why>`.
#                With no version: the newest on npm (dist-tag latest), due only
#                while it was published less than 24 h ago and no watch run of
#                it uploaded its marker artifact (release-watch-<X.Y.Z>) in the
#                last --gap minutes (default 55: hourly). A marker counts only
#                from a run of release-watch.yml on main in this repository.
#                With a version (a dispatch): due at once, if npm has it.
#   checks-plan  the check ids one watch must report, one per line. An id with
#                no result in `report` is a failure ("no result").
#   check        runs one check and prints one JSON line per check id:
#                {"check": id, "status": pass|fail|skip|info, "detail": text}.
#                Exits 0 whatever the status; 2 on usage.
#     npx        `npx -y dorkos@X.Y.Z --version` prints X.Y.Z, from a clean npm
#                cache and prefix (id npx/<linux|macos|windows>, from RUNNER_OS).
#     npm-view   `npm view <pkg>@X.Y.Z version` for the three published packages.
#     docker     ghcr.io/dork-labs/dorkos:X.Y.Z pulls, runs and answers
#                /api/health.
#     homebrew   the tap's Formula/dorkos.rb points at dorkos-X.Y.Z.tgz.
#     download   dorkos.ai/download/{mac,windows} 302 to /releases/download/vX.Y.Z/.
#     issues     issues opened since publish that name X.Y.Z (a signal: info).
#   report       groups the results by the part of the id before `/` (npx,
#                npm-view, docker, homebrew, download). A failing group opens
#                or updates ONE issue, "Release watch: vX.Y.Z <group> fails",
#                labelled release-watch (made if missing); a group that passes
#                closes its open issue. Prints a Markdown summary. Exit 1 when a
#                group failed (the issue is written), so the run is red too.
#
# SURFACES. Docker, Homebrew and the desktop downloads ship by hand until the
# daily release dispatches them (design §7). A surface that is simply behind
# (no image yet, an older formula or download) is `skip` while
# RELEASE_WATCH_SURFACES is not `daily`, and always within SURFACE_GRACE_MIN
# (default 180) minutes of the npm publish; after that, with `daily`, it fails.
# A surface that is there but broken (pull, health, a non-302) always fails.
#
# The room ping: the red-main alarm is a local task, with no cloud path, so the
# issue (and the red run) is the alert. Text written here is public: versions,
# check names, HTTP codes, issue numbers and run links only, never output.
#
# GH, NPM, NPX, DOCKER and CURL override the binaries, NOW (ISO 8601 UTC) the
# clock, REPO ($GITHUB_REPOSITORY, then dork-labs/dorkos) the repository.
# Exit codes: 0 done; 1 report saw a failing group; 2 usage, or GitHub or npm
# could not be read. Fixtures: scripts/test-release-watch.sh.
set -uo pipefail

GH=${GH:-gh}
NPM=${NPM:-npm}
NPX=${NPX:-npx}
DOCKER=${DOCKER:-docker}
CURL=${CURL:-curl}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
LABEL=release-watch
WORKFLOW=release-watch.yml
WINDOW_MIN=${WINDOW_MIN:-1440}
SURFACES=${RELEASE_WATCH_SURFACES:-pending}
SURFACE_GRACE_MIN=${SURFACE_GRACE_MIN:-180}
RETRY_SLEEP=${RETRY_SLEEP:-60}
HEALTH_TRIES=${HEALTH_TRIES:-60}
HEALTH_SLEEP=${HEALTH_SLEEP:-2}
IMAGE=ghcr.io/dork-labs/dorkos
FORMULA_URL=https://raw.githubusercontent.com/dork-labs/homebrew-dorkos/HEAD/Formula/dorkos.rb
SITE=${SITE:-https://dorkos.ai}
PACKAGES='dorkos @dork-labs/cloud-api @dork-labs/connector-providers'
SEMVER='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'

usage() {
  sed -n '4,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "release-watch: $*" >&2
  exit 2
}
is_version() { [[ "$1" =~ ^${SEMVER}$ ]]; }

# Seconds since the epoch of an ISO 8601 UTC time, fractions dropped.
epoch() { jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601'; }
now_iso() { printf '%s\n' "${NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; }
minutes_since() { echo $((($(epoch "$(now_iso)") - $(epoch "$1")) / 60)); }

# When npm says <version> of dorkos was published, as YYYY-MM-DDTHH:MM:SSZ.
published_at() {
  local t
  t=$("$NPM" view dorkos time --json 2>/dev/null | jq -r --arg v "$1" '.[$v] // empty' 2>/dev/null) || t=
  [[ "$t" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || return 1
  printf '%s\n' "${t%%.*}" | sed 's/Z*$/Z/'
}

due() {
  local gap=55 version="" explicit=0 at age marker rows id created path since
  while [ $# -gt 0 ]; do
    case "$1" in
      --gap)
        [[ "${2:-}" =~ ^[0-9]+$ ]] || usage
        gap=$2
        shift 2
        ;;
      *)
        [ -z "$version" ] || usage
        version=$1
        explicit=1
        shift
        ;;
    esac
  done
  if [ "$explicit" = 0 ]; then
    version=$("$NPM" view dorkos dist-tags.latest 2>/dev/null) || err "could not read dorkos's latest dist-tag from npm"
  fi
  is_version "$version" || { [ "$explicit" = 1 ] && usage; err "npm's latest is not X.Y.Z"; }
  at=$(published_at "$version") || err "npm has no publish time for dorkos@$version"
  marker="release-watch-$version"
  if [ "$explicit" = 1 ]; then
    echo "DUE $version $at $marker"
    return 0
  fi
  age=$(minutes_since "$at")
  if [ "$age" -ge "$WINDOW_MIN" ]; then
    echo "NOT_DUE $version was published $age min ago; the watch covers the first $WINDOW_MIN"
    return 0
  fi
  if [ "$gap" -gt 0 ]; then
    rows=$("$GH" api "repos/$REPO/actions/artifacts?name=$marker&per_page=100" \
      --jq '[.artifacts[] | select(.workflow_run.head_branch == "main" and .workflow_run.head_repository_id == .workflow_run.repository_id) | {id: .workflow_run.id, at: .created_at}] | sort_by(.at) | reverse | .[] | "\(.id) \(.at)"') ||
      err "could not list artifacts named $marker"
    while read -r id created; do
      [ -n "${id:-}" ] || continue
      [[ "$id" =~ ^[0-9]+$ ]] || err "unexpected run id: $id"
      path=$("$GH" api "repos/$REPO/actions/runs/$id" --jq '"\(.path // "" | split("@")[0]) \(.head_branch)"') ||
        err "could not read run $id"
      [ "$path" = ".github/workflows/$WORKFLOW main" ] || continue
      since=$(minutes_since "$created")
      if [ "$since" -lt "$gap" ]; then
        echo "NOT_DUE run $id watched $version $since min ago; the next watch is $gap min after it"
        return 0
      fi
      break
    done <<<"$rows"
  fi
  echo "DUE $version $at $marker"
}

checks_plan() {
  printf '%s\n' npx/linux npx/macos npx/windows \
    npm-view/dorkos npm-view/cloud-api npm-view/connector-providers \
    docker homebrew download/mac download/windows issues
}

result() { jq -cn --arg c "$1" --arg s "$2" --arg d "$3" '{check: $c, status: $s, detail: $d}'; }

# A surface that is there but not at the version yet.
behind() {
  local id=$1 detail=$2 age
  age=$(minutes_since "$PUBLISHED_AT")
  if [ "$age" -lt "$SURFACE_GRACE_MIN" ]; then
    result "$id" skip "$detail; within $SURFACE_GRACE_MIN min of the npm publish"
  elif [ "$SURFACES" != daily ]; then
    result "$id" skip "$detail; this surface does not ship daily yet"
  else
    result "$id" fail "$detail"
  fi
}

check_npx() {
  local v=$1 os base dir native out rc got
  case "${RUNNER_OS:-$(uname -s)}" in
    Linux) os=linux ;;
    macOS | Darwin) os=macos ;;
    Windows | MINGW* | MSYS* | CYGWIN*) os=windows ;;
    *) os=other ;;
  esac
  base=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
  # Git Bash on Windows: a POSIX path for the shell, a Windows one for node.
  command -v cygpath >/dev/null 2>&1 && base=$(cygpath -u "$base")
  dir=$(mktemp -d "$base/release-watch-npx.XXXXXX")
  mkdir -p "$dir/cache" "$dir/prefix" "$dir/home"
  native=$dir
  command -v cygpath >/dev/null 2>&1 && native=$(cygpath -w "$dir")
  out=$(npm_config_cache="$native/cache" npm_config_prefix="$native/prefix" npm_config_update_notifier=false \
    npm_config_fund=false npm_config_audit=false DORK_HOME="$native/home" \
    "$NPX" -y "dorkos@$v" --version 2>/dev/null </dev/null)
  rc=$?
  rm -rf "$dir" 2>/dev/null
  out=$(tr -d '\r' <<<"$out")
  if grep -qxF -- "$v" <<<"$out"; then
    result "npx/$os" pass "printed $v"
    return 0
  fi
  got=$(grep -E "^${SEMVER}$" <<<"$out" | tail -n 1)
  if [ -n "$got" ]; then
    result "npx/$os" fail "printed $got, not $v (exit $rc)"
  else
    result "npx/$os" fail "printed no version (exit $rc)"
  fi
}

check_npm_view() {
  local v=$1 pkg got
  for pkg in $PACKAGES; do
    got=$("$NPM" view "$pkg@$v" version 2>/dev/null | tr -d '\r' | tail -n 1)
    if [ "$got" = "$v" ]; then
      result "npm-view/${pkg#@dork-labs/}" pass "$pkg@$v is on npm"
    else
      result "npm-view/${pkg#@dork-labs/}" fail "$pkg@$v is not on npm"
    fi
  done
}

check_docker() {
  local v=$1 image=$IMAGE:$1 cid i ok=0
  if ! "$DOCKER" manifest inspect "$image" >/dev/null 2>&1; then
    behind docker "no image $image"
    return 0
  fi
  if ! "$DOCKER" pull -q "$image" >/dev/null 2>&1; then
    result docker fail "$image did not pull"
    return 0
  fi
  if ! cid=$("$DOCKER" run -d --rm -p 127.0.0.1:4242:4242 "$image" 2>/dev/null) || [ -z "$cid" ]; then
    result docker fail "$image did not start"
    return 0
  fi
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    if "$CURL" -fsS -o /dev/null --max-time 5 http://127.0.0.1:4242/api/health 2>/dev/null; then
      ok=1
      break
    fi
    sleep "$HEALTH_SLEEP"
  done
  "$DOCKER" rm -f "$cid" >/dev/null 2>&1 || true
  if [ "$ok" = 1 ]; then
    result docker pass "$image answers /api/health"
  else
    result docker fail "$image did not answer /api/health in $((HEALTH_TRIES * HEALTH_SLEEP)) s"
  fi
}

check_homebrew() {
  local v=$1 rb got
  if ! rb=$("$CURL" -fsSL --max-time 30 "$FORMULA_URL" 2>/dev/null); then
    result homebrew fail "Formula/dorkos.rb could not be read"
    return 0
  fi
  got=$(sed -nE "s#.*registry\.npmjs\.org/dorkos/-/dorkos-(${SEMVER})\.tgz.*#\1#p" <<<"$rb" | head -n 1)
  if [ "$got" = "$v" ]; then
    result homebrew pass "the formula is at $v"
  elif [ -n "$got" ]; then
    behind homebrew "the formula is at $got"
  else
    result homebrew fail "Formula/dorkos.rb names no dorkos tarball"
  fi
}

check_download() {
  local v=$1 p line code url i got exes
  for p in mac windows; do
    for ((i = 1; i <= 3; i++)); do
      line=$("$CURL" -sS -o /dev/null --max-time 30 -w '%{http_code} %{redirect_url}' "$SITE/download/$p" 2>/dev/null) || line="000 "
      read -r code url <<<"$line"
      [ "$code" = 302 ] && [[ "${url:-}" == *"/releases/download/v$v/"* ]] && break
      [ "$i" -lt 3 ] && sleep "$RETRY_SLEEP"
    done
    if [ "$code" = 302 ] && [[ "${url:-}" == *"/releases/download/v$v/"* ]]; then
      result "download/$p" pass "302 to v$v"
    elif [ "$code" != 302 ]; then
      result "download/$p" fail "HTTP $code, not a 302"
    elif [[ "${url:-}" == *"/releases/latest"* ]]; then
      result "download/$p" skip "302 to /releases/latest three times (the site's GitHub lookup was refused)"
    else
      got=$(sed -nE "s#.*/releases/download/v(${SEMVER})/.*#\1#p" <<<"$url")
      if [ "$p" = windows ]; then
        # No .exe on the release (the Windows build is not gating): the link
        # rightly keeps the previous version.
        exes=$("$GH" api "repos/$REPO/releases/tags/v$v" --jq '[.assets[].name | select(endswith(".exe"))] | length' 2>/dev/null) || exes=
        if [ "$exes" = 0 ]; then
          result "download/$p" skip "v$v has no Windows installer, so the link rightly serves an older one"
          continue
        fi
      fi
      behind "download/$p" "302 to $([ -n "$got" ] && echo "v$got" || echo 'another release')"
    fi
  done
}

check_issues() {
  local v=$1 re nums
  re="(^|[^0-9.])v?${v//./[.]}(\$|[^0-9])"
  if ! nums=$("$GH" api --paginate "repos/$REPO/issues?state=all&since=$PUBLISHED_AT&per_page=100" 2>/dev/null |
    jq -rs --arg at "$PUBLISHED_AT" --arg re "$re" --arg label "$LABEL" \
      'add // [] | .[] | select(.pull_request == null and .created_at >= $at and ([.labels[].name] | index($label) | not)
        and (((.title // "") + " " + (.body // "")) | test($re))) | .number' 2>/dev/null); then
    result issues skip "could not list the issues opened since the publish"
    return 0
  fi
  nums=$(grep -E '^[0-9]+$' <<<"$nums" | sort -un | sed 's/^/#/' | paste -sd, - | sed 's/,/, /g')
  if [ -n "$nums" ]; then
    result issues info "opened since the publish and naming $v: $nums"
  else
    result issues info "no issue opened since the publish names $v"
  fi
}

check() {
  local name=$1 v=$2
  is_version "$v" || usage
  case "$name" in
    npx) check_npx "$v" ;;
    npm-view) check_npm_view "$v" ;;
    docker | homebrew | download | issues)
      if [ -z "${PUBLISHED_AT:-}" ]; then
        PUBLISHED_AT=$(published_at "$v") || err "npm has no publish time for dorkos@$v"
      fi
      [[ "$PUBLISHED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || usage
      "check_${name}" "$v"
      ;;
    *) usage ;;
  esac
}

ensure_label() {
  "$GH" api "repos/$REPO/labels/$LABEL" >/dev/null 2>&1 && return 0
  "$GH" api --method POST "repos/$REPO/labels" -f name="$LABEL" -f color=b60205 \
    -f description="A published release failed a release-watch check (DOR-5123)" >/dev/null 2>&1 || true
}

title_for() { printf 'Release watch: v%s %s fails' "$1" "$2"; }

find_issue() {
  "$GH" api --paginate "repos/$REPO/issues?state=open&labels=$LABEL&per_page=100" \
    --jq ".[] | select(.pull_request == null and .title == $(jq -Rn --arg t "$1" '$t')) | .number" |
    head -n 1
}

report() {
  local dir=$1 v=$2 url=$3
  local all plan id st detail groups g failed=0 lines title n body signal labelled=0
  [ -d "$dir" ] && is_version "$v" && [[ "$url" =~ ^https://[A-Za-z0-9./_-]+$ ]] || usage
  # Every result line from every file, kept only when it is well formed and
  # its id is planned.
  plan=$(checks_plan)
  # Files in a fixed order (find's order differs between Linux and macOS).
  all=$(find "$dir" -type f \( -name '*.json' -o -name '*.jsonl' \) -print 2>/dev/null | LC_ALL=C sort |
    while IFS= read -r f; do cat "$f"; done |
    jq -cR 'fromjson? | select(type == "object" and (.check | type) == "string" and (.status | IN("pass","fail","skip","info")) and (.detail | type) == "string")' 2>/dev/null |
    jq -sc --arg plan "$plan" '($plan | split("\n")) as $p | map(select(.check as $c | $p | index($c)))')
  [ -n "$all" ] || all='[]'
  for id in $plan; do
    jq -e --arg c "$id" 'any(.[]; .check == $c)' <<<"$all" >/dev/null ||
      all=$(jq -c --arg c "$id" '. + [{check: $c, status: "fail", detail: "no result: its job did not finish"}]' <<<"$all")
  done

  echo "### Release watch: v$v"
  echo
  echo "| Check | Status | Detail |"
  echo "|---|---|---|"
  jq -r 'sort_by(.check) | .[] | "| `\(.check)` | \(.status) | \(.detail | gsub("\\|"; "/")) |"' <<<"$all"
  echo
  echo "Run: $url"

  signal=$(jq -r '[.[] | select(.check == "issues") | .detail] | first // ""' <<<"$all")
  groups=$(jq -r '[.[] | select(.check != "issues") | .check | split("/")[0]] | unique | .[]' <<<"$all")
  for g in $groups; do
    st=$(jq -r --arg g "$g" '[.[] | select((.check | split("/")[0]) == $g) | .status] |
      if any(. == "fail") then "fail" elif any(. == "pass") then "pass" else "skip" end' <<<"$all")
    title=$(title_for "$v" "$g")
    case "$st" in
      fail)
        failed=1
        lines=$(jq -r --arg g "$g" '.[] | select((.check | split("/")[0]) == $g and .status == "fail") | "- `\(.check)`: \(.detail)"' <<<"$all")
        [ "$labelled" = 1 ] || { ensure_label; labelled=1; }
        n=$(find_issue "$title") || err "could not list the open $LABEL issues"
        if [ -n "$n" ]; then
          "$GH" api --method POST "repos/$REPO/issues/$n/comments" -f body="Still failing: $url

$lines" >/dev/null || err "could not update #$n"
          echo "Updated #$n: $title" >&2
        else
          body="v$v, published to npm, fails the release watch's \`$g\` check.

$lines

Run: $url
${signal:+
Issues: $signal
}
The watch runs hourly for 24 hours after the publish (\`release-watch.yml\`, DOR-5123). This issue closes itself when \`$g\` passes again for v$v. To roll back: \`gh workflow run daily-release.yml -f action=rollback -f bad_version=$v\`."
          n=$("$GH" api --method POST "repos/$REPO/issues" -f title="$title" -f body="$body" \
            -f "labels[]=$LABEL" --jq .number) || err "could not open an issue for $title"
          echo "Opened #$n: $title" >&2
        fi
        ;;
      pass)
        n=$(find_issue "$title") || err "could not list the open $LABEL issues"
        if [ -n "$n" ]; then
          "$GH" api --method POST "repos/$REPO/issues/$n/comments" -f body="Passes again: $url" >/dev/null ||
            err "could not comment on #$n"
          "$GH" api --method PATCH "repos/$REPO/issues/$n" -f state=closed -f state_reason=completed >/dev/null ||
            err "could not close #$n"
          echo "Closed #$n: $title" >&2
        fi
        ;;
    esac
  done
  return "$failed"
}

case "${1:-}" in
  due) shift; due "$@" ;;
  checks-plan) [ $# -eq 1 ] || usage; checks_plan ;;
  check) [ $# -eq 3 ] || usage; check "$2" "$3" ;;
  report) [ $# -eq 4 ] || usage; report "$2" "$3" "$4" ;;
  *) usage ;;
esac
