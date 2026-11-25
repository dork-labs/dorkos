#!/usr/bin/env bash
# Fixture suite for scripts/open-pr.sh, the one supported way to open a PR.
#
# Every rule the script carries is pinned here, because the rules it replaces
# lived in prose and drifted (2026-11-20: a brief said "open with hold", the arm
# script refused hold and never lifted it, and 19 PRs sat for 9 hours). Each
# case builds a real branch in a throwaway git repo with a local bare origin,
# and runs the script against a stubbed `gh` (GH=..., and on PATH for the cap
# script) that logs every call and never reaches GitHub. Needs bash, git, jq
# and node. The provenance cases that run the real CLI also need the repo's
# node_modules (tsx); without them they are skipped and say so, and the
# fallback cases, which stub tsx, still run.
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
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CODEX_THREAD_ID DORKOS_HARNESS DORKOS_SESSION_ID DORKOS_AGENT_ID DORKOS_SPACE_ID
unset DORKOS_AGENT_TOKEN DORKOS_API_URL DORKOS_API_KEY OPEN_PR_CURL
# No real dorkos CLI: the work-graph cases below pass their own.
export OPEN_PR_DORKOS=
unset OPEN_PR_CAP OPEN_PR_BASE OPEN_PR_REMOTE OPEN_PR_TSX CI
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

# --- stub tsx for the provenance CLI ---------------------------------------------
# open-pr.sh runs `$OPEN_PR_TSX scripts/provenance/provenance-line.ts ...`. Every
# case runs a stub that logs its arguments to $tmp/tsx.log and prints the minimal
# line, so the suite is fast and needs no node_modules; the provenance section
# swaps in failing stubs and, when installed, the real tsx.
MINIMAL='<!-- agent:provenance {"v":2} -->'
stub_tsx() { # name, the stub's body
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"%s"\n%s\n' "$tmp/tsx.log" "$2" >"$tmp/bin/$1"
  chmod +x "$tmp/bin/$1"
}
stub_tsx tsx-minimal "echo '$MINIMAL'"
export OPEN_PR_TSX="$tmp/bin/tsx-minimal"
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
# The line is version 2, built by scripts/provenance/provenance-line.ts. These
# first cases stub tsx (OPEN_PR_TSX), so they run with or without node_modules:
# the arguments open-pr.sh passes, and that a CLI that cannot sign never stops
# the open.
body() { cat "$GH_STATE.body" 2>/dev/null; }
stub_tsx tsx-ok "echo '<!-- agent:provenance {\"v\":2,\"surface\":\"dorkos\",\"chat\":\"dork:chat:abcdef12\"} -->'"
stub_tsx tsx-crash 'printf "node:internal/modules/run_main:123\n    triggerUncaughtException(\nError: boom\n    at main (provenance-line.ts:1:1)\n" >&2; exit 1'
stub_tsx tsx-crash-plain 'printf "first words\nlast words\n\n" >&2; exit 3'
stub_tsx tsx-no-node 'echo "env: node: No such file or directory" >&2; exit 127'
stub_tsx tsx-garbage 'echo hello'
stub_tsx tsx-two-lines "echo '$MINIMAL'; echo '$MINIMAL'"

: >"$tmp/tsx.log"
OPEN_PR_TSX="$tmp/bin/tsx-ok" open --draft
check 'open-pr runs the CLI as public, and lets it derive the surface' \
  "$repo_root/scripts/provenance/provenance-line.ts --visibility public" "$(cat "$tmp/tsx.log")"
check 'the CLI line is appended as printed' yes \
  "$(has "$(body)" '<!-- agent:provenance {"v":2,"surface":"dorkos","chat":"dork:chat:abcdef12"} -->')"
check 'the original body is kept' yes "$(has "$(body)" 'What changed and why.')"
check 'a real open prints the line and names the omitted fields' yes \
  "$(has "$out" 'provenance: appended: <!-- agent:provenance {"v":2,"surface":"dorkos","chat":"dork:chat:abcdef12"} --> (omitted: harness, account, agent, space)')"
