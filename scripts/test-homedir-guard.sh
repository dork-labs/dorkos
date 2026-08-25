#!/usr/bin/env bash
# Fixtures for the os.homedir() ban (Hard Rule 3) in apps/server/eslint.config.js.
#
# This suite exists because that guard spent its whole life enforcing nothing and
# nobody could tell (DOR-668). It was a `no-restricted-imports` ban on the NAMED
# import, and the server spells the call `import os from 'os'` + `os.homedir()`,
# which that rule cannot see. No file in apps/server/src used the named spelling,
# so the rule never had anything to catch, and four real calls sat under it while
# `eslint` exited 0.
#
# A lint rule that stops matching does not crash. It reports success on a file it
# should have failed, which is indistinguishable from the file being clean — the
# same failure mode as scripts/assert-tests-executed.sh (a cached "29 successful"
# that ran nothing) and for the same reason it is pinned here. Deleting the whole
# block from eslint.config.js leaves nothing but two "Unused eslint-disable
# directive" warnings among twenty-eight others, and the lint still exits 0.
#
# So every case below asserts a VERDICT against the real config, not the presence
# of config text: N spellings must error, M carve-out paths must not.
#
# Hermetic: nothing is written to disk. `eslint --stdin --stdin-filename <path>`
# lints text as if it lived at that path, which is what makes the per-directory
# `files`/`ignores` globs — the part that actually drifts — the thing under test.
#
# Run directly, or via `pnpm test:scripts` from the repo root.
#
# On CI this runs in the `scripts-test` workflow, which is NOT a required check
# on main — the required contexts are typecheck, fragment-present,
# no-fragment-under-skip-label and version-outranks-base. It is still enforced:
# should-arm-automerge.sh refuses to arm auto-merge while any check from
# `gh pr checks` reports a failure, so a red run here stops merge-tail landing
# the PR. Do not "fix" that by making this check required — a required check
# must also report on `merge_group` or it deadlocks the queue, and this one
# deliberately does not.

set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
server_dir=$(cd "$script_dir/.." && pwd)/apps/server

pass=0
fail=0

# Lint $2 (source text) as if it were the file at $1 and echo the rule ids that
# fired AT ERROR SEVERITY. Only the two homedir rules are of interest;
# jsdoc/max-lines/unused-vars noise from a two-line fixture is irrelevant and
# must not be read as a verdict.
#
# The severity column is part of the assertion, not decoration. ESLint prints the
# rule id for warnings too, and exits 0 on a file whose only problems are
# warnings — so a suite that grepped the bare rule id would stay green while the
# guard stopped failing anything. That is not a hypothetical edit: this ban is an
# error while packages/eslint-config/base.js is deliberately warn-first, so
# "make the server config consistent with the base" lands exactly there. Whether
# it is an error is also the axis the whole design turns on (see the severity
# argument beside HOMEDIR_MEMBER_BAN in apps/server/eslint.config.js).
lint_as() {
  local filename=$1 source=$2
  printf '%s' "$source" |
    (cd "$server_dir" && npx --no-install eslint --stdin --stdin-filename "$filename" 2>&1) |
    grep -E '^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+error[[:space:]]' |
    grep -oE 'no-restricted-(imports|properties)' |
    sort -u |
    tr '\n' ' '
}

# Whether `eslint` itself failed on $2 linted as $1. The severity column above is
# read out of a formatted report; this reads the exit status the build actually
# consumes, so the two cannot drift apart.
lint_exit_code() {
  printf '%s' "$2" |
    (cd "$server_dir" && npx --no-install eslint --stdin --stdin-filename "$1" >/dev/null 2>&1)
  echo $?
}

