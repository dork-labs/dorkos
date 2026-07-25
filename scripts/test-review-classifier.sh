#!/usr/bin/env bash
# Fixture suite for scripts/classify-review-failure.sh, the thing that decides
# what the automated PR reviewer tells you when it fails.
#
# It exists because DOR-457 was a wrong message, not a crash: the old two-way
# split announced "ran out of its turn budget" for failures that never took a
# turn, and would have said the same for a usage limit crossed at turn 20. There
# were ad-hoc checks at the time and none covered the shape that actually
# happened. That gap WAS the bug, so the shapes are pinned here.
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
never-started.json           no
dirty-result-string.json     no
died-mid-run.json            died
error-during-execution.json  died
max-turns.json               max_turns
max-turns-at-turn-one.json   max_turns
two-results-last-wins.json   max_turns
clean-success.json           unknown
no-result-message.json       unknown
empty-array.json             unknown
malformed.json               unknown
CASES

# A log the action never got round to writing is the commonest case of all, and
# it must not crash or blame the turn budget.
check "class(missing file)" unknown "$(classify "$fixtures/does-not-exist.json")"
check "reported(missing file)" "" "$(reported "$fixtures/does-not-exist.json")"
check "reported(no result message)" "" "$(reported "$fixtures/no-result-message.json")"

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
