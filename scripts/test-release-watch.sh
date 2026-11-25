#!/usr/bin/env bash
# shellcheck disable=SC2016 # the backticks are the issue's and summary's Markdown
# Fixture suite for scripts/release-watch.sh (DOR-5123, design §6 "Watch").
# Stubbed gh, npm, npx, docker and curl (GH=..., NPM=..., ...) answer from
# fixture files and log every call, so writes can be asserted. gh applies the
# script's own --jq filter. Needs bash and jq.
#
#   bash scripts/test-release-watch.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/release-watch.sh
tmp=$(mktemp -d -t release-watch-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
fx=$tmp/fx
mkdir -p "$fx"
pass=0
fail=0

# gh: reads map to fixture files; writes are logged and answer {"number": 900}.
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$LOG"
# Print a --jq result the way gh does: a string raw, a null as an empty line
# (`jq -r` alone prints "null"), anything else as compact JSON.
gh_jq() {
  jq -rc "($1
) | if . == null then \"\" else . end" "${@:2}"
}
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}
done
case "$*" in
  *"--method"*) echo '{"number":900}' | gh_jq "$filter"; exit 0 ;;
  *"/actions/artifacts?"*) f=artifacts ;;
  *"/actions/runs/"*) f=run-$(sed -n 's#.*/actions/runs/\([0-9]*\).*#\1#p' <<<"$*") ;;
  *"/releases/tags/"*) f=release ;;
  *"/issues?state=all"*) f=all-issues ;;
  *"/issues?"*) f=issues ;;
  *"/labels/"*) f=label ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
[ -f "$FX/$f" ] || exit 1
gh_jq "$filter" "$FX/$f"
EOF
# npm: `view dorkos dist-tags.latest`, `view dorkos time --json`, `view <pkg>@<v> version`.
cat >"$tmp/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$LOG"
case "$*" in
  "view dorkos dist-tags.latest") [ -f "$FX/latest" ] && cat "$FX/latest" || exit 1 ;;
  "view dorkos time --json") [ -f "$FX/time" ] && cat "$FX/time" || exit 1 ;;
  "view "*" version")
    spec=${2}
    grep -qxF -- "$spec" "$FX/npm-has" 2>/dev/null && echo "${spec##*@}" || exit 1
    ;;
  *) exit 1 ;;
esac
EOF
cat >"$tmp/npx" <<'EOF'
#!/usr/bin/env bash
printf 'npx %s cache=%s\n' "$*" "${npm_config_cache:-}" >>"$LOG"
cat "$FX/npx-out" 2>/dev/null
exit "$(cat "$FX/npx-rc" 2>/dev/null || echo 0)"
EOF
cat >"$tmp/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$LOG"
case "$1" in
  manifest) [ -f "$FX/docker-manifest" ] ;;
  pull) [ ! -f "$FX/docker-pull-fails" ] ;;
  run) echo cid123 ;;
  rm) exit 0 ;;
esac
EOF
# curl: the health probe, the formula, and the download links.
cat >"$tmp/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$LOG"
case "$*" in
  *"/api/health"*) [ -f "$FX/healthy" ] ;;
  *"Formula/dorkos.rb"*) [ -f "$FX/formula" ] && cat "$FX/formula" ;;
  *"/download/mac"*) cat "$FX/dl-mac" ;;
  *"/download/windows"*) cat "$FX/dl-windows" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp/gh" "$tmp/npm" "$tmp/npx" "$tmp/docker" "$tmp/curl"
export GH="$tmp/gh" NPM="$tmp/npm" NPX="$tmp/npx" DOCKER="$tmp/docker" CURL="$tmp/curl"
export LOG="$tmp/log" FX=$fx REPO=made-up/repo RETRY_SLEEP=0 HEALTH_SLEEP=0 HEALTH_TRIES=3
export NOW=2026-11-24T12:00:00Z RUNNER_TEMP=$tmp
unset RELEASE_WATCH_SURFACES PUBLISHED_AT GITHUB_REPOSITORY

