#!/usr/bin/env bash
# Fixture suite for .claude/hooks/merge-guard.mjs, the PreToolUse(Bash) guard
# that refuses admin merges: `gh pr merge --admin`, a REST PUT on
# `.../pulls/<n>/merge`, and the `mergePullRequest` GraphQL mutation.
#
# Same reason as scripts/test-git-guard.sh and scripts/test-process-guard.sh:
# reasoning about what a guard WOULD catch is not evidence about what it DOES
# catch. Every case runs through the hook's real entry point (a PreToolUse
# payload on stdin) and is asserted on the real contract (exit 2 to block,
# exit 0 to allow).
#
# The allow half carries more weight here than in either sibling. `gh pr merge
# --auto` is how every agent lands a PR, and this repo writes ABOUT admin
# merges constantly (the CI guide, the creating-pull-requests skill, PR bodies,
# commit messages, this file), so a guard that refuses the words gets switched
# off, and then it stops nothing.
#
# No differential tier, unlike test-process-guard.sh. That tier asserts "a
# fixture a real shell RUNS must be blocked", which holds there because every
# pkill fixture is a block case. Here the allow cases run `gh` too
# (`gh pr merge --auto 12`), so "the shell reached gh" says nothing about
# whether the call was an admin merge.
#
#   bash scripts/test-merge-guard.sh
#   GUARD=/path/to/other.mjs bash scripts/test-merge-guard.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
guard=${GUARD:-$repo_root/.claude/hooks/merge-guard.mjs}

payload_dir=$(mktemp -d -t merge-guard-payload.XXXXXX)
export MERGE_GUARD_FIXTURE_PAYLOAD=$payload_dir/payload.json
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

# Run one command through the hook exactly as Claude Code would. The payload
# goes through a file rather than a pipe on purpose (see test-git-guard.sh).
verdict() {
  local command=$1 stderr status
  MERGE_GUARD_FIXTURE_COMMAND="$command" node -e '
      require("fs").writeFileSync(
        process.env.MERGE_GUARD_FIXTURE_PAYLOAD,
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: process.env.MERGE_GUARD_FIXTURE_COMMAND },
        })
      );
    '
  stderr=$(node "$guard" <"$MERGE_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
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
    "Blocked: an admin merge"*) echo block ;;
    *) echo "block-unknown" ;;
  esac
}

case_check() {
  local name=$1 expected=$2 command=$3
  check "$name" "$expected" "$(verdict "$command")"
}

# Each line is `<expected-verdict> <command>`. Comments record why a case is
# here, so a future edit that flips one has to argue with the reason.
while read -r expected command; do
  [ -n "${expected:-}" ] || continue
  case "$expected" in \#*) continue ;; esac
  case_check "$command" "$expected" "$command"
