#!/usr/bin/env bash
# Executable fixtures for the server test Supertest import boundary.
#
# The real flat config is exercised through stdin filenames so this suite pins
# both the generic test block and every owner-directory replacement block. It
# also proves the existing SDK confinement remains effective after composing
# the Supertest ban. No fixture is written to the repository.

set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
server_dir=$(cd "$script_dir/../apps/server" && pwd)

pass=0
fail=0

lint_result() {
  local filename=$1 source=$2
  printf '%s\nexport const fixtureValue = 1;\n' "$source" |
    (cd "$server_dir" && npx --no-install eslint --stdin --stdin-filename "$filename" 2>&1)
}

check() {
  local name=$1 filename=$2 source=$3 verdict=$4 message_fragment=${5:-}
  local output status
  output=$(lint_result "$filename" "$source")
  status=$?

  if [ "$verdict" = banned ]; then
    if [ "$status" -eq 0 ] || ! grep -q 'error.*no-restricted-imports' <<<"$output"; then
      printf 'FAIL  %s\n      expected an error and non-zero exit for %s\n%s\n' \
        "$name" "$filename" "$output"
      fail=$((fail + 1))
      return
    fi
    if [ -n "$message_fragment" ] && ! grep -Fq "$message_fragment" <<<"$output"; then
      printf 'FAIL  %s\n      expected diagnostic containing: %s\n%s\n' \
        "$name" "$message_fragment" "$output"
      fail=$((fail + 1))
      return
    fi
  elif [ "$status" -ne 0 ]; then
    printf 'FAIL  %s\n      expected lint to pass for %s\n%s\n' "$name" "$filename" "$output"
    fail=$((fail + 1))
    return
  fi

  printf 'ok    %s\n' "$name"
  pass=$((pass + 1))
}

ordinary=src/routes/__tests__/probe.test.ts
sibling=src/routes/probe.test.ts
facade_message='Import request and its types from @dorkos/test-utils/supertest'

echo '--- direct Supertest imports are rejected in ordinary route tests ---'
check 'default root import' "$ordinary" "import request from 'supertest';" banned "$facade_message"
check 'named runtime root import' "$ordinary" "import { agent } from 'supertest';" banned "$facade_message"
check 'legal package subpath import' "$ordinary" "import request from 'supertest/index.js';" banned "$facade_message"
check 'direct type import follows the same boundary' "$ordinary" \
  "import type { Test } from 'supertest';" banned "$facade_message"
check 'facade default import' "$ordinary" \
  "import request from '@dorkos/test-utils/supertest'; void request;" allowed
check 'facade type import' "$ordinary" \
  "import type { Test } from '@dorkos/test-utils/supertest'; type T = Test;" allowed
check 'sibling test rejects the root import' "$sibling" \
  "import request from 'supertest';" banned "$facade_message"
check 'sibling test rejects the package subpath' "$sibling" \
  "import request from 'supertest/index.js';" banned "$facade_message"
check 'sibling test accepts the facade' "$sibling" \
  "import request from '@dorkos/test-utils/supertest'; void request;" allowed

echo '--- every owner-directory test block keeps the facade boundary ---'
owner_dirs=(
  src/services/terminal
  src/services/observability
  src/services/runtimes/claude-code
  src/services/runtimes/codex
  src/services/runtimes/opencode
)
for dir in "${owner_dirs[@]}"; do
  for filename in "$dir/__tests__/probe.test.ts" "$dir/probe.test.ts"; do
    check "$filename rejects Supertest" "$filename" "import request from 'supertest';" banned "$facade_message"
    check "$filename rejects the package subpath" "$filename" \
      "import request from 'supertest/index.js';" banned "$facade_message"
    check "$filename accepts the facade" "$filename" \
      "import request from '@dorkos/test-utils/supertest'; void request;" allowed
    check "$filename accepts facade types" "$filename" \
      "import type { Response } from '@dorkos/test-utils/supertest'; type R = Response;" allowed
  done
done

echo '--- owner SDK allowances and cross-owner bans remain intact ---'
check 'terminal keeps node-pty allowance' src/services/terminal/__tests__/probe.test.ts \
  "import pty from 'node-pty'; void pty;" allowed
check 'terminal keeps cross-owner Codex ban' src/services/terminal/__tests__/probe.test.ts \
  "import { Codex } from '@openai/codex-sdk'; void Codex;" banned
check 'observability keeps OpenTelemetry allowance' src/services/observability/__tests__/probe.test.ts \
  "import { trace } from '@opentelemetry/api'; void trace;" allowed
check 'observability keeps cross-owner Claude ban' src/services/observability/__tests__/probe.test.ts \
  "import { query } from '@anthropic-ai/claude-agent-sdk'; void query;" banned
check 'claude-code keeps own SDK allowance' src/services/runtimes/claude-code/__tests__/probe.test.ts \
  "import { query } from '@anthropic-ai/claude-agent-sdk'; void query;" allowed
check 'claude-code keeps cross-owner Codex ban' src/services/runtimes/claude-code/__tests__/probe.test.ts \
  "import { Codex } from '@openai/codex-sdk'; void Codex;" banned
check 'codex keeps own SDK allowance' src/services/runtimes/codex/__tests__/probe.test.ts \
  "import { Codex } from '@openai/codex-sdk'; void Codex;" allowed
check 'codex keeps cross-owner OpenCode ban' src/services/runtimes/codex/__tests__/probe.test.ts \
  "import { createOpencode } from '@opencode-ai/sdk'; void createOpencode;" banned
check 'opencode keeps own SDK allowance' src/services/runtimes/opencode/__tests__/probe.test.ts \
  "import { createOpencode } from '@opencode-ai/sdk'; void createOpencode;" allowed
check 'opencode keeps cross-owner Claude ban' src/services/runtimes/opencode/__tests__/probe.test.ts \
  "import { query } from '@anthropic-ai/claude-agent-sdk'; void query;" banned

printf '\n%d passed, %d failed\n' "$pass" "$fail"
test "$fail" -eq 0
