#!/usr/bin/env bash
# Fixture suite for scripts/arm-door.sh, the merge queue's door for the arm rule
# (.github/workflows/arm-door.yml).
#
# Both ways it can be wrong are pinned. A KEEP that matches too much lets a pull
# request with no Security label at its head, or no verify proof, merge. A PULL
# that matches too much takes a good pull request out of the queue: a careful
# manual merge, a docs-only change, a stamped arm, or one it could not read.
#
#   bash scripts/test-arm-door.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
door=$repo_root/scripts/arm-door.sh

if ! command -v jq >/dev/null 2>&1; then
  echo "arm-door fixtures: needs jq on PATH" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

H=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
O=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# A code PR, labelled after its head, every required check and all six shards
# green at the head, and no arm-record stamp.
base() {
  jq -n --arg h "$H" '
    def run($id; $n): {id: $id, name: $n, head_sha: $h, status: "completed", conclusion: "success", app: {slug: "github-actions"}};
    {
      head: $h,
      headCommittedAt: "2026-11-18T10:00:00Z",
      headSeenAt: "2026-11-18T10:00:30Z",
      labelEvents: ["2026-11-18T09:00:00Z", "2026-11-18T11:00:00Z"],
      statuses: [{id: 1, context: "security-review", state: "success", created_at: "2026-11-18T11:00:00Z"}],
      checkRuns: ([run(1; "typecheck"), run(2; "test"), run(3; "lint"), run(4; "no-fragment-under-skip-label")]
                  + [range(1; 7) as $k | run(10 + $k; "test-shard (\($k)/6)")]),
      required: ["typecheck", "test", "lint", "no-fragment-under-skip-label"],
      files: [{filename: "apps/client/src/a.ts"}],
      changedFiles: 1
    }'
}
stamp() { # state proof
  printf '{"id":9,"context":"arm-record","state":"%s","created_at":"2026-11-18T12:00:00Z","description":"armed by dorkos-2 session 0d4a1afe proof=%s"}' "$1" "$2"
}

# check <name> <expected-first-line> <jq-mutation-of-base>
check() {
  local name=$1 expected=$2 mutation=$3 got
  base | jq "$mutation" > "$tmp/p.json"
  got=$(bash "$door" verdict "$tmp/p.json" 2>/dev/null | head -n 1)
  if [[ "$got" == "$expected" ]]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL  %-52s expected %-44s got %s\n' "$name" "$expected" "${got:-<empty>}"
  fi
}

# Gates met.
check "a careful manual merge: CI green, labelled, no stamp" "KEEP gates-met proof=ci-green stamp=no" '.'
check "arm script stamp, local verify"             "KEEP gates-met proof=local-verify stamp=yes" ".statuses += [$(stamp success local-verify)]"
check "arm script stamp, PM waiver, CI red"        "KEEP gates-met proof=waiver stamp=yes" ".statuses += [$(stamp success waiver)] | .checkRuns[1].conclusion = \"failure\""
check "docs-only, no CI, no stamp"                 "KEEP gates-met proof=docs-only stamp=no" '.files = [{filename: "contributing/ci.md"}, {filename: "docs/a.mdx"}, {filename: "README.md"}] | .changedFiles = 3 | .checkRuns = []'
check "label exactly at the head time counts"      "KEEP gates-met proof=ci-green stamp=no" '.labelEvents = ["2026-11-18T10:00:30Z"]'
# DOR-4706: the pusher sets the committer date, so the head time is the later of it and when
# GitHub first saw the head (its earliest check suite).
check "backdated commit: an old label stays old"   "PULL security-label-older-than-head" '.headCommittedAt = "2026-11-01T00:00:00Z" | .headSeenAt = "2026-11-18T10:00:30Z" | .labelEvents = ["2026-11-10T00:00:00Z"]'
check "label after commit date, before GitHub saw it" "PULL security-label-older-than-head" '.labelEvents = ["2026-11-18T10:00:10Z"]'
check "a seen time earlier than the commit date"   "KEEP gates-met proof=ci-green stamp=no" '.headSeenAt = "2026-11-18T09:00:00Z" | .labelEvents = ["2026-11-18T10:00:00Z"]'
check "no seen time: keep (unreadable)"            "KEEP unreadable headSeenAt" 'del(.headSeenAt)'

# Gate 1: Security's label at the head, on every PR.
check "no label ever"                              "PULL no-security-label" '.labelEvents = []'
check "label only before the head"                 "PULL security-label-older-than-head" '.labelEvents = ["2026-11-18T09:59:59Z"]'
check "docs-only still needs the label"            "PULL no-security-label" '.labelEvents = [] | .files = [{filename: "docs/a.mdx"}] | .checkRuns = []'
check "a stamp doesn't stand in for the label"     "PULL no-security-label" ".labelEvents = [] | .statuses += [$(stamp success local-verify)]"