done <<'CASES'
# --- gh pr merge --admin, in every position gh accepts it. ---
block gh pr merge --admin 1931
block gh pr merge 1931 --admin
block gh pr merge 1931 --squash --admin
block gh pr merge --admin --squash --delete-branch 1931
block gh pr merge --auto --admin 1931
block gh pr merge --admin=true 1931
block gh pr merge -R dork-labs/dorkos 1931 --admin
block gh pr merge --admin
# Wrappers, prefixes, compound lines and substitutions.
block GH_TOKEN=x gh pr merge 1931 --admin
block /opt/homebrew/bin/gh pr merge 1931 --admin
block cd /tmp && gh pr merge 1931 --admin
block git push && gh pr merge 1931 --admin; echo done
block sh -c "gh pr merge 1931 --admin"
block bash -c 'gh pr merge 1931 --admin'
block echo "$(gh pr merge 1931 --admin)"
block (gh pr merge 1931 --admin)
block for p in 1 2; do gh pr merge $p --admin; done
block eval 'gh pr merge 1931 --admin'
# Flags between `pr` and `merge`, and before `api`: gh accepts both orders (review I3).
block gh pr -R dork-labs/dorkos merge 12 --admin
block gh pr --repo dork-labs/dorkos merge 12 --admin
block gh pr --repo=x/y merge 12 --admin
block gh -R dork-labs/dorkos pr merge 12 --admin
block gh --repo=x/y api -X PUT repos/o/r/pulls/12/merge
block gh -R x/y api --method PUT repos/{owner}/{repo}/pulls/12/merge
allow gh pr -R dork-labs/dorkos merge 12 --auto
allow gh pr --repo=x/y view 12 --json mergeStateStatus
# Runners that execute the rest of their arguments.
block timeout 60 gh pr merge 12 --admin
block timeout -s KILL 60 gh api -X PUT repos/o/r/pulls/12/merge
block exec gh pr merge 12 --admin
block echo 12 | xargs gh pr merge --admin
block echo 12 | xargs -n1 -I{} gh pr merge {} --admin
block env -i PATH=/usr/bin gh pr merge 12 --admin
block env GH_TOKEN=x gh pr merge 12 --admin
block nice -n 5 gh pr merge 12 --admin
block sudo -u me gh pr merge 12 --admin
block ssh build-box gh pr merge 12 --admin
block ssh build-box 'gh pr merge 12 --admin'
block watch -n 60 'gh pr merge 12 --admin'
allow timeout 60 gh pr merge 12 --auto
allow echo 12 | xargs gh pr view
allow env GH_TOKEN=x gh pr checks 12
# Text piped into a shell runs (review I2, the pipe half).
block echo 'gh pr merge 12 --admin' | bash
block printf '%s\n' "gh api -X PUT repos/o/r/pulls/12/merge" | sh
allow echo 'gh pr merge 12 --admin' | tee notes.md
allow git commit -m "run gh pr merge --admin in bash? never"
# --- the REST merge endpoint: PUT merges now and never enters the queue. ---
block gh api -X PUT repos/dork-labs/dorkos/pulls/1931/merge
block gh api -X PUT /repos/dork-labs/dorkos/pulls/1931/merge -f merge_method=squash
block gh api --method PUT repos/{owner}/{repo}/pulls/1931/merge
block gh api --method=PUT repos/{owner}/{repo}/pulls/1931/merge
block gh api -XPUT repos/{owner}/{repo}/pulls/1931/merge
block gh api -X put repos/{owner}/{repo}/pulls/1931/merge
block gh api repos/{owner}/{repo}/pulls/1931/merge -X PUT
block gh api repos/{owner}/{repo}/pulls/1931/merge/ --method PUT
block gh api -H "Accept: application/vnd.github+json" -X PUT repos/o/r/pulls/7/merge -f sha=abc
block gh api "repos/o/r/pulls/$PR/merge" -X PUT
block bash -c 'gh api -X PUT repos/o/r/pulls/7/merge'
# --- the same merge through GraphQL (what --admin sends under the hood). ---
block gh api graphql -f query='mutation($id:ID!){ mergePullRequest(input:{pullRequestId:$id}){ clientMutationId } }' -f id=PR_x
block gh api graphql -F query='mutation { mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId } }'
block gh api graphql --raw-field=query='mutation{mergePullRequest(input:{pullRequestId:"PR_x"}){clientMutationId}}'
# --- allowed: the sanctioned ways to land a PR. The queue still runs every check. ---
allow gh pr merge --auto 1931
allow gh pr merge --auto --squash 1931
allow gh pr merge 1931 --auto
allow gh pr merge 1931
allow gh pr merge --disable-auto 1931
allow gh pr merge --admin=false 1931
allow gh pr view 1931 --json mergeStateStatus
allow gh pr checks 1931
# --- allowed: other gh api calls, including the merge endpoint read and the dequeue recipe. ---
allow gh api repos/{owner}/{repo}/pulls/1931/merge
allow gh api -X GET repos/{owner}/{repo}/pulls/1931/merge
allow gh api -X PUT repos/o/r/pulls/1931/requested_reviewers -f reviewers[]=x
allow gh api -X PUT repos/o/r/pulls/1931/update-branch
allow gh api repos/{owner}/{repo}/rules/branches/main
allow gh api -X POST repos/o/r/issues/1931/comments -f body='never run gh pr merge --admin; mergePullRequest is out'
allow gh api graphql -f query='mutation($id:ID!){ dequeuePullRequest(input:{id:$id}){ mergeQueueEntry { position } } }' -f id=PR_x
allow gh api graphql -f query='query { repository(owner:"o",name:"r"){ pullRequest(number:1){ mergeable } } }'
# --- allowed: text that merely names an admin merge. ---
allow git commit -m "docs(ci): never run gh pr merge --admin"
allow git commit -m 'refuse gh api -X PUT repos/o/r/pulls/1/merge'
allow gh pr create --title "chore(harness): merge guard" --body 'refuses `gh pr merge --admin` and `gh api -X PUT .../pulls/<n>/merge`'
allow gh pr comment 1931 --body "please do not gh pr merge 1931 --admin"
allow echo "gh pr merge --admin is reserved for break-glass"
allow echo 'gh pr merge 1931 --admin'
allow printf '%s\n' "gh api -X PUT repos/o/r/pulls/1/merge"
allow grep -rn "gh pr merge --admin" .claude/ contributing/
allow rg -- '--admin' .agents/skills/creating-pull-requests/SKILL.md
allow git log --grep='--admin'
allow node scripts/admin-report.mjs --admin
allow curl -s https://api.github.com/repos/o/r/pulls/1/merge
# Single quotes keep a substitution inert on a text-taker line.
allow gh pr create --body 'see $(gh pr merge 1 --admin)'
# Double quotes run it, so the same text there is a real merge.
block gh pr create --body "see $(gh pr merge 1 --admin)"
CASES