V=0.141.0
URL=https://example.invalid/run/5
GOOD='{"check":"npx/linux","status":"pass","detail":"printed 0.141.0"}'
reset() {
  rm -rf "$fx" "$tmp/results"
  mkdir -p "$fx" "$tmp/results"
  echo "$V" >"$fx/latest"
  # Published 2 h before NOW.
  echo '{"0.140.1":"2026-11-22T12:44:15.987Z","0.141.0":"2026-11-24T10:00:00.123Z"}' >"$fx/time"
  echo '{"artifacts":[]}' >"$fx/artifacts"
  echo '[]' >"$fx/issues"
  echo '[]' >"$fx/all-issues"
  echo '{"name":"release-watch"}' >"$fx/label"
  printf '%s\n' "dorkos@$V" "@dork-labs/cloud-api@$V" "@dork-labs/connector-providers@$V" >"$fx/npm-has"
}
artifact() { # <run-id> <created-at> [head-branch] [head-repo-id]
  jq -n --argjson id "$1" --arg at "$2" --arg b "${3:-main}" --argjson hr "${4:-1}" \
    '{artifacts: [{created_at: $at, workflow_run: {id: $id, head_branch: $b, head_repository_id: $hr, repository_id: 1}}]}' >"$fx/artifacts"
}
run_file() { # <run-id> <path> [head-branch]
  jq -n --arg p "$2" --arg b "${3:-main}" '{path: $p, head_branch: $b}' >"$fx/run-$1"
}
# Every planned id passing, except those named in $1 (space-separated ids).
all_pass_but() {
  local id
  for id in $(bash "$SCRIPT" checks-plan); do
    case " ${1:-} " in *" $id "*) continue ;; esac
    jq -cn --arg c "$id" '{check: $c, status: (if $c == "issues" then "info" else "pass" end), detail: "ok"}'
  done >"$tmp/results/a.jsonl"
}
out=""
rc=0
run() {
  : >"$LOG"
  out=$("$SCRIPT" "$@" 2>&1)
  rc=$?
}
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }
log() { cat "$LOG"; }
count() { grep -cF -- "$1" "$LOG"; }

# --- due ---------------------------------------------------------------------
reset
run due
check 'a release 2 h old, never watched: due' "DUE $V 2026-11-24T10:00:00Z release-watch-$V" "$out"
check 'due exits 0' 0 "$rc"

reset
echo '{"0.141.0":"2026-11-23T11:00:00Z"}' >"$fx/time"
run due
check 'no release in the last 24 h: not due' yes "$(has "$out" "NOT_DUE $V was published 1500 min ago")"
check 'no release in 24 h: no GitHub call at all' 0 "$(count 'gh ')"

reset
artifact 71 2026-11-24T11:40:00Z
run_file 71 .github/workflows/release-watch.yml
run due
check 'watched 20 min ago: not due' yes "$(has "$out" "NOT_DUE run 71 watched $V 20 min ago")"

reset
artifact 72 2026-11-24T10:55:00Z
run_file 72 .github/workflows/release-watch.yml
run due
check 'watched 65 min ago: due again' yes "$(has "$out" "DUE $V")"

reset
artifact 73 2026-11-24T11:40:00Z some-pr-branch
run_file 73 .github/workflows/release-watch.yml some-pr-branch
run due
check "a pull request's marker does not count" yes "$(has "$out" "DUE $V")"

reset
artifact 74 2026-11-24T11:40:00Z main 2
run_file 74 .github/workflows/release-watch.yml
run due
check "a fork's marker does not count" yes "$(has "$out" "DUE $V")"

reset
artifact 75 2026-11-24T11:40:00Z
run_file 75 .github/workflows/other.yml
run due
check "another workflow's marker does not count" yes "$(has "$out" "DUE $V")"

reset
artifact 76 2026-11-24T11:40:00Z
run_file 76 .github/workflows/release-watch.yml
run due --gap 0
check 'after Release Publish (--gap 0): due at once' yes "$(has "$out" "DUE $V")"
check '--gap 0 reads no artifacts' 0 "$(count 'actions/artifacts')"

reset
echo '{"0.140.1":"2026-11-20T12:44:15Z"}' >"$fx/time"
run due 0.140.1
check 'a dispatch with a version: due whatever its age' "DUE 0.140.1 2026-11-20T12:44:15Z release-watch-0.140.1" "$out"

reset
run due 9.9.9
check 'a dispatch for a version npm lacks: exit 2' 2 "$rc"
run due 'v1.2.3'
check 'a dispatch with a malformed version: exit 2' 2 "$rc"

reset
rm "$fx/latest"
run due
check 'npm unreadable: exit 2' 2 "$rc"

