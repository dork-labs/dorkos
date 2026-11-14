#!/usr/bin/env bash
# Pins pr-age-list.sh (DOR-3341): only PRs older than N days, oldest first,
# drafts marked, a clear line when none, and every bad input or failed `gh`
# exits 2 so an empty report never hides a failure. A stubbed `gh` on PATH and
# a pinned PR_AGE_NOW, never GitHub. Needs bash and jq.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$DIR/pr-age-list.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
pass=0

cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
[ "${FAKE_GH_FAIL:-0}" = 1 ] && { echo "gh: boom" >&2; exit 1; }
case "$1 $2" in
  "pr list") printf '%s' "$FAKE_PRS" ;;
  "repo view") echo "made-up/repo" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"
export PATH="$tmp:$PATH"
export PR_AGE_NOW=2026-11-13T12:00:00Z

pr() { # $1 number, $2 createdAt, $3 isDraft, $4 title
  jq -cn --argjson n "$1" --arg at "$2" --argjson draft "${3:-false}" --arg t "${4:-Made-up change $1}" \
    '{number: $n, title: $t, createdAt: $at, isDraft: $draft, labels: [], url: "https://example.invalid/\($n)"}'
}
list() { jq -cs '.'; }

MIXED=$(
  {
    pr 11 2026-11-12T12:00:00Z
    pr 12 2026-11-08T11:00:00Z
    pr 13 2026-11-05T12:00:00Z true
    pr 14 2026-11-10T11:59:00Z
  } | list
)

run() { # $1 name, $2 expected exit, rest: args. Leaves output in $out.
  local name=$1 want=$2 got
  shift 2
  set +e
  out=$("$SCRIPT" "$@" 2>&1)
  got=$?
  set -e
  if [ "$got" != "$want" ]; then
    echo "FAIL $name: expected exit $want, got $got: $out" >&2
    fail=1
    return 1
  fi
}
has() { # $1 name, $2 text
  if grep -qF -- "$2" <<<"$out"; then pass=$((pass + 1)); else
    echo "FAIL $1: output lacks '$2': $out" >&2
    fail=1
  fi
}
lacks() { # $1 name, $2 text
  if grep -qF -- "$2" <<<"$out"; then
    echo "FAIL $1: output has '$2': $out" >&2
    fail=1
  else pass=$((pass + 1)); fi
}

if FAKE_PRS=$MIXED run default_three_days 0; then
  has default_three_days "#13  8d  Made-up change 13 (draft)"
  has default_three_days "#12  5d  Made-up change 12"
  has default_three_days "#14  3d  Made-up change 14"
  lacks default_three_days "#11 "
  first=$(head -1 <<<"$out")
  if [[ "$first" == "#13 "* ]]; then pass=$((pass + 1)); else
    echo "FAIL oldest_first: first line is '$first'" >&2
    fail=1
  fi
fi

if FAKE_PRS=$MIXED run five_days 0 --days 5; then
  has five_days "#13  8d"
  has five_days "#12  5d"
  lacks five_days "#14 "
fi

if FAKE_PRS=$(pr 11 2026-11-12T12:00:00Z | list) run none 0; then
  has none "No open PRs older than 3 days."
fi

labelled=$(jq -cn '[{number: 21, title: "Made-up labelled", createdAt: "2026-11-01T00:00:00Z", isDraft: false, labels: [{name: "hold"}, {name: "review:deep"}], url: "x"}]')
if FAKE_PRS=$labelled run labels 0; then
  has labels "[labels: hold, review:deep]"
fi

FAKE_PRS=$MIXED run bad_days 2 --days abc && pass=$((pass + 1))
FAKE_PRS=$MIXED run zero_days 2 --days 0 && pass=$((pass + 1))
FAKE_PRS=$MIXED FAKE_GH_FAIL=1 run gh_fails 2 --repo made-up/repo && pass=$((pass + 1))
FAKE_PRS='not json' run bad_json 2 && pass=$((pass + 1))
FAKE_PRS=$(jq -cn '[range(200) | {number: ., title: "x", createdAt: "2026-11-01T00:00:00Z", isDraft: false, labels: [], url: "x"}]') \
  run full_page 2 && pass=$((pass + 1))

if [ "$fail" != 0 ]; then
  echo "pr-age-list: some checks failed ($pass passed)" >&2
  exit 1
fi
echo "pr-age-list: all $pass checks passed"