# --- heredocs: a quoted body is data, never a command. ---
# These span lines, so they cannot ride the one-line CASES table above.
case_check 'quoted heredoc body naming an admin merge' allow \
  $'cat > notes.md <<\'EOF\'\ngh pr merge --admin 1931\ngh api -X PUT repos/o/r/pulls/1/merge\nEOF'
case_check 'double-quoted heredoc delimiter' allow \
  $'cat <<"EOF" >notes.md\ngh pr merge 1931 --admin\nEOF'
case_check 'PR body heredoc in a substitution' allow \
  $'gh pr create --body "$(cat <<\'EOF\'\nThe guard refuses gh pr merge --admin.\nEOF\n)"'
case_check 'a real admin merge after a quoted heredoc ends' block \
  $'cat > notes.md <<\'EOF\'\nsafe text\nEOF\ngh pr merge 1931 --admin'
case_check 'a real admin merge before a quoted heredoc' block \
  $'gh pr merge 1931 --admin\ncat > notes.md <<\'EOF\'\nsafe text\nEOF'
# A heredoc fed to a shell is commands, not data (review I2).
case_check 'quoted heredoc into bash' block \
  $'bash <<\'EOF\'\ngh pr merge 12 --admin\nEOF'
case_check 'quoted heredoc into sh -s' block \
  $'sh -s <<\'EOF\'\necho hi\ngh pr merge 12 --admin\nEOF'
case_check 'quoted heredoc into zsh with a flag' block \
  $'zsh -e <<"EOF"\ngh api -X PUT repos/o/r/pulls/12/merge\nEOF'
case_check 'quoted heredoc piped into bash' block \
  $'cat <<\'EOF\' | bash\ngh pr merge 12 --admin\nEOF'
case_check 'quoted heredoc to a remote shell' block \
  $'ssh build-box <<\'EOF\'\ngh pr merge 12 --admin\nEOF'
case_check 'quoted heredoc into sudo bash' block \
  $'sudo bash <<\'EOF\'\ngh pr merge 12 --admin\nEOF'
case_check 'quoted heredoc into timeout sh' block \
  $'timeout 30 sh <<\'EOF\'\ngh pr merge 12 --admin\nEOF'
case_check 'quoted heredoc into eval via cat' block \
  $'eval "$(cat <<\'EOF\'\ngh pr merge 12 --admin\nEOF\n)"'
# ...while a heredoc given to a text-taker stays prose.
case_check 'commit message from a heredoc' allow \
  $'git commit -F - <<\'EOF\'\nchore(harness): refuse gh pr merge --admin\n\ngh api -X PUT repos/o/r/pulls/1/merge is refused too\nEOF'
case_check 'PR body from a heredoc on stdin' allow \
  $'gh pr create --title t --body-file - <<\'EOF\'\nThe guard refuses gh pr merge 12 --admin.\nEOF'
case_check 'heredoc to a script file that mentions bash' allow \
  $'cat <<\'EOF\' > notes.md\nNever run this in bash:\ngh pr merge 12 --admin\nEOF'
# An unquoted heredoc is read strictly (its substitutions are live), so a body
# line that is an admin merge is still refused: the documented false positive.
case_check 'unquoted heredoc body is read strictly' block \
  $'cat > notes.md <<EOF\ngh pr merge 1931 --admin\nEOF'
# A heredoc marker inside a comment is not a heredoc, so the next line runs.
case_check 'heredoc marker inside a comment' block \
  $'echo x # <<\'EOF\'\ngh pr merge 1931 --admin\nEOF'
# A multi-line single-quoted GraphQL query keeps its content.
case_check 'multi-line single-quoted mergePullRequest' block \
  $'gh api graphql -f query=\'\nmutation {\n  mergePullRequest(input: {pullRequestId: "PR_x"}) { clientMutationId }\n}\''

# --- the refusal says where the sanctioned path is. ---
message=$(MERGE_GUARD_FIXTURE_COMMAND='gh pr merge 1 --admin' node -e '
  require("fs").writeFileSync(process.env.MERGE_GUARD_FIXTURE_PAYLOAD,
    JSON.stringify({ tool_name: "Bash", tool_input: { command: process.env.MERGE_GUARD_FIXTURE_COMMAND } }));
' && node "$guard" <"$MERGE_GUARD_FIXTURE_PAYLOAD" 2>&1 >/dev/null)
for needle in '/ci:break-glass' 'contributing/ci.md' 'gh pr merge --auto <number>'; do
  case "$message" in
    *"$needle"*) check "refusal names $needle" yes yes ;;
    *) check "refusal names $needle" yes no ;;
  esac
done

# --- a payload for another tool is never read. ---
other=$(printf '%s' '{"tool_name":"Write","tool_input":{"command":"gh pr merge 1 --admin"}}' | node "$guard" 2>/dev/null; echo "exit=$?")
check 'a non-Bash payload is allowed' 'exit=0' "$other"

echo "merge-guard fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
