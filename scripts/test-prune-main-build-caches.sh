#!/usr/bin/env bash
# Fixture suite for scripts/prune-main-build-caches.sh, which build-cache.yml
# runs after every merge to delete main's older turbo build caches (DOR-4627).
#
# The cases that matter most: it must never delete a pnpm store, a cache on
# another ref, or one of the newest KEEP entries of a family, and a failed
# listing must delete nothing and exit 1.
#
# HERMETIC: `gh` is a stub (GH=...) that answers listings from fixture files
# and records every delete it is asked for. Nothing reaches GitHub.
#
#   bash scripts/test-prune-main-build-caches.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script=${PRUNE:-$repo_root/scripts/prune-main-build-caches.sh}

work_dir=$(mktemp -d -t prune-main-build-caches.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

pass=0
fail=0

check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

# The stub. A listing prints $FIXTURES/<family>.tsv (the lines the real --jq
# would print), or fails when $FIXTURES/<family>.fail exists. A delete appends
# the id to $FIXTURES/deleted, and fails for an id listed in $FIXTURES/refuse.
stub=$work_dir/gh
cat >"$stub" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "$1" = api ] && [ "$2" = -X ] && [ "$3" = DELETE ]; then
  id=${4##*/}
  if [ -f "$FIXTURES/refuse" ] && grep -qx "$id" "$FIXTURES/refuse"; then exit 1; fi
  echo "$id" >>"$FIXTURES/deleted"
  exit 0
fi
if [ "$1" = api ] && [ "$2" = --paginate ]; then
  url=$3
  echo "$url" >>"$FIXTURES/listed"
  family=${url#*&key=}
  family=${family%%&*}
  [ -f "$FIXTURES/$family.fail" ] && exit 1
  [ -f "$FIXTURES/$family.tsv" ] && cat "$FIXTURES/$family.tsv"
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 2
STUB
chmod +x "$stub"

# new_case <name>: a fresh fixture dir, exported as FIXTURES.
new_case() {
  FIXTURES=$work_dir/$1
  mkdir -p "$FIXTURES"
  : >"$FIXTURES/deleted"
  : >"$FIXTURES/listed"
  export FIXTURES
}

# entry <family> <id> <ref> <created> [key]: one listing line.
entry() {
  local family=$1 id=$2 ref=$3 created=$4 key=${5:-$1Linux-X64-lock-sha$2}
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" 25000000 "$ref" "$created" "$key" >>"$FIXTURES/$family.tsv"
}

run() {
  GH=$stub GH_REPO=fixture/repo "$@" bash "$script" >"$FIXTURES/out" 2>&1
  printf '%s' $?
}

deleted() { sort -n "$FIXTURES/deleted" | tr '\n' ' ' | sed 's/ $//'; }

M=refs/heads/main
T=turbo-test-builds-
B=turbo-browser-builds-

# --- The newest KEEP of each family stay, the rest go -------------------------

new_case normal
for i in 1 2 3 4 5; do entry "$T" "1$i" "$M" "2026-11-23T1$i:00:00Z"; done
for i in 1 2 3 4; do entry "$B" "2$i" "$M" "2026-11-23T1$i:00:00Z"; done
check 'a normal prune exits 0' 0 "$(run)"
check 'only the entries older than the newest three of each family are deleted' '11 12 21' "$(deleted)"
check 'both families are listed, on main only' 2 \
  "$(grep -c 'ref=refs/heads/main&key=turbo-' "$FIXTURES/listed")"

new_case keep-one
for i in 1 2 3; do entry "$T" "1$i" "$M" "2026-11-23T1$i:00:00Z"; done
check 'KEEP=1 keeps only the newest' 0 "$(run env KEEP=1)"
check 'and deletes the other two' '11 12' "$(deleted)"

# --- Order is decided by created_at, not by the order the API returned --------

new_case shuffled
entry "$T" 13 "$M" '2026-11-23T13:00:00Z'
entry "$T" 11 "$M" '2026-11-23T11:00:00Z'
entry "$T" 14 "$M" '2026-11-23T14:00:00Z'
entry "$T" 12 "$M" '2026-11-23T12:00:00Z'
check 'an unsorted listing exits 0' 0 "$(run)"
check 'the oldest is deleted whatever order the listing came in' '11' "$(deleted)"

# --- Never anything it does not own ------------------------------------------

new_case foreign
for i in 1 2 3 4; do entry "$T" "1$i" "$M" "2026-11-23T1$i:00:00Z"; done
entry "$T" 31 refs/heads/gh-readonly-queue/main/pr-1-abc '2026-11-22T01:00:00Z'
entry "$T" 32 refs/pull/7/merge '2026-11-22T02:00:00Z'
entry "$T" 33 "$M" '2026-11-22T03:00:00Z' 'pnpm-store-Linux-ubuntu24-X64-lock'
entry "$T" 34 "$M" '2026-11-22T04:00:00Z' 'turbo-test-buildsX-Linux'
check 'a listing with foreign lines exits 0' 0 "$(run)"
check 'another ref, a pnpm store and a look-alike key are never deleted' '11' "$(deleted)"

new_case few
entry "$T" 11 "$M" '2026-11-23T11:00:00Z'
entry "$T" 12 "$M" '2026-11-23T12:00:00Z'
check 'fewer entries than KEEP exits 0' 0 "$(run)"
check 'and deletes nothing' '' "$(deleted)"

new_case empty
check 'no entries at all exits 0' 0 "$(run)"
check 'and deletes nothing' '' "$(deleted)"

# --- Failures ----------------------------------------------------------------

new_case list-fails
for i in 1 2 3 4 5; do entry "$B" "2$i" "$M" "2026-11-23T1$i:00:00Z"; done
for i in 1 2 3 4; do entry "$T" "1$i" "$M" "2026-11-23T1$i:00:00Z"; done
: >"$FIXTURES/$B.fail"
check 'a listing that fails exits 1' 1 "$(run)"
check 'deletes nothing of that family, and still prunes the other' '11' "$(deleted)"

new_case delete-fails
for i in 1 2 3 4 5; do entry "$T" "1$i" "$M" "2026-11-23T1$i:00:00Z"; done
echo 11 >"$FIXTURES/refuse"
check 'a refused delete is a warning, not a failure' 0 "$(run)"
check 'and the next one is still deleted' '12' "$(deleted)"
check 'and says so' 1 "$(grep -c '::warning title=Build cache not deleted::' "$FIXTURES/out")"

new_case bad-keep
for i in 1 2 3 4; do entry "$T" "1$i" "$M" "2026-11-23T1$i:00:00Z"; done
check 'KEEP=0 is refused' 1 "$(run env KEEP=0)"
check 'and deletes nothing' '' "$(deleted)"
check 'KEEP that is not a number is refused' 1 "$(run env KEEP=two)"

new_case no-repo
entry "$T" 11 "$M" '2026-11-23T11:00:00Z'
check 'no GH_REPO is refused' 1 "$(GH=$stub GH_REPO='' bash "$script" >/dev/null 2>&1; printf '%s' $?)"

printf 'prune-main-build-caches: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