reset
echo '{"message":"boom"}' >"$fx/artifacts"
mv "$fx/artifacts" "$fx/artifacts.bak"
run due
check 'artifacts unreadable: exit 2' 2 "$rc"

# --- report ------------------------------------------------------------------
reset
all_pass_but npx/windows
echo '{"check":"npx/windows","status":"fail","detail":"printed no version (exit 1)"}' >"$tmp/results/b.json"
run report "$tmp/results" "$V" "$URL"
check 'a failure: exit 1' 1 "$rc"
check 'a failure opens one issue' 1 "$(count 'repos/made-up/repo/issues -f title=')"
check 'titled by version and group' yes "$(has "$(log)" "title=Release watch: v$V npx fails")"
check 'labelled release-watch' yes "$(has "$(log)" 'labels[]=release-watch')"
check 'the body names the failing check and the run' yes "$(has "$(log)" "\`npx/windows\`: printed no version (exit 1)")"
check 'the body carries the run link' yes "$(has "$(log)" "Run: $URL")"
check 'the summary is a table' yes "$(has "$out" '| `npx/windows` | fail | printed no version (exit 1) |')"
check 'passing groups write nothing' 0 "$(count 'state=closed')"

reset
echo '[{"number":40,"title":"Release watch: v0.141.0 npx fails"}]' >"$fx/issues"
all_pass_but npx/windows
echo '{"check":"npx/windows","status":"fail","detail":"printed no version (exit 1)"}' >"$tmp/results/b.json"
run report "$tmp/results" "$V" "$URL"
check 'a second failure updates the open issue' yes "$(has "$(log)" 'api --method POST repos/made-up/repo/issues/40/comments')"
check 'and opens no second issue' 0 "$(count 'repos/made-up/repo/issues -f title=')"
check 'second failure: still exit 1' 1 "$rc"

reset
echo '[{"number":41,"title":"Release watch: v0.141.0 npx fails","pull_request":{}}]' >"$fx/issues"
all_pass_but npx/windows
echo '{"check":"npx/windows","status":"fail","detail":"x"}' >"$tmp/results/b.json"
run report "$tmp/results" "$V" "$URL"
check 'a PR with the same title is not the group issue' 1 "$(count 'repos/made-up/repo/issues -f title=')"

reset
echo '[{"number":40,"title":"Release watch: v0.141.0 npx fails"}]' >"$fx/issues"
all_pass_but
run report "$tmp/results" "$V" "$URL"
check 'all pass: exit 0' 0 "$rc"
check 'a pass comments on the open issue' yes "$(has "$(log)" "repos/made-up/repo/issues/40/comments -f body=Passes again: $URL")"
check 'and closes it' yes "$(has "$(log)" 'api --method PATCH repos/made-up/repo/issues/40 -f state=closed')"
check 'and opens nothing' 0 "$(count 'issues -f title=')"

reset
echo '[{"number":42,"title":"Release watch: v0.140.1 npx fails"}]' >"$fx/issues"
all_pass_but
run report "$tmp/results" "$V" "$URL"
check "another version's issue stays open" 0 "$(count 'state=closed')"

reset
all_pass_but
run report "$tmp/results" "$V" "$URL"
check 'all pass, nothing open: no write at all' 0 "$(count 'api --method')"

reset
all_pass_but docker
run report "$tmp/results" "$V" "$URL"
check 'a planned check with no result fails' 1 "$rc"
check 'it is named as no result' yes "$(has "$(log)" '`docker`: no result: its job did not finish')"

reset
all_pass_but homebrew
echo '{"check":"homebrew","status":"skip","detail":"the formula is at 0.140.1; this surface does not ship daily yet"}' >"$tmp/results/b.json"
echo '[{"number":43,"title":"Release watch: v0.141.0 homebrew fails"}]' >"$fx/issues"
run report "$tmp/results" "$V" "$URL"
check 'a skipped group: exit 0' 0 "$rc"
check 'a skipped group opens nothing' 0 "$(count 'issues -f title=')"
check 'and does not close its issue' 0 "$(count 'state=closed')"

reset
all_pass_but 'download/windows issues'
{
  echo 'not json at all'
  echo '{"check":"download/windows","status":"fail","detail":"HTTP 500, not a 302"}'
  echo '{"check":"made-up","status":"fail","detail":"x"}'
} >"$tmp/results/b.jsonl"
echo '{"check":"issues","status":"info","detail":"opened since the publish and naming 0.141.0: #7"}' >"$tmp/results/a.jsonl.extra.json"
run report "$tmp/results" "$V" "$URL"
check 'a bad line is skipped, the rest still read' yes "$(has "$(log)" '`download/windows`: HTTP 500, not a 302')"
check 'an unplanned id is ignored' 1 "$(count 'issues -f title=')"
check 'the issue signal goes in the body' yes "$(has "$(log)" 'Issues: opened since the publish and naming 0.141.0: #7')"

reset
rm "$fx/issues"
all_pass_but npx/linux
echo '{"check":"npx/linux","status":"fail","detail":"x"}' >"$tmp/results/b.json"
run report "$tmp/results" "$V" "$URL"
check 'issues unreadable: exit 2' 2 "$rc"

reset
run report "$tmp/results" "$V" 'not a url'
check 'report: a bad run link is usage' 2 "$rc"

# --- check -------------------------------------------------------------------
reset
echo "$V" >"$fx/npx-out"
RUNNER_OS=Linux run check npx "$V"
check 'npx prints the version: pass' "$GOOD" "$out"
check 'npx runs from a clean cache' yes "$(has "$(log)" "cache=$tmp/release-watch-npx.")"

reset
printf 'some warning\r\n0.140.1\r\n' >"$fx/npx-out"
RUNNER_OS=macOS run check npx "$V"
check 'npx prints another version: fail, naming it' '{"check":"npx/macos","status":"fail","detail":"printed 0.140.1, not 0.141.0 (exit 0)"}' "$out"

reset
printf 'Error: secret log text\n' >"$fx/npx-out"
echo 1 >"$fx/npx-rc"
RUNNER_OS=Linux run check npx "$V"
check 'npx output never reaches the detail' no "$(has "$out" 'secret')"
check 'npx with no version: fail' '{"check":"npx/linux","status":"fail","detail":"printed no version (exit 1)"}' "$out"

reset
printf '%s\n' "dorkos@$V" "@dork-labs/cloud-api@$V" >"$fx/npm-has"
run check npm-view "$V"
check 'npm view: two pass' 2 "$(grep -c '"status":"pass"' <<<"$out")"
check 'npm view: the missing package fails' yes "$(has "$out" '{"check":"npm-view/connector-providers","status":"fail"')"

reset
printf 'class Dorkos < Formula\n  url "https://registry.npmjs.org/dorkos/-/dorkos-%s.tgz"\nend\n' "$V" >"$fx/formula"
run check homebrew "$V"
check 'homebrew at the version: pass' '{"check":"homebrew","status":"pass","detail":"the formula is at 0.141.0"}' "$out"

reset
printf '  url "https://registry.npmjs.org/dorkos/-/dorkos-0.140.1.tgz"\n' >"$fx/formula"
echo '{"0.141.0":"2026-11-24T06:00:00Z"}' >"$fx/time"
run check homebrew "$V"
check 'homebrew behind, not daily yet: skip' yes "$(has "$out" '"status":"skip","detail":"the formula is at 0.140.1; this surface does not ship daily yet"')"
RELEASE_WATCH_SURFACES=daily run check homebrew "$V"
check 'homebrew behind, daily, past the grace: fail' '{"check":"homebrew","status":"fail","detail":"the formula is at 0.140.1"}' "$out"
echo '{"0.141.0":"2026-11-24T11:00:00Z"}' >"$fx/time"
RELEASE_WATCH_SURFACES=daily run check homebrew "$V"
check 'homebrew behind, daily, within the grace: skip' yes "$(has "$out" 'within 180 min of the npm publish')"

reset
run check homebrew "$V"
check 'homebrew unreadable: fail' '{"check":"homebrew","status":"fail","detail":"Formula/dorkos.rb could not be read"}' "$out"

reset
run check docker "$V"
check 'no docker image, not daily: skip' yes "$(has "$out" '"check":"docker","status":"skip","detail":"no image ghcr.io/dork-labs/dorkos:0.141.0')"
check 'no image: nothing pulled' 0 "$(count 'docker pull')"

reset
touch "$fx/docker-manifest" "$fx/healthy"
run check docker "$V"
check 'docker image healthy: pass' '{"check":"docker","status":"pass","detail":"ghcr.io/dork-labs/dorkos:0.141.0 answers /api/health"}' "$out"
check 'the container is removed' 1 "$(count 'docker rm -f cid123')"

reset
touch "$fx/docker-manifest"
run check docker "$V"
check 'docker image unhealthy: fail' yes "$(has "$out" '"status":"fail","detail":"ghcr.io/dork-labs/dorkos:0.141.0 did not answer /api/health in 0 s"')"
check 'the unhealthy container is removed too' 1 "$(count 'docker rm -f cid123')"

reset
touch "$fx/docker-manifest" "$fx/docker-pull-fails"
run check docker "$V"
check 'docker pull fails: fail even when not daily' yes "$(has "$out" '"status":"fail","detail":"ghcr.io/dork-labs/dorkos:0.141.0 did not pull"')"

reset
echo "302 https://github.com/dork-labs/dorkos/releases/download/v$V/DorkOS-$V-arm64.dmg" >"$fx/dl-mac"
echo "302 https://github.com/dork-labs/dorkos/releases/download/v$V/DorkOS-$V-x64.exe" >"$fx/dl-windows"
run check download "$V"
check 'both links at the version: two passes' 2 "$(grep -c '"status":"pass","detail":"302 to v0.141.0"' <<<"$out")"
check 'a pass is not retried' 2 "$(count 'curl ')"

reset
echo '{"0.141.0":"2026-11-24T06:00:00Z"}' >"$fx/time"
echo "302 https://github.com/dork-labs/dorkos/releases/download/v0.140.1/DorkOS-0.140.1-arm64.dmg" >"$fx/dl-mac"
echo "302 https://github.com/dork-labs/dorkos/releases/download/v0.140.1/DorkOS-0.140.1-x64.exe" >"$fx/dl-windows"
echo '{"assets":[{"name":"DorkOS-0.141.0-arm64.dmg"}]}' >"$fx/release"
RELEASE_WATCH_SURFACES=daily run check download "$V"
check 'mac link behind, daily, past the grace: fail' yes "$(has "$out" '{"check":"download/mac","status":"fail","detail":"302 to v0.140.1"}')"
check 'a link behind is tried three times' 6 "$(count 'curl ')"
check 'windows behind with no .exe on the release: skip' yes "$(has "$out" '{"check":"download/windows","status":"skip"')"

reset
echo '000 ' >"$fx/dl-mac"
echo "302 https://github.com/dork-labs/dorkos/releases/latest" >"$fx/dl-windows"
run check download "$V"
check 'a link that does not 302: fail' yes "$(has "$out" '{"check":"download/mac","status":"fail","detail":"HTTP 000, not a 302"}')"
check 'a fallback to /releases/latest: skip' yes "$(has "$out" '{"check":"download/windows","status":"skip"')"

reset
cat >"$fx/all-issues" <<'EOF'
[
  {"number": 7, "title": "Crash on 0.141.0 start", "body": "", "created_at": "2026-11-24T11:00:00Z", "labels": []},
  {"number": 8, "title": "Old", "body": "seen in v0.141.0", "created_at": "2026-11-24T09:00:00Z", "labels": []},
  {"number": 9, "title": "A PR", "body": "0.141.0", "created_at": "2026-11-24T11:00:00Z", "labels": [], "pull_request": {}},
  {"number": 10, "title": "Release watch: v0.141.0 npx fails", "body": "", "created_at": "2026-11-24T11:00:00Z", "labels": [{"name": "release-watch"}]},
  {"number": 11, "title": "Unrelated 10.141.01", "body": null, "created_at": "2026-11-24T11:00:00Z", "labels": []},
  {"number": 12, "title": "Install fails", "body": "dorkos v0.141.0 on Windows", "created_at": "2026-11-24T11:30:00Z", "labels": []}
]
EOF
run check issues "$V"
check 'issues naming the version since publish are listed, others not' '{"check":"issues","status":"info","detail":"opened since the publish and naming 0.141.0: #7, #12"}' "$out"

reset
rm "$fx/all-issues"
run check issues "$V"
check 'issues unreadable: a skip, never a fail' yes "$(has "$out" '"check":"issues","status":"skip"')"

reset
run check npx v0.141.0
check 'check: a malformed version is usage' 2 "$rc"
run check nope "$V"
check 'check: an unknown check is usage' 2 "$rc"

run checks-plan
check 'checks-plan lists eleven ids' 11 "$(grep -c . <<<"$out")"

echo "release-watch: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