#   $1 — case name
#   $2 — stdin-filename the fixture is linted as
#   $3 — fixture source
#   $4 — rule that must fire ('' means the guard must stay silent)
check() {
  local name=$1 filename=$2 source=$3 want=$4
  local got
  got=$(lint_as "$filename" "$source")
  got=${got% }

  if [ -z "$want" ]; then
    if [ -n "$got" ]; then
      printf 'FAIL  %s\n      %s is a declared carve-out, but the guard fired: %s\n' \
        "$name" "$filename" "$got"
      fail=$((fail + 1))
      return
    fi
  elif [[ " $got " != *" $want "* ]]; then
    printf 'FAIL  %s\n      expected %s to fire on %s, got: %s\n' \
      "$name" "$want" "$filename" "${got:-<nothing>}"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

#   $1 — case name
#   $2 — stdin-filename the fixture is linted as
#   $3 — fixture source
#   $4 — 'fails' if eslint must exit non-zero, 'passes' if it must exit 0
check_build() {
  local name=$1 filename=$2 source=$3 want=$4
  local status
  status=$(lint_exit_code "$filename" "$source")

  if [ "$want" = fails ] && [ "$status" -eq 0 ]; then
    printf 'FAIL  %s\n      eslint exited 0 on %s — the ban reports, but fails nothing\n' \
      "$name" "$filename"
    fail=$((fail + 1))
    return
  fi
  if [ "$want" = passes ] && [ "$status" -ne 0 ]; then
    printf 'FAIL  %s\n      eslint exited %s on %s, which is a declared carve-out\n' \
      "$name" "$status" "$filename"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

#   $1 — case name
#   $2 — stdin-filename the fixture is linted as
#   $3 — import statement under test
#   $4 — 'banned' or 'allowed'
check_sdk() {
  local name=$1 filename=$2 statement=$3 want=$4
  local hits
  hits=$(printf '%s\nexport const a = 1;\n' "$statement" |
    (cd "$server_dir" && npx --no-install eslint --stdin --stdin-filename "$filename" 2>&1) |
    grep -cE '^[[:space:]]+[0-9]+:[0-9]+[[:space:]]+error[[:space:]]')

  if [ "$want" = banned ] && [ "$hits" -eq 0 ]; then
    printf 'FAIL  %s\n      %s is confined, but linted clean in %s\n' "$name" "$statement" "$filename"
    fail=$((fail + 1))
    return
  fi
  if [ "$want" = allowed ] && [ "$hits" -ne 0 ]; then
    printf 'FAIL  %s\n      %s is that directory'"'"'s own SDK, but was rejected in %s\n' \
      "$name" "$statement" "$filename"
    fail=$((fail + 1))
    return
  fi
  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

IMPORTS='no-restricted-imports'
PROPS='no-restricted-properties'

# Every spelling of the call. The member-expression cases are the ones the
# original guard was blind to; the named/namespace cases are the ones it caught,
# pinned so a future edit cannot trade one half for the other.
ORDINARY=$'import os from \'os\';\nexport const a = os.homedir();\n'
NAMED=$'import { homedir } from \'os\';\nexport const a = homedir();\n'
NAMED_NODE=$'import { homedir } from \'node:os\';\nexport const a = homedir();\n'
NAMESPACE=$'import * as os from \'os\';\nexport const a = os.homedir();\n'
RENAMED=$'import nodeOs from \'node:os\';\nexport const a = nodeOs.homedir();\n'
REQUIRED=$'export const a = require(\'os\').homedir();\n'
USERINFO=$'import os from \'os\';\nexport const a = os.userInfo().homedir;\n'
SIBLINGS=$'import os from \'os\';\nexport const a = [os.tmpdir(), os.platform(), os.hostname()];\n'

echo '--- the spellings, in ordinary server code ---'
check 'default import + member call' src/services/core/probe.ts "$ORDINARY" "$PROPS"
check 'named import'                 src/services/core/probe.ts "$NAMED" "$IMPORTS"
check 'named import from node:os'    src/services/core/probe.ts "$NAMED_NODE" "$IMPORTS"
check 'namespace import'             src/services/core/probe.ts "$NAMESPACE" "$IMPORTS"
check 'renamed default import'       src/services/core/probe.ts "$RENAMED" "$PROPS"
check 'require() + member call'      src/services/core/probe.ts "$REQUIRED" "$PROPS"
check 'userInfo().homedir back door' src/services/core/probe.ts "$USERINFO" "$PROPS"

# src/routes/ is where test-control.ts lives — the file whose os.homedir() call
# reached through the original guard. A ban that stopped covering routes/ would
# let that exact regression back in.
echo '--- the top-level source directories ---'
check 'src/routes'     src/routes/probe.ts "$ORDINARY" "$PROPS"
check 'src/lib'        src/lib/probe.ts "$ORDINARY" "$PROPS"
check 'src/middleware' src/middleware/probe.ts "$ORDINARY" "$PROPS"

# Reporting is not failing. Both halves of the ban must exit non-zero.
echo '--- the ban fails the build, not just the report ---'
check_build 'member call fails eslint' src/services/core/probe.ts "$ORDINARY" fails
check_build 'named import fails eslint' src/services/core/probe.ts "$NAMED" fails
check_build 'a carve-out still exits 0' src/lib/dork-home.ts "$ORDINARY" passes

# The import half is restated per directory, so it is the half that loses
# coverage when someone adds a block. observability and claude-code both reached
# main with no import ban at all: the main block ignores them, and nothing
# re-added one. Each directory that gets its own block gets a case here.
echo '--- every directory with its own no-restricted-imports block ---'
for dir in \
  src/services/observability \
  src/services/terminal \
  src/services/runtimes/claude-code \
  src/services/runtimes/codex \
  src/services/runtimes/opencode; do
  check "$dir — bare call from a named import" "$dir/probe.ts" "$NAMED" "$IMPORTS"
  check "$dir — member call" "$dir/probe.ts" "$ORDINARY" "$PROPS"
done

# lib/boundary.ts is carved out per CALL SITE, not per file: its two legitimate
# calls carry inline disables. A new call anywhere else in it must still fail, or
# the carve-out has quietly become a whole-file exemption.
# Those per-directory blocks are the ONLY thing that supplies
# `no-restricted-imports` to a test directory, because the server-wide block
# ignores __tests__. So exempting a directory's tests from the homedir ban by
# adding `ignores` to its one block silently drops its SDK bans too — which is
# how `@openai/codex-sdk` became importable from claude-code/__tests__ during
# DOR-668. Each directory carves its tests out of the homedir ban and keeps
# every SDK ban, and both halves of that are pinned here.
echo '--- adapter test dirs keep SDK confinement (Hard Rule 2) ---'
check_sdk 'terminal tests ban the claude SDK' \
  src/services/terminal/__tests__/probe.test.ts \
  "import x from '@anthropic-ai/claude-agent-sdk';" banned
check_sdk 'observability tests ban node-pty' \
  src/services/observability/__tests__/probe.test.ts "import x from 'node-pty';" banned
check_sdk 'claude-code tests ban the codex SDK' \
  src/services/runtimes/claude-code/__tests__/probe.test.ts \
  "import x from '@openai/codex-sdk';" banned
check_sdk 'codex tests ban the opencode SDK' \
  src/services/runtimes/codex/__tests__/probe.test.ts \
  "import x from '@opencode-ai/sdk';" banned
check_sdk 'opencode tests ban the claude SDK' \
  src/services/runtimes/opencode/__tests__/probe.test.ts \
  "import x from '@anthropic-ai/claude-agent-sdk';" banned
check_sdk 'claude-code tests may import their OWN SDK' \
  src/services/runtimes/claude-code/__tests__/probe.test.ts \
  "import x from '@anthropic-ai/claude-agent-sdk';" allowed

echo '--- the per-call-site carve-out is not a whole-file one ---'
check 'a new call in lib/boundary.ts' src/lib/boundary.ts "$ORDINARY" "$PROPS"

echo '--- declared carve-outs stay silent ---'
check 'lib/dork-home.ts' src/lib/dork-home.ts "$ORDINARY" ''
check 'claude-config-dir.ts' \
  src/services/runtimes/claude-code/claude-config-dir.ts "$ORDINARY" ''
check 'codex-home.ts' \
  src/services/runtimes/codex/codex-home.ts "$ORDINARY" ''
check 'a test under __tests__/' src/services/core/__tests__/probe.test.ts "$ORDINARY" ''
check 'a test beside its source' src/services/core/probe.test.ts "$ORDINARY" ''

# `.claude/rules/dork-home.md` states the test carve-out without qualification,
# so it has to hold in every directory — including the five that carry their own
# import-ban block, where it is a separate line of config that can drift.
for dir in \
  src/services/observability \
  src/services/terminal \
  src/services/runtimes/claude-code \
  src/services/runtimes/codex \
  src/services/runtimes/opencode; do
  check "$dir/__tests__ — member call" "$dir/__tests__/probe.test.ts" "$ORDINARY" ''
  check "$dir/__tests__ — named import" "$dir/__tests__/probe.test.ts" "$NAMED" ''
  check "$dir — *.test.ts beside source" "$dir/probe.test.ts" "$NAMED" ''
done

# claude-config-dir.ts is exempt from the CALL ban by name, but the IMPORT ban
# still reaches it — it is ordinary claude-code source. That is invisible today
# because it spells the call `import os from 'os'`, which the import ban cannot
# see. Pinned so the constraint is enforced rather than merely written down: the
# carve-out survives an import-style refactor only in this direction, and
# `.claude/rules/dork-home.md` says so.
echo '--- the claude-config-dir carve-out is spelling-dependent, as documented ---'
check 'default import stays exempt' \
  src/services/runtimes/claude-code/claude-config-dir.ts "$ORDINARY" ''
check 'named import is still refused' \
  src/services/runtimes/claude-code/claude-config-dir.ts "$NAMED" "$IMPORTS"

# codex-home.ts is the second file-level carve-out, added on DOR-683 for the same
# reason and therefore with the same constraint: it is exempt from the CALL ban
# by name, while the IMPORT ban still reaches it as ordinary codex source.
echo '--- the codex-home carve-out is the same shape ---'
check 'default import stays exempt' \
  src/services/runtimes/codex/codex-home.ts "$ORDINARY" ''
check 'named import is still refused' \
  src/services/runtimes/codex/codex-home.ts "$NAMED" "$IMPORTS"
check 'a sibling in the same directory is NOT exempt' \
  src/services/runtimes/codex/codex-runtime.ts "$ORDINARY" "$PROPS"

# If this fired, the ban would be unusable: os.tmpdir() is how every test in the
# server stages a fixture directory.
echo '--- the rest of the os module is untouched ---'
check 'os.tmpdir / platform / hostname' src/services/core/probe.ts "$SIBLINGS" ''

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