check '--draft reaches gh' yes "$(has "$(cat "$GH_LOG")" '--draft')"
check 'the URL is printed' yes "$(has "$out" 'url: https://github.com/made-up/repo/pull/42')"
check 'the head SHA is printed' yes "$(has "$out" "head: $(git -C "$work" rev-parse HEAD)")"
check 'the labels are printed' yes "$(has "$out" 'labels: review:light')"

OPEN_PR_TSX="$tmp/bin/no-such-tsx" open
check 'tsx missing: the PR still opens' 0 "$rc"
check 'tsx missing: the minimal line is appended' yes "$(has "$(body)" "$MINIMAL")"
check 'tsx missing: it says why, naming where it looked' yes \
  "$(has "$out" "provenance CLI could not sign (tsx is not installed (looked in $tmp/bin/no-such-tsx); run pnpm install)")"
check 'tsx missing: it warns' yes "$(has "$out" 'open-pr: warning: appended the minimal line')"
OPEN_PR_TSX="$tmp/bin/tsx-crash" open
check 'the CLI crashing: the PR still opens' 0 "$rc"
check 'the CLI crashing: the minimal line is appended' yes "$(has "$(body)" "$MINIMAL")"
check 'the CLI crashing: it names the exit and the Error line, not the stack' yes "$(has "$out" '(it exited 1: Error: boom)')"
OPEN_PR_TSX="$tmp/bin/tsx-crash-plain" open
check 'a crash with no Error line: it names the last line' yes "$(has "$out" '(it exited 3: last words)')"
OPEN_PR_TSX="$tmp/bin/tsx-no-node" open
check 'node missing: the PR still opens' 0 "$rc"
check 'node missing: it says so' yes "$(has "$out" '(it exited 127: env: node: No such file or directory)')"
OPEN_PR_TSX="$tmp/bin/tsx-garbage" open
check 'CLI garbage: the PR still opens' 0 "$rc"
check 'CLI garbage: only the minimal line goes in' "no,yes" \
  "$(has "$(body)" 'hello'),$(has "$(body)" "$MINIMAL")"
check 'CLI garbage: it says so' yes "$(has "$out" '(it printed no signature line)')"
OPEN_PR_TSX="$tmp/bin/tsx-two-lines" open
check 'two lines from the CLI are not a signature' 1 "$(grep -c 'agent:provenance' "$GH_STATE.body")"
check 'and it says so' yes "$(has "$out" '(it printed no signature line)')"
OPEN_PR_TSX="$tmp/bin/tsx-crash" open --dry-run
check 'a dry run says the CLI could not sign' yes "$(has "$out" 'provenance: appended the minimal line, because the provenance CLI could not sign')"

for signed in 'v1|<!-- agent:provenance {"v":1,"surface":"github"} -->' \
  'v2|<!-- agent:provenance {"v":2,"surface":"dorkos","chat":"dork:chat:abcdef12"} -->' \
  'flow:provenance|<!-- flow:provenance {"v":1,"harness":"codex"} -->'; do
  name=${signed%%|*}
  printf 'Body.\n\n%s\n' "${signed#*|}" >"$tmp/signed.md"
  : >"$tmp/tsx.log"
  OPEN_PR_TSX="$tmp/bin/tsx-ok" run --title 't: x' --body-file "$tmp/signed.md"
  check "a body signed $name is left alone" "$(cat "$tmp/signed.md")" "$(body)"
  check "a body signed $name never runs the CLI" '' "$(cat "$tmp/tsx.log")"
  check "a body signed $name says so" yes "$(has "$out" 'provenance: already in the body')"
done

# Only the LAST non-blank line signs a body, as every reader decides.
printf 'Body.\n\n  <!--  agent:provenance   {"v":2,"surface":"dorkos"}  -->  \r\n\n   \n' >"$tmp/signed.md"
OPEN_PR_TSX="$tmp/bin/tsx-ok" run --title 't: x' --body-file "$tmp/signed.md"
check 'an extra-spaced trailing signature (CRLF, blank lines after) is left alone' \
  "yes,1" "$(has "$out" 'provenance: already in the body'),$(grep -c 'provenance' "$GH_STATE.body")"
