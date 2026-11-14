#!/usr/bin/env bash
# Pins open-pr-cap.sh (DOR-3341): under the cap passes, at the cap refuses and
# lists the PRs, drafts do not count, a P0 passes with a reason, and every bad
# input or failed `gh` refuses rather than reading as zero. A stubbed `gh` on
# PATH, never GitHub. Needs bash and jq.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$DIR/open-pr-cap.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
pass=0

# The fake gh prints $FAKE_PRS for `pr list`, or fails when FAKE_GH_FAIL=1.
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

prs() { # $1 open count, $2 draft count
  jq -cn --argjson open "$1" --argjson drafts "${2:-0}" '
    [range($open) | {number: (100 + .), isDraft: false, title: "Made-up change \(.)"}]
    + [range($drafts) | {number: (900 + .), isDraft: true, title: "Draft \(.)"}]'
}

expect() { # $1 name, $2 expected exit, $3 text the output must contain, rest: args
  local name=$1 want=$2 text=$3 got out
  shift 3
  set +e
  out=$("$SCRIPT" "$@" 2>&1)
  got=$?
  set -e
  if [ "$got" != "$want" ]; then
    echo "FAIL $name: expected exit $want, got $got: $out" >&2
    fail=1
  elif [ -n "$text" ] && ! grep -qF -- "$text" <<<"$out"; then
    echo "FAIL $name: output lacks '$text': $out" >&2
    fail=1
  else
    pass=$((pass + 1))
  fi
}

FAKE_PRS=$(prs 7) expect under_cap 0 "open PRs: 7 of 8; ok to open one"
FAKE_PRS=$(prs 8) expect at_cap 1 "open PRs: 8 of 8. Do not open another"
FAKE_PRS=$(prs 8) expect at_cap_lists 1 "#107 Made-up change 7"
FAKE_PRS=$(prs 9) expect over_cap 1 "open PRs: 9 of 8"
FAKE_PRS=$(prs 7 5) expect drafts_ignored 0 "open PRs: 7 of 8"
FAKE_PRS=$(prs 8) expect p0_passes 0 "opening anyway as a P0: launch blocker" --p0 "launch blocker"
FAKE_PRS=$(prs 8) expect p0_empty 2 "needs a reason" --p0 ""
FAKE_PRS=$(prs 8) expect p0_blank 2 "needs a reason" --p0 "   "
FAKE_PRS=$(prs 2) DORKOS_OPEN_PR_CAP=abc expect bad_cap 2 "positive whole number"
FAKE_PRS=$(prs 2) DORKOS_OPEN_PR_CAP=0 expect zero_cap 2 "positive whole number"
FAKE_PRS=$(prs 2) DORKOS_OPEN_PR_CAP=2 expect custom_cap 1 "open PRs: 2 of 2"
FAKE_PRS=$(prs 0) FAKE_GH_FAIL=1 expect gh_fails 2 "could not" --repo made-up/repo
FAKE_PRS=$(prs 200) expect full_page 2 "too many to count reliably"
FAKE_PRS='not json' expect bad_json 2 "could not read the PR list"
FAKE_PRS=$(prs 1) expect bad_arg 2 "unknown argument" --nope

if [ "$fail" != 0 ]; then
  echo "open-pr-cap: some checks failed ($pass passed)" >&2
  exit 1
fi
echo "open-pr-cap: all $pass checks passed"
