#!/usr/bin/env bash
# Fixture suite for scripts/run-credential-free.sh, the environment scrub behind
# the `credential-free-build` check (DOR-2081).
#
# That check is the only thing standing behind this repo's promise that it
# clones, builds, tests and runs with no hosted-side credentials of any kind.
# The scrub is a single loop of glob matches, and both ways it can break are
# silent:
#
#   * Too narrow — a variable family stops matching. Nothing crashes. The job
#     runs with that variable still set, goes green, and certifies a property it
#     never checked. This is the direction that matters, and it is exactly what
#     an "unset" implemented as `env: FOO: ''` would do on day one: the name
#     stays present in `process.env`, so every `!== undefined`, every
#     `'FOO' in process.env` and every Zod `.optional()` reads the opposite way
#     from a contributor's machine. Case 2 below pins that distinction directly.
#   * Too broad — it takes PATH, HOME, CI, NODE_OPTIONS or the GITHUB_* plumbing
#     Actions wires steps together with. That one at least announces itself with
#     a red job, but it would be read as "the credential-free build is broken"
#     rather than "the scrub is", so it is pinned too.
#
# Hermetic: every case runs the real script against a synthetic environment
# assembled with `env`, and the command it runs is a tiny bash probe. Nothing
# here touches pnpm, turbo, the network, or this repo's own environment.
#
#   bash scripts/test-run-credential-free.sh
#   CHECK=/path/to/other.sh bash scripts/test-run-credential-free.sh
#
# CHECK exists so a candidate rewrite can be run against the same fixtures.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/run-credential-free.sh}"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
}

bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

# Asserts that no line of a probe's output matches `$3`, and — the half that
# matters — that the probe produced verdicts at all. `probe` prints the single
# line PROBE-BROKEN when it did not get one verdict per requested name, and
# every caller of this helper is checking for an absence, so without this guard
# a probe that ran nothing would read exactly like a clean scrub.
assert_no_line() {
  local label="$1" out="$2" pattern="$3" message="$4"
  if printf '%s\n' "$out" | grep -qx 'PROBE-BROKEN'; then
    bad "$label: the probe itself failed — see its stderr above; this case proves nothing"
    return
  fi
  local hits
  hits=$(printf '%s\n' "$out" | grep "$pattern" | cut -d= -f1)
  if [ -z "$hits" ]; then
    ok
  else
    bad "$label: $message: $(printf '%s' "$hits" | tr '\n' ' ')"
  fi
}

