#!/usr/bin/env bash
# Fixture suite for scripts/daily-sweep.sh (DOR-5120). `render` runs on
# hand-built sweep folders through the real design-ok.sh and qa-real-data.sh;
# `collect` runs against a stubbed `gh` (GH=...) that answers from fixture files
# and logs every call. Needs bash and jq.
#
#   bash scripts/test-daily-sweep.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/daily-sweep.sh
tmp=$(mktemp -d -t daily-sweep-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
out=""
rc=0
check() {
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

# pr <dir> <n> <title> <files...>: one collected PR with no labels and no patches
pr() {
  local d=$1/$2 num=$2 title=$3
  shift 3
  mkdir -p "$d"
  jq -n --argjson n "$num" --arg t "$title" '{number: $n, title: $t, author: "dev1"}' >"$d/meta.json"
  : >"$d/labels.txt"
  printf '%s\n' "$@" >"$d/files.txt"
  : >"$d/patches.txt"
  for f in "$@"; do printf '@@FILE@@ %s\n+x\n' "$f" >>"$d/patches.txt"; done
}

S=$tmp/s1
mkdir -p "$S"
printf '%s\n' 11 12 13 14 >"$S/prs.txt"
pr "$S" 11 'feat(ui): a new button' apps/client/src/layers/features/chat/ui/Thing.tsx
pr "$S" 12 'ci: a workflow tweak' .github/workflows/x.yml
pr "$S" 13 'feat(db): a column' packages/db/drizzle/20261124000000_x.sql
mkdir -p "$S/14"
: >"$S/14/unreadable"

out=$("$SCRIPT" render "$S" v1.2.3 2>&1)
rc=$?
check 'render exits 0' 0 "$rc"
check 'it names the release it counts from' yes "$(has "$out" 'merged since v1.2.3')"
check 'it counts every merged PR' yes "$(has "$out" '4 PR(s) merged')"
check 'a UI change is on the design list' yes "$(has "$(sed -n '/### Design/,/### QA/p' <<<"$out")" '#11 feat(ui)')"
# shellcheck disable=SC2016 # the backticks are literal markdown
check 'with its path' yes "$(has "$out" '`apps/client/src/layers/features/chat/ui/Thing.tsx`')"
check 'a migration is on the QA list' yes "$(has "$(sed -n '/### QA/,$p' <<<"$out")" '#13 feat(db)')"
check 'a CI-only change is on neither list' no "$(has "$out" '#12 ')"
check 'and is counted as needing neither' yes "$(has "$out" '1 other PR(s) need neither review.')"
check 'an unreadable PR is on the design list' yes "$(has "$(sed -n '/### Design/,/### QA/p' <<<"$out")" '#14')"
check 'and on the QA list' yes "$(has "$(sed -n '/### QA/,$p' <<<"$out")" '#14')"
check 'items start unticked' yes "$(has "$out" '- [ ] #11 ')"
check 'no @-mention reaches GitHub' no "$(grep -qE '(^|[^a-zA-Z0-9`])@[a-zA-Z]' <<<"$out" && echo yes || echo no)"

printf '%s\n' '## old' '- [x] #11 feat(ui): a new button (by dev1): whatever' '- [ ] #13 feat(db)' >"$tmp/prev.md"
out=$("$SCRIPT" render "$S" v1.2.3 "$tmp/prev.md" 2>&1)
check 'a tick from the previous body survives' yes "$(has "$out" '- [x] #11 ')"
check 'an unticked one stays unticked' yes "$(has "$out" '- [ ] #13 ')"

E=$tmp/empty
mkdir -p "$E"
: >"$E/prs.txt"
out=$("$SCRIPT" render "$E" v1.2.3 2>&1)
check 'a quiet day says so for design' yes "$(has "$out" 'Nothing a person sees changed.')"
check 'and for QA' yes "$(has "$out" 'No config, migration or upgrade-floor change.')"

"$SCRIPT" render "$tmp/missing" v1 >/dev/null 2>&1
check 'no collected sweep is exit 2' 2 "$?"
"$SCRIPT" >/dev/null 2>&1
check 'no arguments is a usage error' 2 "$?"
"$SCRIPT" collect yesterday "$tmp/c" >/dev/null 2>&1
check 'a bad since is a usage error' 2 "$?"

# --- collect, through a stubbed gh ---
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]] && exit 1
filter=.
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[$i]}" = --jq ] && filter=${args[$((i + 1))]}; done
case "$*" in
  *search/issues*) f=search ;;
  *"/pulls/21/files"*) f=files ;;
  *"/pulls/21"*) f=pull ;;
  *"/issues/21/labels"*) f=labels ;;
  *) exit 1 ;;
esac
jq -r "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
mkdir -p "$tmp/fx"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$tmp/fx
echo '{"items":[{"number":21}]}' >"$tmp/fx/search"
echo '{"number":21,"title":"feat(ui): x","user":{"login":"dev1"},"merged_at":"2026-11-24T01:00:00Z"}' >"$tmp/fx/pull"
echo '[{"name":"needs-design"}]' >"$tmp/fx/labels"
echo '[{"filename":"apps/client/src/a.tsx","status":"added","additions":1,"deletions":0,"patch":"+x"}]' >"$tmp/fx/files"
: >"$GH_LOG"
"$SCRIPT" collect 2026-11-23T14:03:51Z "$tmp/c" >/dev/null 2>&1
check 'collect exits 0' 0 "$?"
check 'it searches merged PRs into main since the release' yes "$(grep -qF 'is:pr is:merged base:main merged:>=2026-11-23T14:03:51Z' "$GH_LOG" && echo yes || echo no)"
check 'it writes the labels' needs-design "$(cat "$tmp/c/21/labels.txt" 2>/dev/null)"
check 'it writes the files' apps/client/src/a.tsx "$(cat "$tmp/c/21/files.txt" 2>/dev/null)"
check 'it writes the patches in qa-real-data form' yes "$(grep -qF '@@FILE@@ apps/client/src/a.tsx' "$tmp/c/21/patches.txt" 2>/dev/null && echo yes || echo no)"
check 'collect makes no write call' no "$(grep -qE -- '--method|-X (POST|PATCH|PUT|DELETE)' "$GH_LOG" && echo yes || echo no)"
out=$("$SCRIPT" render "$tmp/c" v1 2>&1)
check 'collect feeds render end to end' yes "$(has "$out" '#21 feat(ui): x')"

FAIL_ON='/pulls/21/files' "$SCRIPT" collect 2026-11-23T14:03:51Z "$tmp/c2" >/dev/null 2>&1
check 'one unreadable PR does not stop collect' 0 "$?"
check 'it is marked unreadable' yes "$([ -e "$tmp/c2/21/unreadable" ] && echo yes || echo no)"
FAIL_ON='search/issues' "$SCRIPT" collect 2026-11-23T14:03:51Z "$tmp/c3" >/dev/null 2>&1
check 'a failed search is exit 2' 2 "$?"

echo "daily-sweep fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
