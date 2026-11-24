#!/usr/bin/env bash
# Fixture suite for scripts/open-pr.sh, the one supported way to open a PR.
#
# Every rule the script carries is pinned here, because the rules it replaces
# lived in prose and drifted (2026-11-20: a brief said "open with hold", the arm
# script refused hold and never lifted it, and 19 PRs sat for 9 hours). Each
# case builds a real branch in a throwaway git repo with a local bare origin,
# and runs the script against a stubbed `gh` (GH=..., and on PATH for the cap
# script) that logs every call and never reaches GitHub. Needs bash, git, jq
# and node.
#
#   bash scripts/test-open-pr.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=${OPEN_PR_SCRIPT:-$repo_root/scripts/open-pr.sh}
tmp=$(mktemp -d -t open-pr-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# Hermetic git: no global hooks, templates or identity from the machine.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID DORKOS_HARNESS OPEN_PR_CAP OPEN_PR_BASE OPEN_PR_REMOTE
export CLAUDE_CONFIG_DIR=/nowhere/claude

# --- the stub gh -------------------------------------------------------------
# Logs each call to $GH_LOG. `pr list` prints $FAKE_PRS (the cap reads it);
# `pr create` copies the body it was given and remembers its labels; `pr view`
# answers with them and the head it was told. FAKE_FAIL=create|comment|view
# makes that call fail.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ "${FAKE_FAIL:-}" = "$2" ] && { echo "gh: $2 boom" >&2; exit 1; }
case "$1 $2" in
  "repo view") echo "made-up/repo" ;;
  "pr list") printf '%s' "${FAKE_PRS:-[]}" ;;
  "pr create")
    shift 2
    : >"$GH_STATE.labels"
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) printf '%s\n' "$2" >>"$GH_STATE.labels"; shift 2 ;;
        --body-file) cp "$2" "$GH_STATE.body"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "https://github.com/made-up/repo/pull/42"
    ;;
  "pr comment") ;;
  "pr merge") ;;
  "pr view")
    jq -cn --arg head "$(git rev-parse HEAD)" --rawfile l "$GH_STATE.labels" \
      '{headRefOid: $head, labels: [$l | split("\n")[] | select(. != "") | {name: .}]}'
    ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GH="$tmp/bin/gh"
export GH_LOG="$tmp/gh.log" GH_STATE="$tmp/gh-state"

# --- the throwaway origin -----------------------------------------------------
git init -q --bare -b main "$tmp/origin.git"
git clone -q "$tmp/origin.git" "$tmp/seed" 2>/dev/null
(
  cd "$tmp/seed" || exit 1
  mkdir -p apps/server/src/routes
  echo seed >README.md
  echo 'export {};' >apps/server/src/routes/old.ts
  git add -A && git commit -qm 'chore: seed' && git push -q origin main
) || { echo "could not build the fixture origin" >&2; exit 1; }

printf 'What changed and why.\n' >"$tmp/body.md"
n=0
work=""

# branch <subject> <path>... : a fresh clone on topic branch `topic`, one
# commit touching each path (a path `a=>b` renames a to b), pushed.
branch() {
  local subject=$1 path
  shift
  n=$((n + 1))
  work="$tmp/case-$n"
  git clone -q "$tmp/origin.git" "$work" 2>/dev/null
  (
    cd "$work" || exit 1
    git checkout -qb topic
    for path in "$@"; do
      case "$path" in
        *=\>*)
          mkdir -p "$(dirname "${path#*=>}")"
          git mv "${path%%=>*}" "${path#*=>}"
          ;;
        *)
          mkdir -p "$(dirname "$path")"
          echo "change $n" >>"$path"
          ;;
      esac
    done
    git add -A && git commit -qm "$subject" && git push -qf origin topic 2>/dev/null
  ) || { echo "could not build case $n" >&2; exit 1; }
}

