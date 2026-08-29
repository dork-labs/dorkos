#!/usr/bin/env bash
# Fixture suite for scripts/wait-for-npm.sh, the shared npm-availability wait
# used by publish-docker.yml and update-homebrew.yml (DOR-1606).
#
# The failure this script guards against is quiet in a specific way: a wait
# loop that gives up too early does not crash, it just exits 1 on a publish
# that was always going to succeed a few minutes later, and the next person to
# look sees a red release job with no obvious cause. That is exactly what
# shipped from v0.63.0 through v0.66.0 (a 5-minute wait against a 10-15 minute
# reality), copy-pasted into two workflows. This suite pins the three
# behaviors that matter: it refuses to run without a version, it exits 0 the
# moment npm answers (even after some early misses), and it exits 1 with a
# clear message once the timeout elapses — never silently, never past the
# deadline.
#
# It never calls the real `npm` or the real registry: a stub `npm` is placed
# first on PATH, and WAIT_FOR_NPM_POLL_SECONDS / WAIT_FOR_NPM_TIMEOUT_SECONDS
# (documented in wait-for-npm.sh's own header as test-only) collapse the
# 30-second poll interval and 30-minute timeout down to well under a second,
# so the whole suite runs instantly and hermetically.
#
#   bash scripts/test-wait-for-npm.sh
#   CHECK=/path/to/other.sh bash scripts/test-wait-for-npm.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/wait-for-npm.sh}"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

# Build a stub `npm` on its own PATH-only directory. `npm view ... version` is
# the only subcommand wait-for-npm.sh calls, so the stub only needs to answer
# that one. FAIL_COUNT_FILE, when set, makes the stub fail that many times
# before it starts succeeding, so the "eventually available" path can be
# exercised without a real registry.
make_npm_stub() {
  local dir="$1" mode="$2" fail_count="${3:-0}"
  mkdir -p "$dir"
  cat >"$dir/npm" <<EOF
#!/usr/bin/env bash
mode="$mode"
fail_count=$fail_count
counter_file="$dir/.calls"
if [ "\$mode" = "fail" ]; then
  exit 1
fi
if [ "\$mode" = "fail-then-succeed" ]; then
  calls=0
  [ -f "\$counter_file" ] && calls=\$(cat "\$counter_file")
  calls=\$((calls + 1))
  echo "\$calls" > "\$counter_file"
  if [ "\$calls" -le "\$fail_count" ]; then
    exit 1
  fi
  echo "9.9.9"
  exit 0
fi
echo "9.9.9"
exit 0
EOF
  chmod +x "$dir/npm"
}

# Case 1: no version argument at all — must refuse before touching npm.
out=$("$CHECK" 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '^usage:'; then
  ok
else
  bad "missing version: expected exit 1 + usage, got rc=$rc output=$out"
fi

# Case 2: npm answers on the very first poll.
stub_dir=$(mktemp -d)
make_npm_stub "$stub_dir" success
out=$(PATH="$stub_dir:$PATH" WAIT_FOR_NPM_POLL_SECONDS=0 WAIT_FOR_NPM_TIMEOUT_SECONDS=2 \
  "$CHECK" 1.2.3 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'Available after'; then
  ok
else
  bad "immediate success: expected exit 0 + 'Available after', got rc=$rc output=$out"
fi
rm -rf "$stub_dir"

# Case 3: npm misses twice, then answers — proves the poll loop actually
# retries instead of only ever checking once.
stub_dir=$(mktemp -d)
make_npm_stub "$stub_dir" fail-then-succeed 2
out=$(PATH="$stub_dir:$PATH" WAIT_FOR_NPM_POLL_SECONDS=0 WAIT_FOR_NPM_TIMEOUT_SECONDS=5 \
  "$CHECK" 1.2.3 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'attempt 3'; then
  ok
else
  bad "eventual success: expected exit 0 on the 3rd attempt, got rc=$rc output=$out"
fi
rm -rf "$stub_dir"

# Case 4: npm never answers — must exit 1 once the timeout elapses, with a
# clear ::error:: line, not just a bare nonzero exit.
stub_dir=$(mktemp -d)
make_npm_stub "$stub_dir" fail
out=$(PATH="$stub_dir:$PATH" WAIT_FOR_NPM_POLL_SECONDS=0 WAIT_FOR_NPM_TIMEOUT_SECONDS=1 \
  "$CHECK" 1.2.3 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '::error::.*not found on npm'; then
  ok
else
  bad "timeout: expected exit 1 + ::error:: line, got rc=$rc output=$out"
fi
rm -rf "$stub_dir"

# Case 5: the [timeout-minutes] argument still works on its own — a caller
# that never sets the test-only env vars (i.e. every real workflow) must still
# get a working timeout, computed in minutes rather than seconds.
stub_dir=$(mktemp -d)
make_npm_stub "$stub_dir" fail
# WAIT_FOR_NPM_TIMEOUT_SECONDS is intentionally unset here; only the poll
# interval is sped up, so this proves TIMEOUT_MINUTES * 60 is the real
# deadline math rather than something only the seconds override exercises.
out=$(env -u WAIT_FOR_NPM_TIMEOUT_SECONDS PATH="$stub_dir:$PATH" WAIT_FOR_NPM_POLL_SECONDS=0 \
  "$CHECK" 1.2.3 0 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '::error::'; then
  ok
else
  bad "minutes argument: expected a 0-minute timeout to fail fast, got rc=$rc output=$out"
fi
rm -rf "$stub_dir"

echo
echo "wait-for-npm fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