# Runs the scrub over an environment built from `env` assignments, and prints
# one `NAME=present` or `NAME=absent` line per name asked about. "absent" is
# decided by `${!name+x}` — bash's indirect "is this NAME set at all" test —
# never by comparing the value to the empty string, which is precisely the
# confusion this suite exists to rule out. (`[ -v NAME ]` reads the same way and
# is deliberately NOT used: macOS ships bash 3.2, whose `test` builtin has no
# `-v`, so it reports every name as absent and every assertion below would pass
# by vacuum on the machine most likely to run this by hand.)
#
# The probe body is passed through `bash -c` as a positional argument list, so
# a name is never interpolated into the script text.
#
# Three of the cases below assert on the ABSENCE of a `=present` line, so a
# probe that printed nothing at all would satisfy them by vacuum — the
# zero-subject pass REVIEW.md names. Two things close that: stderr is NOT
# swallowed, so a broken invocation is visible, and the probe emits one line per
# requested name and fails loudly if the count comes back wrong. An assertion
# that cannot fail is worse than no assertion.
probe() {
  local -a assignments=()
  while [ "$#" -gt 0 ] && [ "$1" != '--' ]; do
    assignments+=("$1")
    shift
  done
  shift # the --
  local expected=$#
  local out
  out=$(env -i PATH="$PATH" HOME="$HOME" "${assignments[@]}" \
    bash "$CHECK" bash -c '
      for name in "$@"; do
        if [ -n "${!name+x}" ]; then printf "%s=present\n" "$name"; else printf "%s=absent\n" "$name"; fi
      done
    ' probe "$@")
  local got
  got=$(printf '%s\n' "$out" | grep -c '=\(present\|absent\)$')
  if [ "$got" -ne "$expected" ]; then
    echo "PROBE-BROKEN expected $expected verdict line(s), got $got" >&2
    printf 'PROBE-BROKEN\n'
    return 1
  fi
  printf '%s\n' "$out"
}

# Case 1: the named hosted-side families are gone. One representative of each
# pattern in the script, so a deleted pattern fails here naming itself.
out=$(probe \
  DORKOS_CLOUD_URL=https://example.invalid \
  DORKOS_MANAGED_CONNECTORS_ENABLED=true \
  DORKOS_MANAGED_COMPOSIO_PROJECT_KEY=k \
  BETTER_AUTH_SECRET=s \
  BETTER_AUTH_URL=https://example.invalid \
  ADMIN_USER_IDS=1 \
  GITHUB_CLIENT_ID=id \
  GITHUB_CLIENT_SECRET=secret \
  GOOGLE_CLIENT_ID=id \
  GOOGLE_CLIENT_SECRET=secret \
  DATABASE_URL=postgres://example.invalid/db \
  DATABASE_URL_UNPOOLED=postgres://example.invalid/db \
  NEON_API_KEY=k \
  COMPOSIO_API_KEY=k \
  NANGO_SECRET_KEY=k \
  STRIPE_SECRET_KEY=k \
  POSTHOG_PERSONAL_API_KEY=k \
  NEXT_PUBLIC_POSTHOG_KEY=k \
  NGROK_AUTHTOKEN=t \
  TUNNEL_ENABLED=true \
  VERCEL_ENV=production \
  MCP_API_KEY=k \
  -- \
  DORKOS_CLOUD_URL DORKOS_MANAGED_CONNECTORS_ENABLED DORKOS_MANAGED_COMPOSIO_PROJECT_KEY \
  BETTER_AUTH_SECRET BETTER_AUTH_URL ADMIN_USER_IDS GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DATABASE_URL DATABASE_URL_UNPOOLED NEON_API_KEY \
  COMPOSIO_API_KEY NANGO_SECRET_KEY STRIPE_SECRET_KEY POSTHOG_PERSONAL_API_KEY \
  NEXT_PUBLIC_POSTHOG_KEY NGROK_AUTHTOKEN TUNNEL_ENABLED VERCEL_ENV MCP_API_KEY)
assert_no_line 'case 1' "$out" '=present$' 'hosted-side variables survived the scrub'

# Case 2: EMPTY IS NOT UNSET, and this is the case the whole design turns on. A
# variable set to the empty string — what a workflow-level `env: FOO: ''` would
# produce — must come out ABSENT, not empty. If this case ever flips, the check
# starts certifying a build against an environment no contributor has.
out=$(probe DATABASE_URL= BETTER_AUTH_SECRET= -- DATABASE_URL BETTER_AUTH_SECRET)
if printf '%s\n' "$out" | grep -q '^DATABASE_URL=absent$' &&
  printf '%s\n' "$out" | grep -q '^BETTER_AUTH_SECRET=absent$'; then
  ok
else
  bad "empty-string variables were left present rather than unset: $out"
fi

# Case 3: a variable nobody has written yet, matched only by a prefix pattern.
# This is what a list of exact names could not do, and the reason the script
# uses globs — the hosted seam gains variables, and a scrub that covers only
# today's names stops covering the newest part of the seam silently.
out=$(probe \
  DORKOS_CLOUD_SOMETHING_NEW=1 \
  DORKOS_MANAGED_SOMETHING_NEW=1 \
  BETTER_AUTH_SOMETHING_NEW=1 \
  -- DORKOS_CLOUD_SOMETHING_NEW DORKOS_MANAGED_SOMETHING_NEW BETTER_AUTH_SOMETHING_NEW)
assert_no_line 'case 3' "$out" '=present$' 'a future variable matching an existing prefix survived'

# Case 4: the toolchain's own environment survives. Too broad a scrub is a red
# job that reads like a broken build rather than a broken gate, so the things
# that must NOT be swept are pinned by name — including the GITHUB_* plumbing
# Actions uses to wire steps together, which is why the script names
# GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET one at a time instead of globbing.
out=$(probe \
  CI=true \
  NODE_OPTIONS=--max-old-space-size=8192 \
  TURBO_SCM_BASE=deadbeef \
  DORK_HOME=/tmp/dork \
  DORKOS_PORT=4242 \
  DORKOS_SKIP_INSTANCE_LOCK=true \
  GITHUB_OUTPUT=/tmp/out \
  GITHUB_ENV=/tmp/env \
  GITHUB_WORKSPACE=/tmp/ws \
  GITHUB_ACTIONS=true \
  -- PATH HOME CI NODE_OPTIONS TURBO_SCM_BASE DORK_HOME DORKOS_PORT \
  DORKOS_SKIP_INSTANCE_LOCK GITHUB_OUTPUT GITHUB_ENV GITHUB_WORKSPACE GITHUB_ACTIONS)
assert_no_line 'case 4' "$out" '=absent$' 'the scrub took variables the toolchain needs'

# Case 5: the child's exit status is the script's exit status, in both
# directions. `exec` is what makes that true; a wrapper that swallowed a
# non-zero exit would turn every red build into a green check, which is the
# same fail-open shape as case 1 one layer out.
env -i PATH="$PATH" HOME="$HOME" bash "$CHECK" true >/dev/null 2>&1
rc_ok=$?
env -i PATH="$PATH" HOME="$HOME" bash "$CHECK" bash -c 'exit 7' >/dev/null 2>&1
rc_bad=$?
if [ "$rc_ok" -eq 0 ] && [ "$rc_bad" -eq 7 ]; then
  ok
else
  bad "exit status not propagated: success gave $rc_ok, 'exit 7' gave $rc_bad"
fi

# Case 6: called with no command at all, it refuses rather than exiting 0 on
# having done nothing. A silent no-op here is a workflow step that scrubs an
# environment and then runs no build in it.
out=$(env -i PATH="$PATH" HOME="$HOME" bash "$CHECK" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q '^usage:'; then
  ok
else
  bad "no command: expected exit 2 + usage, got rc=$rc output=$out"
fi

# Case 7: `--print` reports the names it would remove, and removes nothing. It
# is what the workflow puts in the log so a reader can see what the scrub
# actually found, and a report that named nothing while the scrub removed
# something would make that log a lie.
out=$(env -i PATH="$PATH" HOME="$HOME" DATABASE_URL=x BETTER_AUTH_SECRET=y CI=true \
  bash "$CHECK" --print 2>&1)
rc=$?
if [ "$rc" -eq 0 ] &&
  printf '%s\n' "$out" | grep -q 'DATABASE_URL' &&
  printf '%s\n' "$out" | grep -q 'BETTER_AUTH_SECRET' &&
  ! printf '%s\n' "$out" | grep -qx '  CI'; then
  ok
else
  bad "--print did not report exactly the hosted-side names: rc=$rc output=$out"
fi

# Case 8: a clean environment is reported as clean, not as an error. This is the
# normal case on a runner with no secrets configured, and the job must not read
# an empty report as a broken scrub.
out=$(env -i PATH="$PATH" HOME="$HOME" bash "$CHECK" --print 2>&1)
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'already clean\|no hosted-side variable is set'; then
  ok
else
  bad "clean environment: expected a clean report and exit 0, got rc=$rc output=$out"
fi

echo
echo "run-credential-free fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
