#!/usr/bin/env bash
# shellcheck disable=SC2016 # the summary checks look for literal backticks
# Fixture suite for scripts/daily-release.sh (DOR-5123). `decide` and `summary`
# are pure; `facts` and `pick` run against a stubbed `gh`, `npm` and release
# gate that answer from fixture files and log every call; `commits` runs on a
# throwaway git repo. Needs bash, git and jq.
#
#   bash scripts/test-daily-release.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/daily-release.sh
tmp=$(mktemp -d -t daily-release-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=cccccccccccccccccccccccccccccccccccccccc
D=dddddddddddddddddddddddddddddddddddddddd

out=""
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}
# contains <name> <needle> <haystack>
contains() {
  if grep -qF -- "$2" <<<"$3"; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        missing: %s\n' "$1" "$2" >&2
  fi
}

# --- decide: base facts (nothing in flight), then jq edits ---
d() {
  jq -n '{now: "2026-11-24T15:00:00Z", action: "cut", hold: "", mainVersion: "0.141.0",
    previous: "0.141.0", unreadable: [], inflight: null}' | jq "${1:-.}" >"$tmp/f.json"
  out=$("$SCRIPT" decide "$tmp/f.json" 2>&1)
}
# i <in-flight edit> [<top-level edit>]: one release in flight, its PR merged
# and everything after it done up to an open back-merge.
i() {
  d ".inflight = {version: \"0.142.0\", branchSha: \"$B\", base: \"$A\", pr: \"merged\", prNumber: 9,
    tag: true, artifact: \"success\", onNpm: true, ghRelease: true, backmerge: \"open\", publishInFlight: false}
    | .inflight |= ($1) | ${2:-.}"
}

d
check 'nothing in flight, no hold: cut' CUT "$out"
d '.hold = "fixing the login bug"'
check 'a hold stops the cut' 'WAIT DAILY_RELEASE_HOLD is set: fixing the login bug' "$out"
d '.mainVersion = "0.142.0"'
check 'main VERSION ahead of the latest release: a hand release is running' \
  'WAIT main VERSION 0.142.0 is not the latest release v0.141.0 (a release by hand is in progress)' "$out"
d '.holdIssue = {number: 77, title: "Release hold: v0.142.0 was rolled back"}'
check 'an open release-hold issue stops the cut' 'WAIT the release-hold issue #77 is open: Release hold: v0.142.0 was rolled back' "$out"
d '.holdIssue = null'
check 'hold cleared (no open release-hold issue): the cut proceeds' CUT "$out"
d '.action = "merge"'
check 'an unknown action is refused' 'REFUSE unknown action merge' "$out"
d '.action = "advance"'
check 'advance with nothing in flight does nothing' 'NONE no release in flight' "$out"
d '.unreadable = ["latest release", "npm"]'
check 'a failed read refuses' 'REFUSE unreadable: latest release, npm' "$out"
d 'del(.unreadable)'
check 'no unreadable list refuses' 'REFUSE unreadable: facts' "$out"
d '.action = "rollback" | .unreadable = ["x"]'
check 'unreadable comes before anything else' 'REFUSE unreadable: x' "$out"

