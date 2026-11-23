#!/usr/bin/env bash
# Fixture suite for scripts/pr-gates-check.sh: the `pr-gates` check runs
# arm-door's own decision (scripts/arm-door.sh, qa-real-data.sh, design-ok.sh)
# on the pull request, minus the verify-proof reason. A stubbed `gh` (GH=...)
# answers every read from canned JSON through the script's own --jq filter, so
# nothing reaches GitHub. Needs bash and jq.
#
#   bash scripts/test-pr-gates-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/pr-gates-check.sh
tmp=$(mktemp -d -t pr-gates-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

H=1111111111111111111111111111111111111111
# Canned answers, one file per endpoint, rewritten by each case.
fx=$tmp/fx
mkdir -p "$fx"
reset_fixtures() {
  printf '{"head":{"sha":"%s","ref":"feat/x"},"title":"feat(server): x","changed_files":1}' "$H" >"$fx/pull"
  echo '{"commit":{"committer":{"date":"2026-11-23T10:00:00Z"}}}' >"$fx/commit"
  echo '{"workflow_runs":[{"path":".github/workflows/typecheck.yml","head_branch":"feat/x","head_repository":{"full_name":"made-up/repo"},"created_at":"2026-11-23T10:01:00Z"}]}' >"$fx/runs"
  echo '[]' >"$fx/statuses"
  echo '{"check_runs":[]}' >"$fx/checkruns"
  echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T10:05:00Z"}]' >"$fx/events"
  echo '[{"name":"review:light"}]' >"$fx/labels"
  # shellcheck disable=SC2028 # the \n is JSON's, for jq, not the shell's
  echo '[{"filename":"apps/server/src/lib/thing.ts","status":"modified","additions":1,"deletions":0,"patch":"@@ -1 +1 @@\n-a\n+b"}]' >"$fx/files"
  FAKE_FAIL=
}

cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
url= filter=.
args=("$@")
for ((i = 1; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --jq) filter=${args[$((i + 1))]}; i=$((i + 1)) ;;
    --paginate) ;;
    *) [ -z "$url" ] && url=${args[$i]} ;;
  esac