quoted='<!-- agent:provenance {"v":2,"surface":"dorkos"} -->'
# shellcheck disable=SC2016 # literal Markdown backticks, not a command
printf 'The line looks like `%s` inline.\n\nThat is all.\n' "$quoted" >"$tmp/quoted.md"
# shellcheck disable=SC2016 # literal Markdown fence
printf 'Example:\n\n```\n%s\n```\n\nThat is all.\n' "$quoted" >"$tmp/fenced.md"
printf 'Old line:\n%s\nThen more text.\n' "$quoted" >"$tmp/midbody.md"
for case in 'quoted inline|quoted.md' 'quoted in a fence|fenced.md' 'mid-body with text after|midbody.md'; do
  OPEN_PR_TSX="$tmp/bin/tsx-ok" run --title 't: x' --body-file "$tmp/${case#*|}"
  check "a signature ${case%%|*} does not sign the body: one is appended" \
    "yes,yes" "$(has "$out" 'provenance: appended: '),$(grep -q 'dork:chat:abcdef12' <<<"$(tail -1 "$GH_STATE.body")" && echo yes || echo no)"
done

# A worktree with no install of its own borrows the main checkout's tsx, and
# still runs its OWN copy of the CLI.
fake=$tmp/fake-main
mkdir -p "$fake/scripts/provenance"
cp "$SCRIPT" "$fake/scripts/open-pr.sh"
ln -s "$repo_root/.github" "$fake/.github"
: >"$fake/scripts/provenance/provenance-line.ts"
echo node_modules/ >"$fake/.gitignore"
(cd "$fake" && git init -q -b main && git add -A && git commit -qm 'chore: fake repo' &&
  git worktree add -q "$tmp/fake-wt" -b wt) || { echo "could not build the fake repo" >&2; exit 1; }
mkdir -p "$fake/node_modules/.bin"
stub_tsx tsx-ok-main "echo '<!-- agent:provenance {\"v\":2,\"surface\":\"bare-cli\"} -->'"
cp "$tmp/bin/tsx-ok-main" "$fake/node_modules/.bin/tsx"
fake_open() { # open-pr.sh from the fake worktree, no OPEN_PR_TSX
  : >"$tmp/tsx.log"
  out=$(cd "$work" && env -u OPEN_PR_TSX "$tmp/fake-wt/scripts/open-pr.sh" --title 't: x' --body-file "$tmp/body.md" --dry-run 2>&1)
  rc=$?
}
fake_open
check "no tsx in the worktree: the main checkout's runs" 0 "$rc"
check "and it runs the worktree's own CLI" "$(cd "$tmp/fake-wt" && pwd)/scripts/provenance/provenance-line.ts --visibility public" "$(cat "$tmp/tsx.log")"
check 'and its line is appended' yes "$(has "$out" 'provenance: appended: <!-- agent:provenance {"v":2,"surface":"bare-cli"} -->')"
mkdir -p "$tmp/fake-wt/node_modules/.bin"
stub_tsx tsx-ok-wt "echo '<!-- agent:provenance {\"v\":2,\"surface\":\"ci\"} -->'"
cp "$tmp/bin/tsx-ok-wt" "$tmp/fake-wt/node_modules/.bin/tsx"
fake_open
check "the worktree's own tsx comes first" yes "$(has "$out" '{"v":2,"surface":"ci"}')"
rm -f "$tmp/fake-wt/node_modules/.bin/tsx" "$fake/node_modules/.bin/tsx"
fake_open
check 'neither checkout has tsx: the minimal line, naming both places' "0,yes,yes" \
  "$rc,$(has "$out" "$MINIMAL"),$(has "$out" "fake-wt/node_modules/.bin/tsx, ")"

