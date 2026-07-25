#!/usr/bin/env bash
# Fixture suite for scripts/classify-review-failure.sh, the thing that decides
# what the automated PR reviewer tells you when it fails.
#
# It exists because DOR-457 was a wrong message, not a crash: the old two-way
# split announced "ran out of its turn budget" for failures that never took a
# turn, and would have said the same for a usage limit crossed at turn 20. There
# were ad-hoc checks at the time and none covered the shape that actually
# happened. That gap WAS the bug, so the shapes are pinned here — and it bit a
# second time (review round 3, finding 2), when an error subtype that died at turn
# 1 was announced as a credentials problem because no fixture covered that shape
# either. A branch without a fixture is how this keeps going wrong.
#
#   bash scripts/test-review-classifier.sh
#   CLASSIFIER=/path/to/other.sh bash scripts/test-review-classifier.sh
#
# CLASSIFIER exists so an alternative implementation (say, the pre-fix version)
# can be run against the same fixtures to show what it gets wrong.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
classifier=${CLASSIFIER:-$repo_root/scripts/classify-review-failure.sh}
fixtures=$repo_root/scripts/fixtures/review-failure

# The classifier shells out to these. Both ship on ubuntu-latest and on macOS, so
# a miss means an unusual local box — say so plainly instead of failing every
# assertion with empty output.
for tool in jq iconv; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "review-failure classifier: needs $tool on PATH (used by scripts/classify-review-failure.sh)" >&2
    exit 2
  fi
done

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

classify() { bash "$classifier" class "$1"; }
reported() { bash "$classifier" reported "$1"; }

# Every fixture and the class it must produce. Each line documents the real
# situation it stands for; see scripts/fixtures/review-failure/README.md.
while read -r fixture expected; do
  [ -n "${fixture:-}" ] || continue
  check "class($fixture)" "$expected" "$(classify "$fixtures/$fixture")"
done <<'CASES'
never-started.json                        no
dirty-result-string.json                  no
died-mid-run.json                         died
error-during-execution.json               died
error-during-execution-at-turn-one.json   died
error-during-execution-no-cost-field.json died
error-unknown-subtype-no-turns.json       died
max-turns.json                            max_turns
max-turns-at-turn-one.json                max_turns
two-results-last-wins.json                max_turns
clean-success.json                        completed
no-result-message.json                    unknown
empty-array.json                          unknown
malformed.json                            unknown
CASES

# A log the action never got round to writing is the commonest case of all, and
# it must not crash or blame the turn budget.
check "class(missing file)" unknown "$(classify "$fixtures/does-not-exist.json")"
check "reported(missing file)" "" "$(reported "$fixtures/does-not-exist.json")"
check "reported(no result message)" "" "$(reported "$fixtures/no-result-message.json")"

# Every error_* subtype reports through `errors[]`, not `result` — SDKResultError
# has no `result` field. Without the fallback the whole `died`/`max_turns` space
# would post a failure comment with no cause in it.
check "reported(errors[] fallback)" \
  "MCP server github_inline_comment exited unexpectedly" \
  "$(reported "$fixtures/error-during-execution.json")"
check "reported(result wins over errors[])" \
  "Claude AI usage limit reached|1753500000" \
  "$(reported "$fixtures/died-mid-run.json")"
check "reported(no result, no errors)" "" "$(reported "$fixtures/max-turns.json")"

# The error string is model/API text posted verbatim into a public comment.
# Backticks would break out of its code fence, token-shaped strings must never be
# echoed, and truncation must not leave a half-written multi-byte character.
dirty=$(reported "$fixtures/dirty-result-string.json")
check "reported(sanitized)" \
  "Error: request failed. Auth token [redacted] and [redacted] rejected — retry later. 你好世界 你好世界 你好" \
  "$dirty"
check "reported(single line)" 1 "$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
check "reported(no backticks)" 0 "$(printf '%s' "$dirty" | tr -cd '`' | wc -c | tr -d ' ')"
check "reported(valid utf-8)" ok \
  "$(printf '%s' "$dirty" | iconv -f utf-8 -t utf-8 >/dev/null 2>&1 && echo ok || echo invalid)"
presence() { case "$2" in *"$1"*) echo present ;; *) echo absent ;; esac; }
for shape in 'sk-ant-' 'ghs_'; do
  check "reported(strips $shape)" absent "$(presence "$shape" "$dirty")"
done

total=$((pass + fail))
if [ "$fail" -gt 0 ]; then
  echo "review-failure classifier: $fail of $total checks FAILED" >&2
  exit 1
fi
echo "review-failure classifier: $total checks OK"