# Gate 2: a verify proof.
check "CI red, no stamp: no proof"                 "PULL no-proof" '.checkRuns[1].conclusion = "failure"'
check "a shard missing: no proof"                  "PULL no-proof" '.checkRuns |= map(select(.name != "test-shard (4/6)"))'
check "two-shard leg is short: no proof"           "PULL no-proof" '.checkRuns |= map(select(.name | startswith("test-shard") | not)) | .checkRuns += [{id: 30, name: "test-shard (1/2)", head_sha: "'"$H"'", status: "completed", conclusion: "success", app: {slug: "github-actions"}}]'
check "a pending required check: no proof"         "PULL no-proof" '.checkRuns[0].status = "in_progress" | .checkRuns[0].conclusion = null'
check "a non-Actions run can't stand in"           "PULL no-proof" '.checkRuns[1].app.slug = "other-app"'
check "a run for another head: no proof"           "PULL no-proof" '.checkRuns += [{id: 99, name: "x", head_sha: "'"$O"'", status: "completed", conclusion: "success", app: {slug: "github-actions"}}]'
check "newest re-run wins (red after green)"       "PULL no-proof" '.checkRuns += [{id: 50, name: "test", head_sha: "'"$H"'", status: "completed", conclusion: "failure", app: {slug: "github-actions"}}]'
check "newest re-run wins (green after red)"       "KEEP gates-met proof=ci-green stamp=no" '.checkRuns[1].conclusion = "failure" | .checkRuns += [{id: 50, name: "test", head_sha: "'"$H"'", status: "completed", conclusion: "success", app: {slug: "github-actions"}}]'
check "no-fragment may be skipped"                 "KEEP gates-met proof=ci-green stamp=no" '.checkRuns[3].conclusion = "skipped"'
check "another check skipped: no proof"            "PULL no-proof" '.checkRuns[2].conclusion = "skipped"'
check ".github/ PR can't use CI green"             "PULL no-proof" '.files = [{filename: ".github/workflows/x.yml"}]'
check "renamed from .github/ can't either"         "PULL no-proof" '.files = [{filename: "scripts/x.yml", previous_filename: ".github/workflows/x.yml"}]'
check "code renamed into docs/ isn't docs-only"    "PULL no-proof" '.files = [{filename: "docs/x.md", previous_filename: "apps/server/src/x.ts"}] | .checkRuns = []'
check "a .. path isn't docs"                       "PULL no-proof" '.files = [{filename: "docs/../apps/x.ts"}] | .checkRuns = []'
check "a withdrawn stamp gives no proof"           "PULL no-proof" ".checkRuns = [] | .statuses += [$(stamp failure local-verify)]"
check "an unknown stamp proof gives none"          "PULL no-proof" ".checkRuns = [] | .statuses += [$(stamp success anything)]"
check "both gates missing: both named"             "PULL no-security-label,no-proof" '.labelEvents = [] | .checkRuns = []'

# Never jam the queue: anything unreadable keeps the entry.
check "file list short of the count"               "KEEP unreadable files" '.changedFiles = 3000'
check "no required list"                           "KEEP unreadable required" '.required = []'
check "no head time"                               "KEEP unreadable headCommittedAt" 'del(.headCommittedAt)'
check "label events unreadable"                    "KEEP unreadable labelEvents" '.labelEvents = null'
check "short head sha"                             "KEEP unreadable head" '.head = "abc"'
printf 'not json' > "$tmp/bad.json"
got=$(bash "$door" verdict "$tmp/bad.json" 2>/dev/null | head -n 1)
if [[ "$got" == "KEEP unreadable payload" ]]; then pass=$(( pass + 1 )); else fail=$(( fail + 1 )); echo "FAIL  not JSON keeps (got $got)"; fi

# Notes carry a once-per-head-and-kind marker and name what is missing.
note=$(bash "$door" comment pull 3913 "$H" no-security-label,no-proof)
if grep -qF "<!-- arm-door pull head=$H -->" <<<"$note" && grep -qF "never added" <<<"$note" && grep -qF "No verify proof" <<<"$note" && ! grep -qF "older than this commit" <<<"$note"; then
  pass=$(( pass + 1 ))
else
  fail=$(( fail + 1 )); echo "FAIL  pull note names exactly what is missing"
fi
note=$(bash "$door" comment unarmed 3913 "$H" proof=ci-green)
if grep -qF "<!-- arm-door unarmed head=$H -->" <<<"$note" && grep -qF "stays in the queue" <<<"$note"; then
  pass=$(( pass + 1 ))
else
  fail=$(( fail + 1 )); echo "FAIL  unarmed note"
fi
bash "$door" verdict >/dev/null 2>&1; rc=$?
if [[ "$rc" == 2 ]]; then pass=$(( pass + 1 )); else fail=$(( fail + 1 )); echo "FAIL  verdict with no file exits 2 (got $rc)"; fi

echo "arm-door fixtures: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