# The real CLI, from the environment each harness sets. Fake ids only.
CHAT=7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6
AGENT=01KJXYKJYW4N8QGQ5W4GB6YM9J
SPACE=01JD3F1W2KQ8Z0YV9N6B5T4RMA
real_tsx=$repo_root/node_modules/.bin/tsx
real() { OPEN_PR_TSX=$real_tsx open; }
if [ -x "$real_tsx" ]; then
  full="<!-- agent:provenance {\"v\":2,\"harness\":\"claude-code\",\"surface\":\"dorkos\",\"account\":\"claude3\",\"agent\":\"dork:agent:$AGENT\",\"chat\":\"dork:chat:7c1e4b2a\",\"space\":\"dork:space:$SPACE\"} -->"
  # A DorkOS turn: DorkOS sets the session, agent and space.
  CLAUDECODE=1 CLAUDE_CONFIG_DIR=/x/.claude3 DORKOS_SESSION_ID=$CHAT DORKOS_AGENT_ID=$AGENT DORKOS_SPACE_ID=$SPACE real
  check 'every field present: the whole v2 line' yes "$(has "$(body)" "$full")"
  check 'every field present: nothing named as omitted' "yes,no" \
    "$(has "$out" "provenance: appended: $full"),$(has "$out" '(omitted:')"

  CLAUDECODE=1 CLAUDE_CONFIG_DIR=/x/.claude2 CLAUDE_CODE_SESSION_ID=$CHAT real
  check 'a bare Claude Code session: bare-cli, no agent or space' yes \
    "$(has "$(body)" '<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"bare-cli","account":"claude2","chat":"dork:chat:7c1e4b2a"} -->')"
  check 'and the note names them' yes "$(has "$out" '(omitted: agent, space)')"

  CODEX_THREAD_ID=$CHAT HOSTNAME=made-up-host real
  public_codex='<!-- agent:provenance {"v":2,"harness":"codex","surface":"bare-cli","chat":"dork:chat:7c1e4b2a"} -->'
  check 'bare Codex signs the PR with its public prefix and omits the full thread from the body and output' "yes,no,no" \
    "$(has "$(body)" "$public_codex"),$(has "$(body)" "$CHAT"),$(has "$out" "$CHAT")"
  for key in host turn resumeUrl instanceId sessionId made-up-host; do
    check "public: no $key" no "$(has "$(body)" "$key")"
  done

  CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=0123456789abcdef CLAUDE_SESSION_ID=abcdef1234567890 real
  check 'CLAUDE_CODE_SESSION_ID wins over CLAUDE_SESSION_ID' yes "$(has "$(body)" '"chat":"dork:chat:01234567"')"
  CLAUDECODE=1 CLAUDE_CONFIG_DIR=/x/me@example.com real
  check 'an account with @ is left out' "no,yes" \
    "$(has "$(body)" 'example.com'),$(has "$out" '(omitted: account, agent, chat, space)')"
  CI=true real
  check 'in CI the surface is ci' yes "$(has "$(body)" '<!-- agent:provenance {"v":2,"surface":"ci"} -->')"
  real
  check 'outside a known harness, only the surface' yes "$(has "$(body)" '<!-- agent:provenance {"v":2,"surface":"bare-cli"} -->')"
  check 'and every other field is named' yes "$(has "$out" '(omitted: harness, account, agent, chat, space)')"
else
  echo "open-pr fixtures: skipped the real provenance CLI cases (no $real_tsx; run pnpm install)" >&2
fi

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

# --- the work graph (DOR-5264) --------------------------------------------------
# Step 6 tells the chat's DorkOS server what the PR is and which tickets its body
# names for sure. It never changes the open's result. The CLI path runs a stub
# `dorkos`; the curl path talks to a real loopback HTTP server started here.
branch 'chore: x' docs/x.md
cat >"$tmp/wg-body.md" <<'BODY'
What changed.

