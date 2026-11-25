#!/usr/bin/env bash
# Fixture suite for .claude/hooks/pr-create-guard.mjs, the PreToolUse(Bash)
# guard that refuses opening a PR any way but scripts/open-pr.sh: a bare
# `gh pr create` (or `gh pr new`), a REST POST to `.../pulls`, and the
# `createPullRequest` GraphQL mutation.
#
# Every case runs through the hook's real entry point (a PreToolUse payload on
# stdin) and is asserted on the real contract (exit 2 to block, exit 0 to
# allow). The allow half matters as much as the block half: every other
# `gh pr` subcommand (view, edit, list, checks, comment, merge) is how agents
# watch and land PRs, and a guard that blocks them gets switched off.
#
#   bash scripts/test-pr-create-guard.sh
#   GUARD=/path/to/other.mjs bash scripts/test-pr-create-guard.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
guard=${GUARD:-$repo_root/.claude/hooks/pr-create-guard.mjs}

payload_dir=$(mktemp -d -t pr-create-guard-payload.XXXXXX)
export PR_CREATE_GUARD_FIXTURE_PAYLOAD=$payload_dir/payload.json
trap 'rm -rf "$payload_dir"' EXIT

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

# Run one command through the hook exactly as Claude Code would.
verdict() {
  local command=$1 stderr status
  PR_CREATE_GUARD_FIXTURE_COMMAND="$command" node -e '
      require("fs").writeFileSync(
        process.env.PR_CREATE_GUARD_FIXTURE_PAYLOAD,
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: process.env.PR_CREATE_GUARD_FIXTURE_COMMAND },
        })
      );
    '
  stderr=$(node "$guard" <"$PR_CREATE_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
  status=$?
  if [ "$status" -eq 0 ]; then
    echo allow
    return
  fi
  if [ "$status" -ne 2 ]; then
    echo "exit-$status"
    return
  fi
  case "$stderr" in
    "Blocked: open pull requests with scripts/open-pr.sh"*) echo block ;;
    *) echo "block-unknown" ;;
  esac
}

case_check() {
  check "$1" "$2" "$(verdict "$3")"
}

# Each line is `<expected-verdict> <command>`.
while read -r expected command; do
  [ -n "${expected:-}" ] || continue
  case "$expected" in \#*) continue ;; esac
  case_check "$command" "$expected" "$command"
done <<'CASES'
# --- gh pr create, every spelling. ---
block gh pr create --title "feat: x" --body "y"
block gh pr create --draft --label review:light --title x --body y
block gh pr create --fill
block gh pr create
block gh pr new --title x --body y
block gh pr -R dork-labs/dorkos create --title x --body y
block gh -R dork-labs/dorkos pr create --title x
block gh --repo=x/y pr create --title x
block /opt/homebrew/bin/gh pr create --title x
block GH_TOKEN=x gh pr create --title x
block cd /tmp && gh pr create --title x
block git push -u origin topic && gh pr create --title x --body y
block sh -c "gh pr create --title x"
block bash -c 'gh pr create --title x'
block eval 'gh pr create --title x'
block echo "$(gh pr create --title x --body y)"
block url=$(gh pr create --title x --body y) && echo "$url"
block timeout 60 gh pr create --title x
block env GH_TOKEN=x gh pr create --title x
block echo 'gh pr create --title x' | bash
# --- the REST create endpoint. ---
block gh api repos/dork-labs/dorkos/pulls -X POST -f title=x -f head=b -f base=main
block gh api -X POST repos/{owner}/{repo}/pulls -f title=x
block gh api --method POST repos/o/r/pulls --input body.json
block gh api --method=post /repos/o/r/pulls -f title=x
block gh api -XPOST repos/o/r/pulls -f title=x
block gh api repos/o/r/pulls -f title=x -f head=b -f base=main
block gh api repos/o/r/pulls -F title=x
block gh api repos/o/r/pulls --raw-field=title=x
block gh api repos/o/r/pulls --input body.json
block gh api repos/o/r/pulls -ftitle=x
block gh api repos/o/r/pulls/ -f title=x
# --- the GraphQL create mutation. ---
block gh api graphql -f query='mutation { createPullRequest(input: {repositoryId: "R", baseRefName: "main", headRefName: "b", title: "x"}) { pullRequest { url } } }'
# --- the supported road, and everything else gh pr does. ---
allow scripts/open-pr.sh --title "feat: x" --body-file body.md
allow bash scripts/open-pr.sh --title "feat: x" --body-file body.md --dry-run
allow ./scripts/open-pr.sh --title x --body-file b.md --hold "waiting on Security"
allow gh pr view 12
allow gh pr view 12 --json labels,headRefOid
allow gh pr edit 12 --add-label re-review
allow gh pr edit 12 --title "feat: create the thing"
allow gh pr list --state open --search "gh pr create"
allow gh pr checks 12
allow gh pr comment 12 --body "hold: waiting on Security"
allow gh pr merge --auto 12
allow gh pr ready 12
allow gh pr diff 12 --name-only
allow gh pr status
allow gh stack submit
# --- reads of the pulls endpoint, and POSTs under one PR. ---
allow gh api repos/o/r/pulls
allow gh api repos/o/r/pulls?state=open
allow gh api -X GET repos/o/r/pulls -f state=open
allow gh api repos/o/r/pulls/12
allow gh api repos/o/r/pulls/12/comments -f body=x
allow gh api -X POST repos/o/r/pulls/12/reviews -f event=COMMENT
allow gh api repos/o/r/pulls/12/files --paginate
allow gh api graphql -f query='query { repository(owner: "o", name: "r") { pullRequests(first: 5) { nodes { number } } } }'
# --- text that names the command. ---
allow git commit -m "docs: say to use open-pr.sh, never gh pr create"
allow echo "gh pr create is refused here"
allow grep -rn "gh pr create" .agents/skills
allow echo 'gh pr create --title x' | tee notes.md
CASES