# --- decide: rollback (design §6). 0.142.0 is the newest on npm; 0.141.0, the
# release before it, is one release commit on top of P_prev = $A. ---
r() {
  d ".action = \"rollback\" | .mainVersion = \"0.142.0\" | .previous = \"0.142.0\"
    | .rollback = {bad: \"0.142.0\", newest: \"0.142.0\", prev: \"0.141.0\", pPrev: \"$A\", aheadBy: 1} | ${1:-.}"
}
r
check 'rollback of the newest version: cut at P_prev' "ROLLBACK 0.142.0 0.141.0 $A" "$out"
r '.hold = "x" | .holdIssue = {number: 1, title: "t"}'
check 'a hold never stops the rollback itself' "ROLLBACK 0.142.0 0.141.0 $A" "$out"
r '.rollback.bad = "0.141.0"'
check 'bad_version not the newest: refuse' \
  'REFUSE 0.141.0 is not the newest published version (npm has 0.142.0); only the newest can be rolled back' "$out"
r '.rollback.bad = "" | .rollback.newest = "0.142.0"'
check 'no bad_version: refuse' 'REFUSE a rollback needs bad_version as X.Y.Z; got ""' "$out"
r '.rollback.bad = "v0.142.0"'
check 'bad_version must be plain X.Y.Z' 'REFUSE a rollback needs bad_version as X.Y.Z; got "v0.142.0"' "$out"
r '.rollback.prev = ""'
check 'nothing published before it: refuse' 'REFUSE npm has no version before 0.142.0 to roll back to' "$out"
r '.rollback.pPrev = ""'
check 'unknown P_prev: refuse' \
  'REFUSE the commit v0.141.0 was cut at is unknown (no tag v0.141.0, or GitHub could not compare it with main)' "$out"
r '.rollback.aheadBy = 3'
check 'v<prev> is not one release commit on main (a hand hotfix): refuse' \
  'REFUSE v0.141.0 is 3 commits ahead of main, not one release commit on top of it, so main cannot rebuild it; roll back by hand' "$out"
r ".inflight = {version: \"0.142.0\", branchSha: \"$B\", base: \"$C\", pr: \"merged\", prNumber: 9, tag: true,
  artifact: \"success\", onNpm: true, ghRelease: false, backmerge: \"none\", publishInFlight: false}"
check 'the bad release still in flight (no back-merge yet): roll back anyway' "ROLLBACK 0.142.0 0.141.0 $A" "$out"
r ".inflight = {version: \"0.142.1\", branchSha: \"$B\", base: \"$A\", pr: \"open\", prNumber: 10, tag: false,
  artifact: \"none\", onNpm: false, ghRelease: false, backmerge: \"none\", publishInFlight: false}"
check 'a newer release in flight (this rollback, cut already): refuse a second cut' \
  'REFUSE release v0.142.1 is in flight; a rollback cuts only when nothing newer than v0.142.0 is (if it is this rollback, it advances on its own)' "$out"
r 'del(.rollback)'
check 'rollback with no rollback facts: refuse' 'REFUSE a rollback needs bad_version as X.Y.Z; got ""' "$out"

i '.pr = "open"'
check 'release PR open: wait' 'WAIT the release PR #9 for v0.142.0 is open' "$out"
i '.pr = "none"'
check 'branch with no release PR: wait for a person' \
  'WAIT release/v0.142.0 has no merged release PR (cut by hand, or a cut that stopped half way)' "$out"
i '.tag = false'
check 'PR merged, no tag: tag' 'TAG 0.142.0' "$out"
i '.tag = false' '.action = "advance"'
check 'advance moves a release in flight' 'TAG 0.142.0' "$out"
i '.tag = false' '.hold = "x"'
check 'a hold stops new cuts, not a release in flight' 'TAG 0.142.0' "$out"
i '.onNpm = false'
check 'tagged, artifact green, not on npm: publish' 'PUBLISH 0.142.0' "$out"
i '.onNpm = false | .publishInFlight = true'
check 'a publish already running: wait' 'WAIT a Release Publish run is in progress' "$out"
i '.onNpm = false | .artifact = "pending"'
check 'artifact still building: wait' 'WAIT the native artifact build for v0.142.0 is running' "$out"
i '.onNpm = false | .artifact = "none"'
check 'no artifact run yet: wait' 'WAIT no native artifact run for v0.142.0 yet' "$out"
i '.onNpm = false | .artifact = "failure"'
check 'artifact failed: refuse, never publish' 'REFUSE the native artifact build for v0.142.0 concluded failure' "$out"
i '.ghRelease = false'
check 'on npm, no GitHub release: surfaces' 'SURFACES 0.142.0' "$out"
i '.backmerge = "none"'
check 'released, no back-merge: back-merge' 'BACKMERGE 0.142.0' "$out"
i '.'
check 'back-merge open: wait' 'WAIT the v0.142.0 back-merge PR is open' "$out"

echo 'not json' >"$tmp/f.json"
"$SCRIPT" decide "$tmp/f.json" >/dev/null 2>&1
check 'unreadable facts: exit 2' 2 "$?"

# --- facts, through a stubbed gh and npm ---
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}; done
case "$*" in
  *"/contents/VERSION"*) f=version ;;
  *"/releases/latest"*) f=latest ;;
  *"/matching-refs/heads/release/v"*) f=branches ;;
  *"/matching-refs/tags/"*) f=tags ;;
  *"/compare/main...v"*) f=comparetag ;;
  *"/compare/main..."*) f=compare ;;
  *"/issues?"*) f=holds ;;
  *"/pulls?state=all&base="*) f=releaseprs ;;
  *"/pulls?state=all&head="*) f=backmerge ;;
  *"browser-native-release-artifact.yml/runs"*) f=artifact ;;
  *"release-publish.yml/runs"*) f=publish ;;
  *"/releases?"*) f=releases ;;
  *"/commits?sha=main"*) f=commits ;;
  *"browser-test.yml/runs"*) f=fullruns ;;
  *) exit 1 ;;