Closes DOR-5264
See https://linear.app/dork-labs/issue/DOR-4970/the-graph-api and part of DOR-4966.
COVID-19, HTTP-2 and SHA-256 are words, not tickets, and so is ABC-7 here.
Refs ABC-12
- Fixes HTTP-2 upgrades
fix(x): UTF-8 decoding
Resolves SHA-256 mismatch and ISO-8601 dates
Closes DOR-1, DOR-2
```
DOR-9999 sits in a fence.
```
<!-- DOR-8888 sits in a comment -->
BODY
wg() { run --title "chore: x" --body-file "$tmp/wg-body.md" "$@"; }
WG_TICKETS='["DOR-5264","DOR-4970","DOR-4966","DOR-1","DOR-2"]'

wg
check 'with no chat token the PR still opens' "0,yes" "$rc,$(created)"
check 'and it says the link was not recorded' yes \
  "$(has "$out" 'work-graph: not recorded (this shell has no DorkOS chat token)')"

cat >"$tmp/bin/dorkos-stub" <<'EOF2'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$WG_DIR/argv"
printf '%s' "${DORKOS_AGENT_TOKEN:-}" >"$WG_DIR/token"
cat >"$WG_DIR/stdin"
if [ -n "${WG_REFUSE:-}" ]; then echo "Error: $WG_REFUSE" >&2; exit 1; fi
jq -c '{ok: true, chat: "c", pr: "made-up/repo#42", tickets: .tickets, refused: [{ref: "X", reason: "unrecognised"}]}' "$WG_DIR/stdin"
EOF2
chmod +x "$tmp/bin/dorkos-stub"
export WG_DIR="$tmp/wg"
mkdir -p "$WG_DIR"

DORKOS_AGENT_TOKEN=tok-5264 OPEN_PR_DORKOS="$tmp/bin/dorkos-stub" wg
check 'from a chat, it calls dorkos call with the input on stdin' \
  'call work-graph.record-pr --input-file -' "$(cat "$WG_DIR/argv")"
check 'the token rides the environment, never the arguments' "tok-5264,no" \
  "$(cat "$WG_DIR/token"),$(has "$(cat "$WG_DIR/argv")" tok-5264)"
check 'it sends the PR and only the sure tickets: Linear links and DOR keys, on a Fixes line or not' \
  "https://github.com/made-up/repo/pull/42 $WG_TICKETS" \
  "$(jq -r '"\(.pr) \(.tickets | tojson)"' "$WG_DIR/stdin")"
check 'and prints what was recorded, refused tickets by name' yes \
  "$(has "$out" 'work-graph: recorded: this chat opened made-up/repo#42; works on DOR-5264, DOR-4970, DOR-4966, DOR-1, DOR-2; refused X (unrecognised)')"
check 'the open itself is unchanged' "0,yes" "$rc,$(has "$out" 'auto-merge:')"

WG_REFUSE='Only a chat’s own turn can record this.' DORKOS_AGENT_TOKEN=tok-5264 \
  OPEN_PR_DORKOS="$tmp/bin/dorkos-stub" wg
check 'a refusal from the server leaves the open at exit 0' "0,yes" "$rc,$(created)"
check 'and says why nothing was recorded' yes \
  "$(has "$out" 'work-graph: not recorded (Only a chat’s own turn can record this.)')"

rm -f "$WG_DIR/argv"
DORKOS_AGENT_TOKEN=tok-5264 OPEN_PR_DORKOS="$tmp/bin/dorkos-stub" wg --dry-run
check 'a dry run says what it would send, and how' yes \
  "$(has "$out" 'work-graph: would record opened <new PR> and works_on: DOR-5264, DOR-4970, DOR-4966, DOR-1, DOR-2, through dorkos call')"
check 'and sends nothing' no "$([ -f "$WG_DIR/argv" ] && echo yes || echo no)"