done
case "$url" in
  */pulls/*/files*) f=files ;;
  */pulls/*) f=pull ;;
  */commits/*/statuses*) f=statuses ;;
  */commits/*/check-runs*) f=checkruns ;;
  */commits/*) f=commit ;;
  */actions/runs*) f=runs ;;
  */issues/*/events*) f=events ;;
  */issues/*/labels*) f=labels ;;
  *) echo "stub gh: unexpected $url" >&2; exit 1 ;;
esac
[ "${FAKE_FAIL:-}" = "$f" ] && exit 1
jq -r "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$fx

out=""
rc=0
run() {
  : >"$GH_LOG"
  out=$(FAKE_FAIL=${FAKE_FAIL:-} "$SCRIPT" "$@" 2>&1)
  rc=$?
}
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' \
      "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }

# --- decide: arm-door's verdict line to a check result ---
run decide 'KEEP gates-met proof=ci-green stamp=yes'
check 'gates-met passes' 0 "$rc"
run decide 'PULL no-proof'
check 'a missing verify proof alone passes (the required checks are the proof)' 0 "$rc"
run decide 'PULL no-security-label,no-proof'
check 'a missing Security label fails' 1 "$rc"
check 'it explains the reason' yes "$(has "$out" 'Security has not added security-reviewed')"
check 'it does not list no-proof' no "$(has "$out" 'no-proof')"
run decide 'PULL design-ok-older-than-head'
check 'a stale design-ok no longer blocks (Security-only, DOR-5119)' 0 "$rc"
check 'it still notes it for the daily sweep' yes "$(has "$out" 'daily sweep')"
run decide 'PULL no-security-label,no-qa-label,no-proof'
check 'Security still blocks beside a QA note' 1 "$rc"
check 'the QA reason is only a note' yes "$(has "$out" 'Note (not a merge gate; the daily sweep picks it up): no-qa-label')"
run decide 'KEEP unreadable headSeenAt'
check 'an unreadable verdict fails closed with exit 2' 2 "$rc"
run decide 'something else'
check 'an unknown verdict is exit 2' 2 "$rc"

# --- run: end to end through the real arm-door.sh ---
reset_fixtures
run run 12
check 'server change, Security label after the head: passes' 0 "$rc"
check 'it prints the arm-door verdict' yes "$(has "$out" 'arm-door verdict for #12')"

reset_fixtures
echo '[]' >"$fx/events"
run run 12
check 'no Security label: fails' 1 "$rc"
check 'and names it' yes "$(has "$out" 'no-security-label')"

reset_fixtures
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T09:00:00Z"}]' >"$fx/events"
run run 12
check 'a Security label from before the head: fails' 1 "$rc"
check 'and says it is older than the head' yes "$(has "$out" 'security-label-older-than-head')"

reset_fixtures
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T10:00:30Z"}]' >"$fx/events"
run run 12
check 'a label between the commit and when this PR got it: fails' 1 "$rc"

reset_fixtures
echo '[{"name":"needs-design"}]' >"$fx/labels"
run run 12
check 'needs-design with no design-ok: passes (not a merge gate)' 0 "$rc"
check 'and notes the design gate' yes "$(has "$out" 'no-design-ok')"

reset_fixtures
echo '[{"name":"needs-design"},{"name":"design-ok"}]' >"$fx/labels"
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T10:05:00Z"},{"event":"labeled","label":{"name":"design-ok"},"created_at":"2026-11-23T10:06:00Z"}]' >"$fx/events"
run run 12
check 'needs-design with a fresh design-ok: passes' 0 "$rc"

# --- the cloud Security lens stands in for Security's label (Nov 23) ---
sv() { # state login time
  printf '{"context":"security-verdict","state":"%s","creator":{"login":"%s"},"created_at":"%s","id":1}' "$1" "$2" "$3"
}
reset_fixtures
echo '[]' >"$fx/events"
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'no label, but a cloud Security pass at the head: passes' 0 "$rc"
check 'it says the cloud verdict counted' yes "$(has "$out" 'counts as Security')"

reset_fixtures
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T09:00:00Z"}]' >"$fx/events"
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'a stale label plus a cloud pass: passes' 0 "$rc"

reset_fixtures
echo '[]' >"$fx/events"
echo "[$(sv success 'someone' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'a security-verdict status not from GitHub Actions does not count' 1 "$rc"

reset_fixtures
echo '[]' >"$fx/events"
echo "[$(sv failure 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'a cloud fail does not count' 1 "$rc"

reset_fixtures
echo '[]' >"$fx/events"
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z),$(sv failure 'github-actions[bot]' 2026-11-23T10:20:00Z)]" >"$fx/statuses"
run run 12
check 'the newest cloud verdict wins (fail after pass)' 1 "$rc"

reset_fixtures
echo '[]' >"$fx/events"
echo '[{"name":"needs-design"}]' >"$fx/labels"
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'needs-design with only a cloud pass: passes' 0 "$rc"
check 'and notes the design gate' yes "$(has "$out" 'no-design-ok')"

for f in pull commit runs statuses checkruns events labels files; do
  reset_fixtures
  FAKE_FAIL=$f run run 12
  check "an unreadable $f fails closed with exit 2" 2 "$rc"
done
FAKE_FAIL=

reset_fixtures
REQUIRED_CHECKS=$tmp/missing.json run run 12
check 'a missing required-checks file is exit 2' 2 "$rc"

reset_fixtures
run payload 12
check 'payload mode prints JSON with the head' "$H" "$(jq -r .head <<<"$out" 2>/dev/null)"
check 'the payload carries the head-seen time' 2026-11-23T10:01:00Z "$(jq -r .headSeenAt <<<"$out" 2>/dev/null)"
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

run
check 'no arguments is a usage error' 2 "$rc"
run run 0
check 'PR 0 is a usage error' 2 "$rc"
run run 12 13
check 'two PR numbers is a usage error' 2 "$rc"

echo "pr-gates-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