out=""
rc=0
run() { # run the script on the current branch with these args
  : >"$GH_LOG"
  rm -f "$GH_STATE.labels" "$GH_STATE.body"
  out=$(cd "$work" && "$SCRIPT" "$@" 2>&1)
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
labels() { [ -f "$GH_STATE.labels" ] && paste -sd, "$GH_STATE.labels" || echo none; }
created() { grep -q '^pr create' "$GH_LOG" && echo yes || echo no; }

open() { run --title "t: x" --body-file "$tmp/body.md" "$@"; }

# --- review intensity -------------------------------------------------------
branch 'feat(server): x' apps/server/src/services/widgets/a.ts changelog/unreleased/261120-000000-x.md
open
check 'plain server change opens' 0 "$rc"
check 'plain server change is review:light' 'review:light' "$(labels)"

branch 'feat(server): x' apps/server/src/routes/new.ts changelog/unreleased/261120-000001-x.md
open
check 'a security path is review:deep' 'review:deep' "$(labels)"

branch 'feat(server): x' apps/server/src/services/core/auth/a.ts changelog/unreleased/261120-000002-x.md
open
check 'a P0 deep path is review:deep' 'review:deep' "$(labels)"

branch 'feat(server): x' apps/server/src/services/runtimes/shared/awareness/a.ts changelog/unreleased/261120-000003-x.md
open
check 'the interim checker extras are review:deep' 'review:deep' "$(labels)"

branch 'feat(server): x' .NPMRC changelog/unreleased/261120-000004-x.md
open
check 'the gate folds case (.NPMRC)' 'review:deep' "$(labels)"

branch 'refactor(server): move' 'apps/server/src/routes/old.ts=>apps/server/src/lib/old.ts' changelog/unreleased/261120-000005-x.md
open
check 'a rename out of a security path is review:deep' 'review:deep' "$(labels)"

branch 'feat(server): x' apps/server/src/services/widgets/b.ts changelog/unreleased/261120-000006-x.md
open --extra-label review:deep
check '--extra-label review:deep raises light' 'review:deep' "$(labels)"

# --- skip-changelog ----------------------------------------------------------
branch 'docs: guide' contributing/guide.md
open
check 'docs only takes skip-changelog' 'review:light,skip-changelog' "$(labels)"

branch 'ci: tweak' .github/workflows/x.yml
open
check 'CI only takes skip-changelog (and .github is deep)' 'review:deep,skip-changelog' "$(labels)"

branch 'test(server): cover' apps/server/src/services/widgets/__tests__/a.test.ts
open
check 'tests only take skip-changelog' 'review:light,skip-changelog' "$(labels)"

branch 'chore(ci): ledger' ci/ledger/261120-000000-x.md
open
check 'a ledger entry only takes skip-changelog' 'review:light,skip-changelog' "$(labels)"

branch 'docs: guide' contributing/guide.md changelog/unreleased/261120-000007-x.md
open
check 'a fragment means no skip-changelog' 'review:light' "$(labels)"

branch 'fix(ci): tweak' scripts/x.sh
open
check 'skip-changelog with a fix( commit is refused (label race)' 1 "$rc"
check 'the race refusal names the reword' yes "$(has "$out" 'reword the commit to chore(')"
check 'the race refusal opens nothing' no "$(created)"

branch 'feat(server): x' apps/server/src/services/widgets/c.ts changelog/unreleased/261120-000008-x.md
open --extra-label skip-changelog
check '--extra-label skip-changelog with a fragment is refused' 1 "$rc"

branch 'chore(server): internal' apps/server/src/services/widgets/d.ts
open --extra-label skip-changelog
check '--extra-label skip-changelog on chore( commits is kept' 'review:light,skip-changelog' "$(labels)"

# --- needs-design ------------------------------------------------------------
branch 'feat(client): button' apps/client/src/layers/shared/ui/button.tsx changelog/unreleased/261120-000009-x.md
open
check 'a UI path takes needs-design' 'review:light,needs-design' "$(labels)"

branch 'test(client): button' apps/client/src/layers/shared/ui/__tests__/button.test.tsx
open
check 'a UI test does not take needs-design' 'review:light,skip-changelog' "$(labels)"

# --- hold --------------------------------------------------------------------
branch 'feat(server): x' apps/server/src/services/widgets/e.ts changelog/unreleased/261120-000010-x.md
open --hold 'waiting on Security for the token change'
check 'with --hold it opens' 0 "$rc"
check 'with --hold, hold is a label at creation' 'review:light,hold' "$(labels)"
check 'with --hold, the reason is posted as a comment' yes \
  "$(has "$(cat "$GH_LOG")" 'pr comment https://github.com/made-up/repo/pull/42 --body hold: waiting on Security for the token change')"
open
check 'without --hold there is no hold label' 'review:light' "$(labels)"
check 'without --hold there is no comment' no "$(grep -q '^pr comment' "$GH_LOG" && echo yes || echo no)"
open --hold ''
check '--hold with an empty reason is refused' 2 "$rc"
check '--hold with an empty reason opens nothing' no "$(created)"
open --hold '   '
check '--hold with a blank reason is refused' 2 "$rc"
open --hold $'two\nlines'
check '--hold with a two-line reason is refused' 2 "$rc"
open --hold
check '--hold with no value is refused' 2 "$rc"
FAKE_FAIL=comment open --hold 'waiting'
check 'a failed hold comment is exit 3' 3 "$rc"
check 'a failed hold comment says how to post it' yes "$(has "$out" 'gh pr comment https://github.com/made-up/repo/pull/42 --body "hold: waiting"')"

# --- --extra-label gate labels -------------------------------------------------
for label in hold HOLD do-not-merge wip blocked security-reviewed security-deep-reviewed \
  design-ok qa-real-data qa-ok needs-qa-gate 'area:ci,hold' review:light; do
  open --extra-label "$label"
  check "--extra-label '$label' is refused" 1 "$rc"
  check "--extra-label '$label' runs no gh" '' "$(cat "$GH_LOG")"
done
open --extra-label area:ci
check 'an ordinary extra label is added' 'review:light,area:ci' "$(labels)"

# --- the cap ------------------------------------------------------------------
cap30=$(jq -cn '[range(30) | {number: (100 + .), isDraft: false, baseRefName: "main", title: "PR \(.)"}]')
FAKE_PRS=$cap30 open
check 'the cap refusal propagates' 1 "$rc"
check 'the cap refusal is printed' yes "$(has "$out" 'open PRs: 30 of 30')"
check 'at the cap nothing is opened' no "$(created)"
FAKE_PRS=$cap30 open --p0 'main is red'
check '--p0 passes the cap' 0 "$rc"
check '--p0 reaches the cap script' yes "$(has "$out" 'opening anyway as a P0: main is red')"
printf '#!/usr/bin/env bash\necho "cap: cannot count" >&2\nexit 2\n' >"$tmp/bin/cap-broken"
chmod +x "$tmp/bin/cap-broken"
OPEN_PR_CAP="$tmp/bin/cap-broken" open
check 'a cap that cannot decide refuses' 1 "$rc"
check 'a cap that cannot decide opens nothing' no "$(created)"

# --- --dry-run ---------------------------------------------------------------
open --dry-run --hold 'waiting on QA' --draft
check '--dry-run exits 0' 0 "$rc"
check '--dry-run runs no gh at all' '' "$(cat "$GH_LOG")"
check '--dry-run prints the labels' yes "$(has "$out" 'labels: review:light,hold')"
check '--dry-run prints the create command' yes "$(has "$out" 'pr create --base main --head topic')"
check '--dry-run prints the draft flag' yes "$(has "$out" '--draft')"
check '--dry-run prints the hold comment' yes "$(has "$out" 'pr comment')"

# --- provenance and output ----------------------------------------------------
CLAUDECODE=1 CLAUDE_CONFIG_DIR=/x/.claude2 CLAUDE_SESSION_ID=abcdef1234567890 open --draft
check 'the provenance line is appended' yes \
  "$(has "$(cat "$GH_STATE.body")" '<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"abcdef12","account":"claude2","surface":"github"} -->')"
check 'the original body is kept' yes "$(has "$(cat "$GH_STATE.body")" 'What changed and why.')"
check '--draft reaches gh' yes "$(has "$(cat "$GH_LOG")" '--draft')"
check 'the URL is printed' yes "$(has "$out" 'url: https://github.com/made-up/repo/pull/42')"
check 'the head SHA is printed' yes "$(has "$out" "head: $(git -C "$work" rev-parse HEAD)")"
check 'the labels are printed' yes "$(has "$out" 'labels: review:light')"
CLAUDECODE=1 CLAUDE_CONFIG_DIR=/x/.claude3 CLAUDE_CODE_SESSION_ID=0123456789abcdef open
check 'CLAUDE_CODE_SESSION_ID (what Claude Code sets) gives the sessionId' yes \
  "$(has "$(cat "$GH_STATE.body")" '<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"01234567","account":"claude3","surface":"github"} -->')"
CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=0123456789abcdef CLAUDE_SESSION_ID=abcdef1234567890 open
check 'CLAUDE_CODE_SESSION_ID wins over CLAUDE_SESSION_ID' yes "$(has "$(cat "$GH_STATE.body")" '"sessionId":"01234567"')"
CLAUDECODE=1 open
check 'no session id, no sessionId key' yes \
  "$(has "$(cat "$GH_STATE.body")" '<!-- agent:provenance {"v":1,"harness":"claude-code","account":"claude","surface":"github"} -->')"
CLAUDECODE=1 CLAUDE_CONFIG_DIR=/x/me@example.com open
check 'an account with @ is left out' no "$(has "$(cat "$GH_STATE.body")" 'example.com')"
open
check 'outside a known harness, only known fields' yes \
  "$(has "$(cat "$GH_STATE.body")" '<!-- agent:provenance {"v":1,"surface":"github"} -->')"
printf 'Body.\n\n<!-- agent:provenance {"v":1,"surface":"github"} -->\n' >"$tmp/signed.md"
run --title 't: x' --body-file "$tmp/signed.md"
check 'an existing provenance line is not doubled' 1 "$(grep -c 'agent:provenance' "$GH_STATE.body")"

# --- refusals before gh -------------------------------------------------------
(cd "$work" && echo more >>apps/server/src/services/widgets/e.ts && git commit -qam 'feat(server): unpushed')
open
check 'an unpushed head is refused' 1 "$rc"
check 'an unpushed head opens nothing' no "$(created)"
FAKE_FAIL=create open --dry-run
check 'a dry run does not need the head pushed' 0 "$rc"
run --body-file "$tmp/body.md"
check 'no --title is a usage error' 2 "$rc"
run --title 't: x' --body-file "$tmp/missing.md"
check 'a missing body file is a usage error' 2 "$rc"
run --title 't: x' --body-file "$tmp/body.md" --nope
check 'an unknown flag is a usage error' 2 "$rc"
(cd "$work" && git push -qf origin topic 2>/dev/null)
FAKE_FAIL=create open
check 'a failed gh pr create is exit 3' 3 "$rc"

# --- auto-merge (DOR-5107) ----------------------------------------------------
# Every case above ran against an origin with no ci/required-checks.json, so
# none turned auto-merge on. It switches on only once main requires the three
# gates that make it safe, and never for a draft or a hold.
merged() { grep -q '^pr merge https://github.com/made-up/repo/pull/42 --auto$' "$GH_LOG" && echo yes || echo no; }
set_required() { # the contexts main's ci/required-checks.json lists
  (
    cd "$tmp/seed" || exit 1
    git pull -q origin main 2>/dev/null
    mkdir -p ci
    jq -n '{ruleset: 1, contexts: $ARGS.positional}' --args "$@" >ci/required-checks.json
    git add -A && git commit -qm 'ci: required checks' && git push -q origin main
  ) || { echo "could not update the fixture origin" >&2; exit 1; }
}

branch 'feat(server): x' apps/server/src/services/widgets/a.ts changelog/unreleased/261123-000000-x.md
open
check 'no required-checks file on main: auto-merge stays off' no "$(merged)"
check 'and it says why' yes "$(has "$out" 'auto-merge: off: origin/main has no ci/required-checks.json')"

set_required typecheck test not-held release-window
branch 'feat(server): x' apps/server/src/services/widgets/a.ts changelog/unreleased/261123-000001-x.md
open
check 'main missing pr-gates: auto-merge stays off' no "$(merged)"
check 'and it names the missing gate' yes "$(has "$out" 'does not require pr-gates yet')"

set_required typecheck test not-held release-window pr-gates
branch 'feat(server): x' apps/server/src/services/widgets/a.ts changelog/unreleased/261123-000002-x.md
open
check 'main requires all three gates: opens' 0 "$rc"
check 'auto-merge is turned on, with no strategy flag' yes "$(merged)"
check 'and it says so' yes "$(has "$out" 'auto-merge: on')"

open --draft
check 'a draft never gets auto-merge' no "$(merged)"
check 'and it says how to turn it on later' yes "$(has "$out" 'auto-merge: off: a draft')"

open --hold 'waiting on the migration plan'
check 'a held PR never gets auto-merge' no "$(merged)"

open --dry-run
check 'a dry run only says it would turn it on' no "$(merged)"
check 'and prints the command' yes "$(has "$out" 'would run: ')"
check 'naming pr merge --auto' yes "$(has "$out" 'pr merge \<new\ PR\> --auto')"

# The branch's own copy of the file is never what decides.
branch 'ci: x' ci/required-checks.json
(cd "$work" && jq -n '{ruleset: 1, contexts: ["typecheck"]}' >ci/required-checks.json &&
  git commit -qam 'ci: drop the gates' && git push -qf origin topic 2>/dev/null)
open
check 'a branch that drops the gates from its own copy still gets main'\''s answer' yes "$(merged)"

FAKE_FAIL=merge open
check 'a failed auto-merge is exit 3' 3 "$rc"
check 'and it says who turns it on' yes "$(has "$out" 'Ask a maintainer to turn it on')"

echo "open-pr fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