esac
[ -f "$FX/$f" ] || exit 1
jq -r "$filter" "$FX/$f"
EOF
cat >"$tmp/npm" <<'EOF'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >>"$GH_LOG"
if [ "$*" = 'view dorkos versions --json' ]; then
  [ -f "$FX/npmversions" ] || exit 1
  cat "$FX/npmversions"
  exit 0
fi
case "${NPM_ANSWER:-missing}" in
  missing) echo 'npm error code E404' >&2; exit 1 ;;
  broken) echo 'npm error code ECONNRESET' >&2; exit 1 ;;
  *) echo "$NPM_ANSWER" ;;
esac
EOF
chmod +x "$tmp/gh" "$tmp/npm"
mkdir -p "$tmp/fx"
export GH="$tmp/gh" NPM="$tmp/npm" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$tmp/fx NOW=2026-11-24T15:00:00Z
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
fx_base() {
  rm -f "$tmp/fx"/*
  echo "{\"content\":\"$(b64 $'0.141.0\n')\"}" >"$tmp/fx/version"
  echo '{"tag_name":"v0.141.0"}' >"$tmp/fx/latest"
  echo '[]' >"$tmp/fx/holds"
  echo "[{\"ref\":\"refs/heads/release/v0.140.1\",\"object\":{\"sha\":\"$C\"}},{\"ref\":\"refs/heads/release/v0.141.0\",\"object\":{\"sha\":\"$D\"}}]" >"$tmp/fx/branches"
}
facts() {
  : >"$GH_LOG"
  "$SCRIPT" facts >"$tmp/facts.json" 2>"$tmp/err"
}

fx_base
facts
check 'facts exits 0' 0 "$?"
check 'old release branches are not in flight' null "$(jq -c .inflight "$tmp/facts.json")"
check 'main VERSION read and trimmed' 0.141.0 "$(jq -r .mainVersion "$tmp/facts.json")"
check 'previous is the latest release, without v' 0.141.0 "$(jq -r .previous "$tmp/facts.json")"
check 'action defaults to cut' cut "$(jq -r .action "$tmp/facts.json")"
check 'facts end to end: cut' CUT "$("$SCRIPT" decide "$tmp/facts.json")"
check 'nothing in flight: no in-flight reads' no "$(grep -qE 'compare|npm' "$GH_LOG" && echo yes || echo no)"

# One release in flight: the newest branch above main VERSION.
echo "[{\"ref\":\"refs/heads/release/v0.141.0\",\"object\":{\"sha\":\"$D\"}},{\"ref\":\"refs/heads/release/v0.142.0\",\"object\":{\"sha\":\"$B\"}},{\"ref\":\"refs/heads/release/v0.141.1\",\"object\":{\"sha\":\"$C\"}},{\"ref\":\"refs/heads/release/vbogus\",\"object\":{\"sha\":\"$C\"}}]" >"$tmp/fx/branches"
echo "{\"merge_base_commit\":{\"sha\":\"$A\"}}" >"$tmp/fx/compare"
echo '[{"number":8,"state":"closed","merged_at":null},{"number":9,"state":"closed","merged_at":"2026-11-24T15:20:00Z"}]' >"$tmp/fx/releaseprs"
echo '[]' >"$tmp/fx/tags"
echo '{"workflow_runs":[]}' >"$tmp/fx/artifact"
echo '{"workflow_runs":[{"status":"completed"}]}' >"$tmp/fx/publish"
echo '[{"tag_name":"v0.141.0"}]' >"$tmp/fx/releases"
echo '[]' >"$tmp/fx/backmerge"
facts
check 'the newest release branch above main is in flight' 0.142.0 "$(jq -r .inflight.version "$tmp/facts.json")"
check 'its branch sha' "$B" "$(jq -r .inflight.branchSha "$tmp/facts.json")"
check 'its base is the merge base with main' "$A" "$(jq -r .inflight.base "$tmp/facts.json")"
check 'a merged release PR is found among closed ones' 'merged 9' "$(jq -r '"\(.inflight.pr) \(.inflight.prNumber)"' "$tmp/facts.json")"
check 'npm E404 is not on npm, not unreadable' 'false []' "$(jq -c '"\(.inflight.onNpm) \(.unreadable)"' -r "$tmp/facts.json")"
check 'in flight, no tag: tag' 'TAG 0.142.0' "$("$SCRIPT" decide "$tmp/facts.json")"
check 'facts makes no write call' no "$(grep -qE -- '--method|-X |-f ' "$GH_LOG" && echo yes || echo no)"

echo '[{"ref":"refs/tags/v0.142.0"}]' >"$tmp/fx/tags"
echo '{"workflow_runs":[{"created_at":"2026-11-24T15:30:00Z","status":"completed","conclusion":"failure"},{"created_at":"2026-11-24T16:00:00Z","status":"completed","conclusion":"success"}]}' >"$tmp/fx/artifact"
facts
check 'the newest artifact run counts' success "$(jq -r .inflight.artifact "$tmp/facts.json")"
check 'tagged and artifact green: publish' 'PUBLISH 0.142.0' "$("$SCRIPT" decide "$tmp/facts.json")"
echo '{"workflow_runs":[{"status":"in_progress"},{"status":"completed"}]}' >"$tmp/fx/publish"
facts
check 'a running publish is seen' 'WAIT a Release Publish run is in progress' "$("$SCRIPT" decide "$tmp/facts.json")"
echo '{"workflow_runs":[{"status":"completed"}]}' >"$tmp/fx/publish"

NPM_ANSWER=0.142.0 facts
check 'on npm, no GitHub release: surfaces' 'SURFACES 0.142.0' "$("$SCRIPT" decide "$tmp/facts.json")"
echo '[{"tag_name":"v0.142.0"}]' >"$tmp/fx/releases"
NPM_ANSWER=0.142.0 facts
check 'released, no back-merge: back-merge' 'BACKMERGE 0.142.0' "$("$SCRIPT" decide "$tmp/facts.json")"
echo '[{"state":"closed","merged_at":null},{"state":"open","merged_at":null}]' >"$tmp/fx/backmerge"
NPM_ANSWER=0.142.0 facts
check 'an open back-merge is seen' open "$(jq -r .inflight.backmerge "$tmp/facts.json")"

NPM_ANSWER=broken facts
check 'an npm error that is not E404 is unreadable' '["npm"]' "$(jq -c .unreadable "$tmp/facts.json")"
check 'and decide refuses on it' 'REFUSE unreadable: npm' "$("$SCRIPT" decide "$tmp/facts.json")"
rm "$tmp/fx/latest"
facts
check 'facts still exits 0 when a read fails' 0 "$?"
check 'a failed read is listed' true "$(jq '.unreadable | index("latest release") != null' "$tmp/facts.json")"
fx_base
echo '{"content":"bm90IGEgdmVyc2lvbg=="}' >"$tmp/fx/version"
facts
check 'a VERSION that is not semver is unreadable' '["main VERSION"]' "$(jq -c .unreadable "$tmp/facts.json")"
ACTION=advance DAILY_RELEASE_HOLD='bad day' facts
check 'ACTION and DAILY_RELEASE_HOLD come from the env' 'advance bad day' "$(jq -r '"\(.action) \(.hold)"' "$tmp/facts.json")"

# The hold a rollback opens: an open issue labelled release-hold.
fx_base
check 'no open release-hold issue: no hold' null "$(facts; jq -c .holdIssue "$tmp/facts.json")"
check 'the hold is read by label, open only' yes "$(grep -qF 'issues?labels=release-hold&state=open' "$GH_LOG" && echo yes || echo no)"
echo '[{"number":77,"title":"Release hold: v0.142.0 was rolled back","body":"x"}]' >"$tmp/fx/holds"
facts
check 'an open release-hold issue is the hold' '{"number":77,"title":"Release hold: v0.142.0 was rolled back"}' "$(jq -c .holdIssue "$tmp/facts.json")"
check 'hold set: the next daily cut waits' 'WAIT the release-hold issue #77 is open: Release hold: v0.142.0 was rolled back' "$("$SCRIPT" decide "$tmp/facts.json")"
echo '[]' >"$tmp/fx/holds"
facts
check 'hold cleared (issue closed): the cut proceeds' CUT "$("$SCRIPT" decide "$tmp/facts.json")"
rm "$tmp/fx/holds"
facts
check 'an unreadable hold refuses rather than cut past it' '["release-hold issues"]' "$(jq -c .unreadable "$tmp/facts.json")"
echo '[]' >"$tmp/fx/holds"
check 'a cut makes no rollback reads' no "$(grep -qE 'versions|compare/main...v' "$GH_LOG" && echo yes || echo no)"

# Rollback facts: npm's versions and the commit the release before was cut at.
echo '["0.140.0","0.141.0-rc.1","0.142.0","0.141.0"]' >"$tmp/fx/npmversions"
echo "{\"merge_base_commit\":{\"sha\":\"$A\"},\"ahead_by\":1}" >"$tmp/fx/comparetag"
echo "{\"content\":\"$(b64 $'0.142.0\n')\"}" >"$tmp/fx/version"
echo '{"tag_name":"v0.142.0"}' >"$tmp/fx/latest"
ACTION=rollback BAD_VERSION=0.142.0 facts
check 'rollback facts: newest and the version before, prereleases skipped' \
  "{\"bad\":\"0.142.0\",\"newest\":\"0.142.0\",\"prev\":\"0.141.0\",\"pPrev\":\"$A\",\"aheadBy\":1}" "$(jq -c .rollback "$tmp/facts.json")"
check 'P_prev is the merge base of tag v<prev> with main' yes "$(grep -qF 'compare/main...v0.141.0' "$GH_LOG" && echo yes || echo no)"
check 'rollback of the newest, end to end: cut at P_prev' "ROLLBACK 0.142.0 0.141.0 $A" "$("$SCRIPT" decide "$tmp/facts.json")"
check 'rollback facts make no write call' no "$(grep -qE -- '--method|-X |-f ' "$GH_LOG" && echo yes || echo no)"
ACTION=rollback BAD_VERSION=0.141.0 facts
check 'bad_version not the newest, end to end: refuse' \
  'REFUSE 0.141.0 is not the newest published version (npm has 0.142.0); only the newest can be rolled back' "$("$SCRIPT" decide "$tmp/facts.json")"
rm "$tmp/fx/comparetag"
ACTION=rollback BAD_VERSION=0.142.0 facts
check 'no tag for the release before (unknown P_prev), end to end: refuse' \
  'REFUSE the commit v0.141.0 was cut at is unknown (no tag v0.141.0, or GitHub could not compare it with main)' "$("$SCRIPT" decide "$tmp/facts.json")"
echo '"0.142.0"' >"$tmp/fx/npmversions"
ACTION=rollback BAD_VERSION=0.142.0 facts
check 'a package with one version has nothing to roll back to' 'REFUSE npm has no version before 0.142.0 to roll back to' "$("$SCRIPT" decide "$tmp/facts.json")"
rm "$tmp/fx/npmversions"
ACTION=rollback BAD_VERSION=0.142.0 facts
check 'npm versions unreadable: refuse' 'REFUSE unreadable: npm versions' "$("$SCRIPT" decide "$tmp/facts.json")"
fx_base

# --- pick, through the stubbed gh and a stub gate ---
cat >"$tmp/gate" <<'EOF'
#!/usr/bin/env bash
printf 'gate %s\n' "$*" >>"$GH_LOG"
case "$1" in
  facts) echo "{\"p\":\"$3\"}"; [ "$3" != "${GATE_UNREADABLE:-}" ] || exit 2 ;;
  decide) p=$(jq -r .p "$2"); grep -qxF "$p" "$FX/ship" && echo SHIP || echo "REFUSE required check typecheck has no merge-queue run on P ${p:0:12}" ;;
esac
EOF
export GATE="$tmp/gate"
# Main, newest first: D, C, B, A. Full runs: D cancelled, C success then a later
# failure, B success, A success.
echo "[{\"sha\":\"$D\"},{\"sha\":\"$C\"},{\"sha\":\"$B\"},{\"sha\":\"$A\"}]" >"$tmp/fx/commits"
echo "{\"workflow_runs\":[
  {\"head_sha\":\"$D\",\"event\":\"push\",\"conclusion\":\"cancelled\",\"created_at\":\"2026-11-24T14:00:00Z\",\"id\":4},
  {\"head_sha\":\"$C\",\"event\":\"push\",\"conclusion\":\"success\",\"created_at\":\"2026-11-24T12:00:00Z\",\"id\":3},
  {\"head_sha\":\"$C\",\"event\":\"schedule\",\"conclusion\":\"failure\",\"created_at\":\"2026-11-24T13:00:00Z\",\"id\":5},
  {\"head_sha\":\"$B\",\"event\":\"push\",\"conclusion\":\"success\",\"created_at\":\"2026-11-24T11:00:00Z\",\"id\":2},
  {\"head_sha\":\"$A\",\"event\":\"merge_group\",\"conclusion\":\"success\",\"created_at\":\"2026-11-24T10:00:00Z\",\"id\":1},
  {\"head_sha\":\"$A\",\"event\":\"push\",\"conclusion\":\"success\",\"created_at\":\"2026-11-24T10:00:00Z\",\"id\":0}]}" >"$tmp/fx/fullruns"
printf '%s\n%s\n' "$B" "$A" >"$tmp/fx/ship"
: >"$GH_LOG"
out=$("$SCRIPT" pick 0.141.0)
check 'the newest commit with a green full run that the gate ships' "P $B" "$out"
check 'a commit whose newest full run failed never reaches the gate' no "$(grep -qF "gate facts 0.141.0 $C" "$GH_LOG" && echo yes || echo no)"
check 'a cancelled full run never reaches the gate' no "$(grep -qF "gate facts 0.141.0 $D" "$GH_LOG" && echo yes || echo no)"
check 'the window starts 48 h back' yes "$(grep -qF 'since=2026-11-22T15:00:00Z' "$GH_LOG" && echo yes || echo no)"
check 'the full runs are read from main, completed, in the window' yes \
  "$(grep -qF 'browser-test.yml/runs?branch=main&status=completed&created=%3E%3D2026-11-22T15:00:00Z' "$GH_LOG" && echo yes || echo no)"
printf '%s\n' "$A" >"$tmp/fx/ship"
out=$("$SCRIPT" pick 0.141.0)
check 'the gate refuses the newest: the next one' "P $A" "$out"
: >"$tmp/fx/ship"
out=$("$SCRIPT" pick 0.141.0)
check 'the gate ships none: no release, with the newest reason' \
  "NONE none of the newest 2 main commits with a green full run passed the gate (newest, ${B:0:12}: required check typecheck has no merge-queue run on P ${B:0:12})" "$out"
printf '%s\n' "$A" >"$tmp/fx/ship"
out=$(MAX_CANDIDATES=1 "$SCRIPT" pick 0.141.0)
check 'at most MAX_CANDIDATES go to the gate' "NONE none of the newest 1 main commits with a green full run passed the gate (newest, ${B:0:12}: required check typecheck has no merge-queue run on P ${B:0:12})" "$out"
printf '%s\n' "$B" >"$tmp/fx/ship"
out=$(GATE_UNREADABLE=$B "$SCRIPT" pick 0.141.0)
check 'a gate that cannot read its facts is a refusal' "NONE none of the newest 2 main commits with a green full run passed the gate (newest, ${B:0:12}: the gate could not read its facts)" "$out"
out=$(FULL_RUN_WORKFLOWS='browser-test.yml browser-test.yml' "$SCRIPT" pick 0.141.0)
check 'every full-run workflow must be green' "P $B" "$out"
echo '{"workflow_runs":[]}' >"$tmp/fx/fullruns"
out=$("$SCRIPT" pick 0.141.0)
check 'no green full run in the window' 'NONE no main commit of the last 48 h has a green full run' "$out"
rm "$tmp/fx/fullruns"
out=$("$SCRIPT" pick 0.141.0)
check 'an unreadable run list is no pick' "NONE could not read main's commits or full runs" "$out"
out=$(GATE="$tmp/no-such-gate" "$SCRIPT" pick 0.141.0)
check 'no gate script: no pick' 'NONE scripts/release-gate.sh is not on main yet (#4209), so no commit can be proved' "$out"
check 'pick makes no write call' no "$(grep -qE -- '--method|-X ' "$GH_LOG" && echo yes || echo no)"

# pin: the gate on one named commit (a rollback's P_prev), with no window.
printf '%s\n' "$C" >"$tmp/fx/ship"
: >"$GH_LOG"
out=$("$SCRIPT" pin 0.142.1 "$C")
check 'pin: the gate ships P_prev' "P $C" "$out"
check 'pin asks the gate about that commit with the rollback version' yes "$(grep -qF "gate facts 0.142.1 $C" "$GH_LOG" && echo yes || echo no)"
check 'pin reads no commit window and no full-run list' no "$(grep -qE 'commits\?sha=main|browser-test.yml/runs' "$GH_LOG" && echo yes || echo no)"
out=$("$SCRIPT" pin 0.142.1 "$D")
check 'pin: the gate refuses P_prev, with its reason' "NONE the gate refuses ${D:0:12}: required check typecheck has no merge-queue run on P ${D:0:12}" "$out"
out=$(GATE_UNREADABLE=$C "$SCRIPT" pin 0.142.1 "$C")
check 'pin: a gate that cannot read is a refusal' "NONE the gate refuses ${C:0:12}: the gate could not read its facts" "$out"
"$SCRIPT" pin 0.142.1 abc >/dev/null 2>&1
check 'pin needs a full sha' 2 "$?"

# --- commits, on a throwaway repo ---
g() { git -C "$tmp/repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
mkdir -p "$tmp/repo" && git -C "$tmp/repo" init -q
echo 1 >"$tmp/repo/VERSION" && g add . && g commit -qm 'chore(release): v0.141.0' && g tag v0.141.0
mkdir -p "$tmp/repo/changelog/unreleased"
echo a >"$tmp/repo/changelog/unreleased/x.md" && echo b >"$tmp/repo/new file.ts" && g add . && g commit -qm 'feat(x): adds x (#1)'
echo 2 >"$tmp/repo/VERSION" && g add . && g commit -qm 'fix(y): no new file (#2)'
p=$(g rev-parse HEAD)
x=$(g rev-parse HEAD^)
out=$("$SCRIPT" commits "$tmp/repo" 0.141.0 "$p")
expected=$(printf '%s fix(y): no new file (#2)\n%s feat(x): adds x (#1)\tchangelog/unreleased/x.md\tnew file.ts' "$p" "$x")
check 'commits lists v<previous>..P, newest first, with added paths' "$expected" "$out"
"$SCRIPT" commits "$tmp/repo" 0.140.0 "$p" >/dev/null 2>&1
check 'no tag for previous: exit 2' 2 "$?"

# --- summary ---
s() {
  jq -n --arg p "P $A" '{live: false, decision: "CUT", pick: $p, planExit: 0, planError: "",
    plan: {version: "0.142.0", previous: "0.141.0", bump: "minor", bumpReason: "x.md adds something",
      breaking: false, subject: "chore(release): v0.142.0", fragments: ["x.md"],
      files: [{path: "VERSION", status: "modified"}], unfragmentedCommits: []}}' | jq "${1:-.}" >"$tmp/s.json"
  out=$("$SCRIPT" summary "$tmp/s.json" 2>&1)
}
s
contains 'dry run is said first' '## Daily release (DRY RUN: nothing was written)' "$out"
contains 'the decision names the version' 'Decision: **cut v0.142.0**.' "$out"
contains 'P in full' "| Release point P | \`$A\` |" "$out"
contains 'the bump and its reason' '| Version | 0.141.0 → 0.142.0 (minor: x.md adds something) |' "$out"
contains 'the branch it would cut' '1. Create branch `release/v0.142.0` at P.' "$out"
contains 'the release PR' '3. Open the release PR `release-commit/v0.142.0` → `release/v0.142.0`' "$out"
contains 'the tag and artifact dispatch' '4. Once it merges: tag `v0.142.0` at the tip and dispatch `browser-native-release-artifact.yml --ref v0.142.0`.' "$out"
contains 'the publish dispatch with its inputs' "\`version=0.142.0\`, \`expected_sha=<the merged tip>\`, \`mode=routine\`, \`base=$A\`" "$out"
contains 'how to go live' 'Writes are off until the repository variable `DAILY_RELEASE_LIVE` is `on`' "$out"
check 'no unfragmented list when there are none' no "$(grep -qF 'Commits with no fragment' <<<"$out" && echo yes || echo no)"
s '.plan.unfragmentedCommits = [{sha: "eeeeeeeeeeeeeeee", subject: "feat(z): z (#3)"}] | .plan.breaking = true'
contains 'unfragmented commits are listed' '- `eeeeeeeeeeee` feat(z): z (#3)' "$out"
contains 'breaking ships as a flagged minor' '| Breaking | yes, shipped as a flagged 0.x minor |' "$out"
s '.live = true'
contains 'live says so' '## Daily release (LIVE)' "$out"
contains 'live says what it does now' '### What it does now' "$out"
check 'live has no dry-run footer' no "$(grep -qF 'Writes are off' <<<"$out" && echo yes || echo no)"
s '.pick = "NONE no main commit of the last 48 h has a green full run" | .plan = null | .planExit = null'
contains 'no pick: no release, with why' 'Decision: **no release today**. no main commit of the last 48 h has a green full run.' "$out"
s '.plan = null | .planExit = 3'
contains 'no fragments: no release' "Decision: **no release today**. P \`$A\` has no new changelog fragments." "$out"
s '.plan = null | .planExit = 1 | .planError = "fragment x.md has no category"'
contains 'a refused release commit says why' 'was refused: fragment x.md has no category' "$out"
s '.decision = "TAG 0.142.0" | .pick = "" | .plan = null'
contains 'tag step' 'Decision: **tag v0.142.0** at the merged release PR tip' "$out"
s '.decision = "PUBLISH 0.142.0" | .pick = "" | .plan = null'
contains 'publish step names the dispatch' 'dispatch `release-publish.yml` on main with `version=0.142.0`' "$out"
s '.decision = "WAIT DAILY_RELEASE_HOLD is set: x" | .pick = "" | .plan = null'
contains 'wait says why' 'Decision: **wait**. DAILY_RELEASE_HOLD is set: x' "$out"
rb='.decision = "ROLLBACK 0.142.0 0.141.0 '"$A"'" | .plan.version = "0.142.1" | .plan.previous = "0.140.0"
  | .plan.bump = "override" | .plan.bumpReason = "rolls back 0.142.0" | .plan.subject = "chore(release): v0.142.1"'
s "$rb"
contains 'rollback dry run says nothing was written' '## Daily release (DRY RUN: nothing was written)' "$out"
contains 'rollback decision names both versions and the rollback line' \
  'Decision: **roll back v0.142.0**: cut v0.142.1 at P, the commit v0.141.0 was cut at, with the notes of v0.141.0 under `Rolled back 0.142.0.`.' "$out"
contains 'rollback P is P_prev' "| Release point P | \`$A\` |" "$out"
contains 'rollback opens the hold first' '1. Open an issue labelled `release-hold` (unless one is open): no daily cut runs while it is open.' "$out"
contains 'then the same cut path' '2. Create branch `release/v0.142.1` at P.' "$out"
contains 'and the same publish, based on P_prev' "\`version=0.142.1\`, \`expected_sha=<the merged tip>\`, \`mode=routine\`, \`base=$A\`" "$out"
contains 'rollback dry run: how to go live' 'Writes are off until the repository variable `DAILY_RELEASE_LIVE` is `on`' "$out"
s "$rb"' | .pick = "NONE the gate refuses aaaaaaaaaaaa: x" | .plan = null | .planExit = null'
contains 'gate refuses P_prev: no rollback, with why' 'Decision: **no rollback**. the gate refuses aaaaaaaaaaaa: x.' "$out"
s "$rb"' | .plan = null | .planExit = 1 | .planError = "--rollback 0.142.0 is not newer"'
contains 'a refused rollback commit says why' 'Decision: **no rollback**. The release commit for P' "$out"
s '.decision = "REFUSE 0.141.0 is not the newest published version (npm has 0.142.0); only the newest can be rolled back" | .pick = "" | .plan = null'
contains 'a refused rollback says why' 'Decision: **refuse**. 0.141.0 is not the newest published version' "$out"
s '.decision = "WAIT the release-hold issue #77 is open: x" | .pick = "" | .plan = null'
contains 'a held cut says which issue' 'Decision: **wait**. the release-hold issue #77 is open: x' "$out"

echo nope >"$tmp/s.json"
"$SCRIPT" summary "$tmp/s.json" >/dev/null 2>&1
check 'unreadable state: exit 2' 2 "$?"

# --- the workflow: a dry run writes nothing ---
# Every job that can write (the app token, issues: write, actions: write) runs
# only when the plan says live, and the rollback's cut only after its hold.
wf=$repo_root/.github/workflows/daily-release.yml
job() { awk -v j="  $1:" '$0 == j {on = 1; print; next} on && /^  [a-z-]+:$/ {exit} on' "$wf"; }
for j in hold cut advance; do
  contains "$j runs only when live" "needs.plan.outputs.live == 'true'" "$(job "$j")"
done
contains 'hold runs for a rollback only' "needs.plan.outputs.step == 'rollback'" "$(job hold)"
contains 'hold writes issues and nothing else' $'    permissions:\n      issues: write\n    env:' "$(job hold)"
contains 'a rollback cuts only once its hold is set' "needs.plan.outputs.step == 'rollback' && needs.hold.result == 'success'" "$(job cut)"
contains 'the cut passes the rollback to release-commit.ts' '--commit ${rollback[@]+"${rollback[@]}"}' "$(job cut)"
check 'the plan job writes nothing' no "$(job plan | grep -qE ': write$|create-github-app-token|--method' && echo yes || echo no)"
contains 'bad_version reaches the script through the env only' 'BAD_VERSION: ${{ inputs.bad_version }}' "$(job plan)"
check 'bad_version is read in that one env line and nowhere else' 1 "$(grep -c 'inputs\.bad_version' "$wf")"

# --- usage ---
"$SCRIPT" >/dev/null 2>&1
check 'no arguments is a usage error' 2 "$?"
"$SCRIPT" pick latest >/dev/null 2>&1
check 'pick needs a version' 2 "$?"
"$SCRIPT" facts extra >/dev/null 2>&1
check 'facts takes no arguments' 2 "$?"
"$SCRIPT" commits "$tmp/repo" 0.141.0 abc >/dev/null 2>&1
check 'commits needs a full sha' 2 "$?"

echo "daily-release fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