# A heredoc body that is data stays allowed; one fed to a shell is blocked.
case_check 'a quoted heredoc written to a file' allow \
  $'cat > notes.md <<\'EOF\'\nDo not run:\ngh pr create --title x\nEOF'
case_check 'a commit message heredoc' allow \
  $'git commit -F - <<\'EOF\'\nci: stop using\ngh pr create --title x\nEOF'
case_check 'a heredoc fed to bash' block \
  $'bash <<\'EOF\'\ngh pr create --title x\nEOF'

# --- `bash <script file>` runs a file, so a quoted heredoc beside it stays data (Nov 25, as #4436). ---
case_check 'a PR-body heredoc naming gh pr create, beside bash <script>' allow \
  $'cat > /tmp/b.md <<\'EOF\'\ngh pr create --fill is refused; use open-pr.sh\nEOF\nbash scripts/open-pr.sh --title x --body-file /tmp/b.md'
case_check 'a heredoc beside bash -o pipefail <script>' allow \
  $'cat > /tmp/b.md <<\'EOF\'\ngh pr create --title x\nEOF\nbash -o pipefail scripts/open-pr.sh --title x --body-file /tmp/b.md'
case_check 'bash <script> does not hide gh pr create beside it' block \
  'bash scripts/x.sh && gh pr create --title x'
case_check 'bash <script> does not hide gh pr create on the next line' block \
  $'bash scripts/x.sh\ngh pr create --title x'
# ...while every form that feeds the text to a shell still reads it as commands.
case_check 'bash << EOF with a space' block \
  $'bash << \'EOF\'\ngh pr create --title x\nEOF'
case_check 'a heredoc piped into bash' block \
  $'cat <<\'EOF\' | bash\ngh pr create --title x\nEOF'
case_check 'a heredoc piped into bash -o pipefail' block \
  $'cat <<\'EOF\' | bash -o pipefail\ngh pr create --title x\nEOF'
case_check 'a heredoc piped into bash --init-file f' block \
  $'cat <<\'EOF\' | bash --init-file /tmp/rc\ngh pr create --title x\nEOF'
case_check 'bash -s <<EOF' block \
  $'bash -s <<\'EOF\'\ngh pr create --title x\nEOF'
case_check 'a heredoc to a remote shell' block \
  $'ssh build-box <<\'EOF\'\ngh pr create --title x\nEOF'
case_check 'bash /dev/stdin <<EOF' block \
  $'bash /dev/stdin <<\'EOF\'\ngh pr create --title x\nEOF'
case_check 'a script written by a heredoc and run on the same line' block \
  $'cat > /tmp/p.sh <<\'EOF\'\ngh pr create --title x\nEOF\nbash /tmp/p.sh'
case_check 'a script written by echo and run on the same line' block \
  "echo 'gh pr create --title x' >/tmp/p.sh; sh /tmp/p.sh"
case_check 'sh -lc runs its argument' block "sh -lc 'gh pr create --title x'"
case_check 'eval runs its argument' block "eval 'gh pr create --title x'"
# shellcheck disable=SC2016 # the $( ) is text for the guard to read
case_check 'a double-quoted substitution beside bash <script>' block \
  'bash scripts/x.sh "$(gh pr create --title x)"'
# The substitution reader is unchanged here (not #4436's masked read): a
# single-quoted substitution on a line that is not all text-takers still counts.
# shellcheck disable=SC2016 # the $( ) is text for the guard to read
case_check 'a single-quoted substitution behind git rebase -x' block \
  "git rebase -x 'echo \$(gh pr create --title x)' main"

# --- the refusal says what to run instead. ---
message=$(PR_CREATE_GUARD_FIXTURE_COMMAND='gh pr create --title x' node -e '
  require("fs").writeFileSync(process.env.PR_CREATE_GUARD_FIXTURE_PAYLOAD,
    JSON.stringify({ tool_name: "Bash", tool_input: { command: process.env.PR_CREATE_GUARD_FIXTURE_COMMAND } }));
' && node "$guard" <"$PR_CREATE_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
for needle in 'scripts/open-pr.sh --title' '--hold "<reason>"' '--dry-run' 'creating-pull-requests/SKILL.md'; do
  case "$message" in
    *"$needle"*) check "refusal names $needle" yes yes ;;
    *) check "refusal names $needle" yes no ;;
  esac
done

# --- a payload for another tool is never read; a broken payload fails open. ---
other=$(printf '%s' '{"tool_name":"Write","tool_input":{"command":"gh pr create"}}' | node "$guard" 2>/dev/null; echo "exit=$?")
check 'a non-Bash payload is allowed' 'exit=0' "$other"
broken=$(printf '%s' 'not json' | node "$guard" 2>/dev/null; echo "exit=$?")
check 'an unparseable payload fails open' 'exit=0' "$broken"

# --- it is wired in settings.json, through the fail-closed wrapper. ---
wired=$(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const hit = (s.hooks?.PreToolUse ?? []).some((e) => e.matcher === "Bash" &&
    e.hooks.some((h) => h.command.includes("run-node-hook.sh .claude/hooks/pr-create-guard.mjs || exit 2")));
  process.stdout.write(hit ? "yes" : "no");
' "$repo_root/.claude/settings.json" 2>&1)
check 'settings.json runs it on PreToolUse(Bash)' yes "$wired"

echo "pr-create-guard fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
