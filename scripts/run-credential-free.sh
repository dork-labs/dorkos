#!/usr/bin/env bash
# Run a command with every hosted-side ("cloud") environment variable UNSET.
#
#   bash scripts/run-credential-free.sh pnpm exec turbo build typecheck lint
#   bash scripts/run-credential-free.sh --print        # list what it would unset
#
# WHY THIS EXISTS. This repo promises it can be cloned, built, tested and run on
# its own, with no access to the hosted control plane and no credentials of any
# kind. Until DOR-2081 nothing checked that promise. The failure it guards
# against is narrow and specific: a module that reads one of these variables at
# IMPORT time and throws, type-errors or reds a test when it is absent. Unset
# must mean "that feature is off", never "the build is broken".
#
# UNSET, NOT EMPTY, AND THAT DISTINCTION IS THE WHOLE POINT. A workflow-level
# `env: DATABASE_URL: ''` does NOT reproduce a contributor's machine. It leaves
# the name PRESENT in `process.env` with an empty-string value, so
# `process.env.DATABASE_URL !== undefined` is true, `'DATABASE_URL' in
# process.env` is true, and a Zod `z.string().optional()` parses `''` as a
# present-but-empty string rather than skipping the field. Every one of those
# reads the opposite way round from the environment this job is supposed to
# simulate. So this script removes the NAMES, and its fixture suite
# (scripts/test-run-credential-free.sh) pins exactly that: a variable set to the
# empty string before the call is ABSENT after it, not empty.
#
# PREFIX PATTERNS, NOT A HAND-KEPT LIST OF NAMES. The hosted seam gains
# variables — nine `DORKOS_MANAGED_*` today, more later — and a list of exact
# names is a list that goes stale silently: the new variable is simply not
# scrubbed, the job stays green, and the gate quietly stops covering the newest
# and least-proven part of the seam. Patterns cover what has not been written
# yet. The cost is that a new variable which HAPPENS to match a prefix is
# scrubbed without anyone deciding so, which is the safe direction: this job
# only ever removes things, and removing one that the build genuinely needed is
# a red check that names it.
#
# WHAT IS DELIBERATELY NOT SCRUBBED. Anything the toolchain itself needs to run:
# PATH, HOME, CI, NODE_*, TURBO_*, the `GITHUB_*` variables Actions uses to wire
# steps together (GITHUB_OUTPUT, GITHUB_ENV, GITHUB_WORKSPACE), and the DorkOS
# variables that configure a LOCAL run rather than a hosted one (DORK_HOME,
# DORKOS_PORT, DORKOS_SKIP_INSTANCE_LOCK). `GITHUB_CLIENT_ID` and
# `GITHUB_CLIENT_SECRET` are named exactly, one at a time, precisely so a
# `GITHUB_*` pattern cannot take the Actions plumbing with it.
#
# The unsetting happens in THIS shell, before `exec`, so the child process and
# everything it spawns inherit an environment from which the names are gone. An
# `env -i` invocation would be stricter still and is the wrong tool here: it
# would also drop PATH, HOME and the Node/pnpm/turbo variables the build needs,
# so the job would fail for reasons that have nothing to do with credentials.
set -euo pipefail

# Every hosted-side variable family, as bash glob patterns matched against
# variable NAMES. Keep this list, the header above, and the fixture suite in
# step; the fixtures assert on the patterns, not on a copy of them.
CLOUD_ENV_PATTERNS=(
  # The DorkOS Cloud seam itself. `DORKOS_CLOUD_*` is the namespace new work on
  # this seam is expected to use; the nine `DORKOS_MANAGED_*` variables are the
  # hosted managed-connector configuration that apps/site parses at the request
  # boundary.
  'DORKOS_CLOUD_*'
  'DORKOS_MANAGED_*'
  # Accounts and sessions.
  'BETTER_AUTH_*'
  'ADMIN_USER_IDS'
  # Social sign-in. Named one at a time so no `GITHUB_*` pattern exists here to
  # sweep up GITHUB_OUTPUT / GITHUB_ENV / GITHUB_WORKSPACE with them.
  'GITHUB_CLIENT_ID'
  'GITHUB_CLIENT_SECRET'
  'GOOGLE_CLIENT_ID'
  'GOOGLE_CLIENT_SECRET'
  # The hosted database. The trailing `*` also covers DATABASE_URL_UNPOOLED.
  'DATABASE_URL*'
  'NEON_*'
  # Hosted vendors the app can talk to but must never require.
  'COMPOSIO_*'
  'NANGO_*'
  'STRIPE_*'
  'POSTHOG_*'
  'NEXT_PUBLIC_POSTHOG_*'
  # The tunnel broker and the ngrok token behind it.
  'NGROK_*'
  'TUNNEL_*'
  # The deployment platform's injected system environment. Present only on a
  # hosted build; a contributor's machine has none of it, and apps/site derives
  # its auth origin from it, so it belongs in the scrub.
  'VERCEL_*'
  # The optional static override for the external MCP server's auth. Never the
  # thing that turns auth on, and never required to boot.
  'MCP_API_KEY'
)

# Names in this shell that match any pattern above. `compgen -v` lists variable
# names only, so a value containing a newline or an `=` cannot confuse the
# match the way parsing `env` output would.
matching_names() {
  local name pattern
  for name in $(compgen -v); do
    for pattern in "${CLOUD_ENV_PATTERNS[@]}"; do
      # Unquoted right-hand side so the pattern is a glob, not a literal.
      # shellcheck disable=SC2053
      if [[ $name == $pattern ]]; then
        printf '%s\n' "$name"
        break
      fi
    done
  done
}

names=$(matching_names || true)

if [ "${1:-}" = '--print' ]; then
  # Reports what IS set and would be removed. An empty report is the normal,
  # healthy answer on a CI runner with no secrets configured — it means the
  # environment was already clean, not that the scrub did nothing.
  if [ -z "$names" ]; then
    echo 'credential-free: no hosted-side variable is set in this environment.'
  else
    echo 'credential-free: these hosted-side variables are set and would be unset:'
    printf '%s\n' "$names" | sort | sed 's/^/  /'
  fi
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo 'usage: run-credential-free.sh [--print] <command> [args...]' >&2
  exit 2
fi

if [ -n "$names" ]; then
  echo "credential-free: unsetting $(printf '%s\n' "$names" | wc -l | tr -d ' ') hosted-side variable(s): $(printf '%s\n' "$names" | sort | tr '\n' ' ')"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    unset "$name"
  done <<EOF
$names
EOF
else
  echo 'credential-free: no hosted-side variable was set; the environment was already clean.'
fi

# `exec` so the command's exit status is this script's exit status with no
# wrapper in between — a non-zero exit here is the command's own verdict.
exec "$@"
