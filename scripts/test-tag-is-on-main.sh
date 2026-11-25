#!/usr/bin/env bash
# Fixture suite for scripts/ci/tag-is-on-main.sh, the first job of every release
# workflow (DOR-4030). A throwaway bare repository stands in for GitHub, and a
# stub release-branch check on main stands in for #4024/#4025's real one, so
# each case pins one way in or one way it must refuse.
#
#   bash scripts/test-tag-is-on-main.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gate=$repo_root/scripts/ci/tag-is-on-main.sh

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export RUNNER_TEMP=$tmp/runner
mkdir -p "$RUNNER_TEMP"
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export ARGS_LOG=$tmp/args.log
pass=0
fail=0

origin=$tmp/origin.git
work=$tmp/work
git init -q --bare -b main "$origin"
git init -q -b main "$work"
git -C "$work" remote add origin "$origin"

commit() { # commit <message> -> sha
  git -C "$work" commit -q --allow-empty -m "$1"
  git -C "$work" rev-parse HEAD
}
# A stub release-branch check that logs its arguments and exits $1.
put_stub() {
  mkdir -p "$work/scripts/ci" "$work/packages/cli/scripts/release-branch"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "$ARGS_LOG"\nexit %s\n' "$1" \
    >"$work/scripts/ci/release-branch-contents.sh"
  echo '// stub rule' >"$work/packages/cli/scripts/release-branch/check-picks.ts"
  git -C "$work" add scripts packages
  git -C "$work" commit -q -m "stub check exits $1"
}

# run <sha> <ref> -> sets rc; uses a fresh clone each time, as the workflow does.
run() {
  local clone=$tmp/clone-$RANDOM$RANDOM
  git init -q "$clone"
  git -C "$clone" remote add origin "$origin"
  rm -f "$ARGS_LOG"
  bash "$gate" --dir "$clone" --sha "$1" --ref "$2" --what 'Fixtures run' --summary "$tmp/summary" \
    >/dev/null 2>"$tmp/err"
  rc=$?
}
expect() { # expect <name> <want-rc>
  if [ "$rc" -eq "$2" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %-60s want %s got %s: %s\n' "$1" "$2" "$rc" "$(head -c 300 "$tmp/err")"
  fi
}

# main: one commit. A release branch off it with its own commit, tagged.
main1=$(commit 'main one')
git -C "$work" push -q origin main
git -C "$work" checkout -q -b release/v1.2.3
rel=$(commit 'chore(release): v1.2.3')
# The tag's own tree carries a check that would PASS; main's copy must win.
mkdir -p "$work/scripts/ci" "$work/packages/cli/scripts/release-branch"
printf '#!/usr/bin/env bash\nexit 0\n' >"$work/scripts/ci/release-branch-contents.sh"
echo '// tag copy' >"$work/packages/cli/scripts/release-branch/check-picks.ts"
git -C "$work" add scripts packages
git -C "$work" commit -q -m 'tag-side check that always passes'
rel=$(git -C "$work" rev-parse HEAD)
git -C "$work" tag v1.2.3
git -C "$work" push -q origin release/v1.2.3 v1.2.3
git -C "$work" checkout -q main
off=$(git -C "$work" checkout -q -b stray && commit 'a stray commit')
git -C "$work" push -q origin stray
git -C "$work" checkout -q main

# (a) on main
run "$main1" refs/heads/main
expect 'a commit on main, from main' 0
run "$main1" refs/tags/v9.9.9
expect 'a tag whose commit is on main' 0

# Not on main, not a release tag
run "$off" refs/heads/stray
expect 'a branch commit not on main' 1
run "$off" refs/tags/stray-1
expect 'a non-version tag not on main' 1
run "$rel" refs/tags/v1.2
expect 'a malformed version tag' 1
run "$rel" refs/tags/v01.2.3
expect 'a version tag with a leading zero' 1

# (b) before main has the release-branch check: refuse, even though the tag's
# own tree carries one that would pass.
run "$rel" refs/tags/v1.2.3
expect 'a release tag before main has the check' 1
[ ! -e "$ARGS_LOG" ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL  the tag's own check ran"; }

# main gets a stub check that refuses: main's copy decides, not the tag's.
put_stub 1
git -C "$work" push -q origin main
run "$rel" refs/tags/v1.2.3
expect "main's check refuses the branch" 1

put_stub 2
git -C "$work" push -q origin main
run "$rel" refs/tags/v1.2.3
expect "main's check cannot decide" 1

put_stub 0
git -C "$work" push -q origin main
run "$rel" refs/tags/v1.2.3
expect "main's check accepts the release branch" 0
# It ran main's stub (the tag's copy logs nothing), with the branch, version
# and peeled commit, and a rule folder under RUNNER_TEMP, not the tag's tree.
args=$(tr '\n' ' ' <"$ARGS_LOG" 2>/dev/null)
if [[ "$args" == *"--branch release/v1.2.3 --version 1.2.3 --head-sha $rel --remote origin"* ]] &&
  [[ "$args" == "--rule-dir $RUNNER_TEMP/"* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL  main's check got the wrong arguments: $(tr '\n' ' ' <"$ARGS_LOG" 2>/dev/null)"
fi

# The run's commit must be the tag's commit.
run "$main1" refs/tags/v1.2.3
expect 'a run whose commit is on main passes by (a) even for that tag name' 0
run "$off" refs/tags/v1.2.3
expect "a run whose commit isn't the tag's" 1

# Bad input never reaches git.
run 'not-a-sha' refs/tags/v1.2.3
expect 'a sha that is not a full hex sha' 2
run "$rel" 'refs/tags/v1.2.3;rm -rf x'
expect 'a ref with shell characters' 2

echo
echo "tag-is-on-main fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