# A Fixes, Resolves or Refs line vouches for nothing but a DOR key or a Linear link.
for line in '- Fixes HTTP-2 upgrades' 'fix(x): UTF-8 decoding' 'Resolves SHA-256 mismatch' \
  'fix(api): ISO-8601 dates' 'Refs ABC-12' 'COVID-19 and HTTP-2'; do
  printf '%s\n' "$line" >"$tmp/wg-one.md"
  DORKOS_AGENT_TOKEN=tok-5264 OPEN_PR_DORKOS="$tmp/bin/dorkos-stub" \
    run --title "chore: x" --body-file "$tmp/wg-one.md" --dry-run
  check "\"$line\" names no ticket" yes "$(has "$out" 'works_on: no tickets,')"
done
printf 'Closes DOR-1, DOR-2\n' >"$tmp/wg-one.md"
DORKOS_AGENT_TOKEN=tok-5264 OPEN_PR_DORKOS="$tmp/bin/dorkos-stub" \
  run --title "chore: x" --body-file "$tmp/wg-one.md" --dry-run
check '"Closes DOR-1, DOR-2" names both' yes "$(has "$out" 'works_on: DOR-1, DOR-2,')"

# The curl path: no CLI, a loopback server named by DORKOS_API_URL.
cat >"$tmp/wg-server.cjs" <<'EOF2'
const http = require('node:http');
const fs = require('node:fs');
const [seen, portFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = JSON.parse(raw);
    fs.writeFileSync(seen, JSON.stringify({ path: req.url, method: req.method, agent: req.headers['x-dorkos-agent'], body }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chat: 'c', pr: 'made-up/repo#42', tickets: body.tickets, refused: [] }));
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
EOF2
node "$tmp/wg-server.cjs" "$WG_DIR/seen.json" "$WG_DIR/port" &
wg_server=$!
for _ in $(seq 50); do [ -s "$WG_DIR/port" ] && break; sleep 0.1; done
cat >"$tmp/bin/curl-logger" <<'EOF2'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$WG_DIR/curl-argv"
exec curl "$@"
EOF2
chmod +x "$tmp/bin/curl-logger"

DORKOS_AGENT_TOKEN=tok-5264 DORKOS_API_URL="http://127.0.0.1:$(cat "$WG_DIR/port")" \
  OPEN_PR_CURL="$tmp/bin/curl-logger" wg
check 'with no CLI it posts to the invoke route of the turn’s server' \
  'POST /api/capabilities/work-graph.record-pr/invoke' "$(jq -r '"\(.method) \(.path)"' "$WG_DIR/seen.json")"
check 'the token arrives as the agent header' tok-5264 "$(jq -r .agent "$WG_DIR/seen.json")"
check 'with the same sure tickets' "$WG_TICKETS" "$(jq -c .body.tickets "$WG_DIR/seen.json")"
check 'and never on curl’s command line' no "$(has "$(cat "$WG_DIR/curl-argv")" tok-5264)"
check 'it prints what was recorded' yes \
  "$(has "$out" 'work-graph: recorded: this chat opened made-up/repo#42; works on DOR-5264')"
kill "$wg_server" 2>/dev/null
wait "$wg_server" 2>/dev/null

# Nobody listens on that port any more.
DORKOS_AGENT_TOKEN=tok-5264 DORKOS_API_URL="http://127.0.0.1:$(cat "$WG_DIR/port")" wg
check 'with no server reachable the PR still opens, at exit 0' "0,yes" "$rc,$(created)"
check 'and it says the link was not recorded' yes \
  "$(has "$out" "work-graph: not recorded (no DorkOS server answered at http://127.0.0.1:$(cat "$WG_DIR/port")")"

: >"$WG_DIR/curl-argv"
DORKOS_AGENT_TOKEN=tok-5264 DORKOS_API_URL='http://192.168.1.20:4242' OPEN_PR_CURL="$tmp/bin/curl-logger" wg
check 'it never dials a DORKOS_API_URL that is not loopback' "yes," \
  "$(has "$out" 'work-graph: not recorded (DORKOS_API_URL is not a loopback origin)'),$(cat "$WG_DIR/curl-argv")"

echo "open-pr fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
