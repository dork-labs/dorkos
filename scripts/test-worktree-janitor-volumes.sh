#!/usr/bin/env bash
# Fixture suite for the unplugged-disk guard in scripts/worktree-janitor.sh.
#
# Worktrees can live on an external disk under /Volumes/<name>/. Unplug it and
# git sees each of them as a worktree whose directory is gone, so a plain
# `git worktree prune` deletes their records. The janitor runs that prune every
# night from a LaunchAgent, so the guard has to hold on its own: while any
# registered worktree sits on an unmounted /Volumes disk, --fix removes nothing
# and prunes nothing, and says which disk is missing.
#
# Hermetic: a throwaway repo and bare origin in a temp dir, and a fake `gh` that
# reports no pull requests. A worktree "on" a missing disk is made by pointing a
# real worktree's admin record at a /Volumes path that cannot exist, which is
# exactly what git sees after an unplug. Never touches this repo's worktrees.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUT="$SCRIPT_DIR/worktree-janitor.sh"

pass=0
fail=0

TMP=$(mktemp -d)
TMP=$(cd "$TMP" && pwd -P)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\necho "[]"\n' >"$TMP/bin/gh"
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export DORK_HOME="$TMP/dork-home"

MISSING_VOL="/Volumes/dorkos-janitor-test-missing-$$"

ok() {
  pass=$((pass + 1))
}
bad() {
  fail=$((fail + 1))
  echo "FAIL: $1"
  [[ -n "${2:-}" ]] && printf '  output:\n%s\n' "$2"
}

# A fresh repo with one commit on main, pushed to a bare origin.
new_repo() {
  local name=$1
  git init --quiet --bare -b main "$TMP/$name-origin.git"
  git init --quiet -b main "$TMP/$name"
  git -C "$TMP/$name" -c user.name=t -c user.email=t@t commit --quiet --allow-empty -m init
  git -C "$TMP/$name" remote add origin "$TMP/$name-origin.git"
  git -C "$TMP/$name" push --quiet origin main
  git -C "$TMP/$name" remote set-head origin main
}

# Register a detached worktree, then point its admin record at <path>, as if
# the directory had moved there and then vanished.
phantom_worktree() {
  local repo=$1 id=$2 path=$3
  git -C "$TMP/$repo" worktree add --quiet --detach "$TMP/$repo-$id" main
  echo "$path/.git" >"$TMP/$repo/.git/worktrees/$repo-$id/gitdir"
  rm -rf "$TMP/$repo-$id"
}

run_fix() {
  (cd "$TMP/$1" && bash "$SUT" --fix 2>&1)
}

# --- a worktree on an unmounted disk: nothing pruned, one line logged --------

new_repo ext
phantom_worktree ext a "$MISSING_VOL/dorkos-wt/ext-a"
out=$(run_fix ext)
if [[ -d "$TMP/ext/.git/worktrees/ext-a" ]]; then ok; else bad "record of a worktree on an unmounted disk was pruned" "$out"; fi
line="ALERT: $MISSING_VOL is not mounted: git worktree prune skipped"
if [[ $(grep -cF "$line" <<<"$out") -eq 1 ]]; then ok; else bad "expected exactly one line naming $MISSING_VOL" "$out"; fi
# The daily wrapper keeps only lines matching this, so the line must survive it.
if grep -E "removed|ERROR|error" <<<"$out" | grep -qF "$MISSING_VOL"; then ok; else bad "missing-disk line would not reach the LaunchAgent log" "$out"; fi

# --- the same, with an internal-disk worktree gone too: still nothing pruned -

new_repo mixed
phantom_worktree mixed a "$MISSING_VOL/dorkos-wt/mixed-a"
phantom_worktree mixed b "$TMP/gone/mixed-b"
out=$(run_fix mixed)
if [[ -d "$TMP/mixed/.git/worktrees/mixed-a" && -d "$TMP/mixed/.git/worktrees/mixed-b" ]]; then ok; else bad "a missing disk must hold back every prune in that repo" "$out"; fi

# --- no external paths: behaviour unchanged, a vanished worktree is pruned ---

new_repo int
phantom_worktree int a "$TMP/gone/int-a"
out=$(run_fix int)
if [[ ! -d "$TMP/int/.git/worktrees/int-a" ]]; then ok; else bad "vanished internal-disk worktree was not pruned" "$out"; fi
if ! grep -q "is not mounted" <<<"$out"; then ok; else bad "no external worktree, but a missing-disk line was logged" "$out"; fi

echo "worktree-janitor volume guard: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
