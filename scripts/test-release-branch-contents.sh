#!/usr/bin/env bash
# Fixture suite for scripts/ci/release-branch-contents.sh, the required-able
# `release-branch-contents` check on pull requests into release/v<X.Y.Z>
# (DOR-4639).
#
# Which commits may ship is DOR-4638's rule, packages/cli/scripts/release-branch/
# check-picks.ts over rules.ts, and its own suites (packages/cli/src/__tests__/
# release-branch-*.test.ts) pin the rule case by case. This suite pins what the
# shell check adds and the WIRING to the rule, end to end through the real
# check-picks.ts run from a copied folder exactly as CI runs main's copy:
#
#   - a clean cherry-pick -x and the release commit pass, together too;
#   - a commit main never saw, a pick whose source the branch already holds,
#     a pick of a commit main later reverted, and a pick that differs from its
#     source only by whitespace inside a string literal (which `git patch-id`
#     would accept) are refused by the rule, and its finding codes reach the
#     log and the summary as the rule names them;
#   - the release commit: a wrong subject (the rule's release-commit-subject),
#     and code, config migrations,
#     agent-release-notes.ts, a dependency change or a new fragment in it are
#     refused by the rule;
#   - the branch shape, a base off the branch, an empty range, a missing rule
#     folder, a shallow clone and an unknown head;
#   - hostile subjects print inert;
#   - BRANCH MODE (--branch/--version, the desktop tag check): a clean pick
#     plus the release commit at the tip passes; a head that is not the
#     fetched tip (head-not-branch-tip), a bad branch shape, a --version that
#     is not the branch's (version-not-branch), a release commit touching a
#     forbidden path, an orphan branch (base-not-on-main) and a main
#     force-moved off the cut (base-not-on-main / base-not-reachable, or the
#     rule) are refused; --branch with --base-ref or --base-sha, --version
#     without --branch, a malformed --version and a shallow clone are errors.
#
# Hermetic: throwaway git repositories in a temp directory with a local
# "origin". No network, no pnpm. Needs git, jq and node >= 22.6.
#
#   bash scripts/test-release-branch-contents.sh
#   CHECK=/path/to/other.sh RULE=/path/to/release-branch bash scripts/test-release-branch-contents.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
check=${CHECK:-$repo_root/scripts/ci/release-branch-contents.sh}
rule_src=${RULE:-$repo_root/packages/cli/scripts/release-branch}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GITHUB_STEP_SUMMARY

# The rule as CI runs it: main's copy, alone in a temp folder, nothing installed.
rule="$work/rule"
mkdir -p "$rule"
cp "$rule_src"/*.ts "$rule/" || { echo "no rule files in $rule_src"; exit 1; }

pass=0
fail=0

# --- The fixture: an upstream with main, a release branch and a stray branch.
up="$work/up"
git init -q -b main "$up"
cd "$up" || exit 1
printf '0.1.0' >VERSION
cat >package.json <<'JSON'
{
  "name": "fixture",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "zod": "^3.0.0"
  }
}
JSON
mkdir -p packages/cli changelog/unreleased changelog/archive docs src blog
printf '{\n  "name": "fixture-cli",\n  "version": "0.1.0"\n}\n' >packages/cli/package.json
printf '# Changelog\n\n## [Unreleased]\n' >CHANGELOG.md
printf '# Changelog\n' >docs/changelog.mdx
printf '# Archive\n' >changelog/archive/CHANGELOG-v0.1.0-to-v0.0.9.md
: >changelog/unreleased/.gitkeep
printf -- '---\ncovers:\n  - "#1"\n---\n\n### Fixed\n\n- One\n' >changelog/unreleased/frag-one.md
for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; done >src/a.txt
printf "export const greeting = 'hi there';\n" >src/str.ts
# Runnable code a release used to touch, present in the base so a release
# commit editing it shows as a modification (M), not an addition.
mkdir -p apps/server/src/services/core/config-migrations apps/server/src/services/core/__tests__ \
  apps/server/src/services/runtimes/shared/awareness
echo 'export const migrations = [];' >apps/server/src/services/core/config-migrations/index.ts
echo 'export const hashes = {};' >apps/server/src/services/core/__tests__/merged-migration-hashes.ts
echo "export const notes = [{ version: 'next' }];" >apps/server/src/services/runtimes/shared/awareness/agent-release-notes.ts
git add -A && git commit -q -m 'chore: base'
git tag v0.1.0

sed -i.bak 's/^line 2$/line two/' src/a.txt && rm src/a.txt.bak
git commit -q -am 'fix(a): line two (#1)'
M1=$(git rev-parse HEAD)
git branch release/v0.2.0

echo 'new file' >src/b.txt
git add src/b.txt && git commit -q -m 'fix(b): add b (#2)'
M2=$(git rev-parse HEAD)
sed -i.bak 's/^line 9$/line nine/' src/a.txt && rm src/a.txt.bak
git commit -q -am 'feat(a): line nine (#3)'
M3=$(git rev-parse HEAD)
printf "export const greeting = 'hello there';\n" >src/str.ts
git commit -q -am 'fix(str): friendlier greeting (#4)'
MW=$(git rev-parse HEAD)
echo 'reverted later' >src/r.txt
git add src/r.txt && git commit -q -m 'fix(r): add r (#5)'
MR=$(git rev-parse HEAD)
git revert --no-edit "$MR" >/dev/null

git checkout -q -b stray "$M1"
echo stray >src/stray.txt
git add src/stray.txt && git commit -q -m 'fix(stray): not on main'
X=$(git rev-parse HEAD)
git checkout -q main

# The clone CI would have: full history, origin = upstream.
clone="$work/clone"
git clone -q "$up" "$clone"
cd "$clone" || exit 1
git fetch -q origin stray
BASE=$(git rev-parse origin/release/v0.2.0)

# --- Helpers ---------------------------------------------------------------
# A fresh PR branch at the release branch's tip (or $1).
pr_branch() {
  git checkout -q -f -B pr "${1:-$BASE}" && git clean -qfd
}

out="$work/out"
summary="$work/summary.md"
# Run the check on HEAD; prints nothing, sets $code, keeps the log in $out.
run_check() {
  local ref=${1:-release/v0.2.0} base=${2:-$BASE} head=${3:-$(git rev-parse HEAD)}
  : >"$summary"
  bash "$check" --rule-dir "$rule" --base-ref "$ref" --base-sha "$base" --head-sha "$head" --summary "$summary" >"$out" 2>&1
  code=$?
}

expect() {
  # name, wanted exit code, [text the log must contain]
  local name=$1 want=$2 needle=${3:-}
  if [ "$code" -eq "$want" ] && { [ -z "$needle" ] || grep -qF -- "$needle" "$out"; }; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    # shellcheck disable=SC2016 # the quotes are part of the message
    echo "FAIL: $name (exit $code, wanted $want${needle:+, log containing '$needle'})"
    sed 's/^/    /' "$out"
  fi
}

release_commit() {
  # version in the subject, version in the files
  local subject=${1:-0.2.0} files=${2:-0.2.0}
  printf '%s' "$files" >VERSION
  jq --arg v "$files" '.version = $v' package.json >p.tmp && mv p.tmp package.json
  jq --arg v "$files" '.version = $v' packages/cli/package.json >p.tmp && mv p.tmp packages/cli/package.json
  printf '# Changelog\n\n## [Unreleased]\n\n## [%s]\n\n- One\n' "$files" >CHANGELOG.md
  printf '# Changelog\n\n## %s\n' "$files" >docs/changelog.mdx
  git rm -q changelog/unreleased/frag-one.md
  git mv changelog/archive/CHANGELOG-v0.1.0-to-v0.0.9.md changelog/archive/CHANGELOG-v0.1.0-to-v0.1.0.md
  mkdir -p blog
  printf -- '---\ntitle: DorkOS %s\n---\n' "$files" >"blog/dorkos-${files//./-}.mdx"
  mkdir -p "apps/site/public/product/archive/v$files"
  printf 'png' >"apps/site/public/product/archive/v$files/shot-dark.png"
  git add -A
  git commit -q -m "chore(release): v$subject"
}

# --- Passes ----------------------------------------------------------------
pr_branch
git cherry-pick -x "$M2" >/dev/null
run_check
expect 'a cherry-pick -x of a main commit after the cut passes' 0 'PASS'

pr_branch
release_commit
run_check
expect 'the release commit with only the release files passes' 0 'release commit for v0.2.0'

pr_branch
git cherry-pick -x "$M2" "$M3" >/dev/null
release_commit
run_check
expect 'two cherry-picks and the release commit pass together' 0 'ok, every commit'
grep -qF '| PASS | cherry-pick |' "$summary" && grep -qF '| PASS | release |' "$summary" &&
  grep -qF '**Passed:**' "$summary"
code=$?
expect 'the job summary carries a verdict row per commit' 0

# --- Refusals by the rule: picks ---------------------------------------------
pr_branch
echo 'brand new' >src/new.txt
git add src/new.txt && git commit -q -m 'fix(new): only on the branch'
run_check
expect 'a new commit that main never saw is refused by the rule' 1 'non-release-file: not a cherry-pick'

pr_branch
echo 'again' >src/again.txt
git add src/again.txt
git commit -q -m 'fix(a): line two (#1)' -m "(cherry picked from commit $M1)"
run_check
expect 'a pick citing a commit the branch already holds is refused' 1 'source-before-cut'
grep -qF '| REFUSE | cherry-pick |' "$summary" && grep -qF 'source-before-cut' "$summary"
code=$?
expect 'and the summary row names the code' 0

pr_branch
git cherry-pick -x "$MR" >/dev/null
run_check
expect 'a pick of a commit main later reverted is refused' 1 'source-reverted-on-main'

# The reason the rule is DOR-4638's: `git patch-id --stable` ignores
# whitespace, so a "pick" that changes a string literal's spacing would match
# its source. The rule's fingerprint is byte-exact.
pr_branch
git cherry-pick -x "$MW" >/dev/null
printf "export const greeting = 'hello  there';\n" >src/str.ts
git commit -q -a --amend --no-edit
if [ "$(git show HEAD | git patch-id --stable | cut -d' ' -f1)" = "$(git show "$MW" | git patch-id --stable | cut -d' ' -f1)" ]; then code=0; else code=1; fi
expect 'git patch-id --stable cannot tell the whitespace-edited pick from its source' 0
run_check
expect 'a pick that changes only whitespace inside a string literal is refused' 1 'patch-id-mismatch'

pr_branch
git cherry-pick -x "$MW" >/dev/null
run_check
expect 'and the clean pick of the same commit passes' 0 'PASS'

# --- Refusals: the release commit ---------------------------------------------
pr_branch
release_commit 0.3.0 0.3.0
run_check
expect 'a release commit for another version is refused (its package.json versions are not 0.2.0)' 1 'release-commit-package-json'

pr_branch
release_commit
git commit -q --amend -m 'chore: bump to 0.2.0'
run_check
expect "a release commit not titled chore(release): v0.2.0 is refused by the rule" 1 'release-commit-subject'

pr_branch
release_commit 0.2.0 0.2.1
run_check
expect "a release commit whose files say another version is refused" 1 'release-commit-package-json'

pr_branch
echo 'sneaky' >>src/a.txt
release_commit
run_check
expect 'a release commit with an extra file is refused' 1 'src/a.txt is not a release file'

pr_branch
jq '.dependencies.zod = "^4.0.0"' package.json >p.tmp && mv p.tmp package.json
release_commit
run_check
expect 'a release commit that changes a dependency is refused' 1 'package.json changes more than its version'

# Runnable code is never release metadata (Security's Must): each of these
# lands on main by a normal pull request before the cut. v0-2-0.ts is a NEW
# file; the other three exist in the base and are edited.
for path in apps/server/src/services/core/config-migrations/v0-2-0.ts \
  apps/server/src/services/core/config-migrations/index.ts \
  apps/server/src/services/core/__tests__/merged-migration-hashes.ts \
  apps/server/src/services/runtimes/shared/awareness/agent-release-notes.ts; do
  pr_branch
  mkdir -p "$(dirname "$path")"
  echo "export const stamp = '0.2.0';" >"$path"
  release_commit
  run_check
  expect "a release commit touching $path is refused" 1 "$path is not a release file"
done

pr_branch
printf -- '---\ncovers:\n  - "#9"\n---\n\n### Added\n\n- Sneaky\n' >changelog/unreleased/frag-new.md
release_commit
run_check
expect 'a release commit that adds a fragment is refused' 1 'changelog/unreleased/frag-new.md is not a release file'

# --- Refusals: the branch and the base ----------------------------------------
pr_branch
git cherry-pick -x "$M2" >/dev/null
for ref in release/0.2.0 release/v0.2 release/v02.0.0 release/v0.2.0-rc.1 main release/v0.2.0/x; do
  run_check "$ref"
  expect "the branch shape '$ref' is refused" 1 'is not a release branch'
done
# shellcheck disable=SC2016 # literal: the point is that it never expands
run_check 'release/v0.2.0$(touch pwned)'
expect 'a branch name carrying shell is refused as data' 1 'is not a release branch'
if [ ! -e pwned ] && [ ! -e "$work/pwned" ]; then code=0; else code=1; fi
expect 'and nothing in it ran' 0

pr_branch
git cherry-pick -x "$M2" >/dev/null
run_check release/v0.2.0 "$X"
expect 'a base that is not on the release branch is refused' 1 'is not on release/v0.2.0'

# --- Could not decide (exit 2) ---------------------------------------------------
pr_branch
git cherry-pick -x "$M2" >/dev/null
: >"$summary"
bash "$check" --rule-dir "$work/no-such-rule" --base-ref release/v0.2.0 --base-sha "$BASE" \
  --head-sha "$(git rev-parse HEAD)" >"$out" 2>&1
code=$?
expect 'no check-picks.ts (DOR-4638 not on main yet) fails closed' 2 'no check-picks.ts'

# A rule that says nothing, or contradicts itself, is not a pass.
fake="$work/fake-rule"
mkdir -p "$fake"
for body in 'process.exitCode = 0;' \
  'console.log(JSON.stringify({ ok: true, findings: [] })); process.exitCode = 1;' \
  'console.log(JSON.stringify({ ok: false, findings: [] })); process.exitCode = 1;' \
  'process.exitCode = 2;'; do
  printf '%s\n' "$body" >"$fake/check-picks.ts"
  : >"$summary"
  bash "$check" --rule-dir "$fake" --base-ref release/v0.2.0 --base-sha "$BASE" \
    --head-sha "$(git rev-parse HEAD)" >"$out" 2>&1
  code=$?
  expect "a rule that answers '$body' fails closed" 2 'check-picks.ts'
done

pr_branch
git cherry-pick -x "$M2" >/dev/null
run_check release/v0.2.0 "$BASE" "$(printf '0%.0s' $(seq 40))"
expect 'an unknown head is an error, not a pass' 2 'is not a commit in this clone'

run_check release/v0.2.0 "$BASE" HEAD
expect 'a non-sha head is an error' 2 'is not a full commit sha'

shallow="$work/shallow"
git clone -q --depth=1 --branch release/v0.2.0 "file://$up" "$shallow"
(
  cd "$shallow" || exit 1
  git checkout -q -b pr
  echo x >src/x.txt && git add src/x.txt && git commit -q -m 'fix: x'
  bash "$check" --rule-dir "$rule" --base-ref release/v0.2.0 --base-sha "$BASE" --head-sha "$(git rev-parse HEAD)" >"$out" 2>&1
)
code=$?
expect 'a shallow clone is an error, not a pass' 2 'shallow'

# --- Untrusted subjects ----------------------------------------------------------
pr_branch
echo 'evil' >src/evil.txt
# shellcheck disable=SC2016 # literal: the point is that it never expands
git add src/evil.txt && git commit -q -m '::error::forged | `$(touch pwned2)` subject'
run_check
expect 'a hostile subject is refused like any new commit' 1 'not a cherry-pick'
! grep -q '^::' "$out" && ! grep -qF '::error::forged' "$summary" && grep -qF 'forged \|' "$summary" &&
  [ ! -e pwned2 ]
code=$?
expect 'and it is printed inert: no workflow command, no table break, nothing run' 0

# --- Branch mode (the desktop tag check) -------------------------------------------
# Publish HEAD as the upstream's release branch (default release/v0.2.0).
publish() {
  git push -q -f origin "HEAD:refs/heads/${1:-release/v0.2.0}" || exit 1
}
# Judge a whole branch: branch, version, head (default: HEAD), remote.
run_branch() {
  local ref=${1:-release/v0.2.0} version=${2:-0.2.0} head=${3:-$(git rev-parse HEAD)} rem=${4:-origin}
  : >"$summary"
  bash "$check" --rule-dir "$rule" --branch "$ref" --version "$version" --head-sha "$head" \
    --remote "$rem" --summary "$summary" >"$out" 2>&1
  code=$?
}

pr_branch
git cherry-pick -x "$M2" >/dev/null
release_commit
publish
TIP=$(git rev-parse HEAD)
run_branch
expect 'branch mode: a pick and the release commit at the tip pass' 0 'ok, every commit'
grep -qF "Branch \`release/v0.2.0\`, base \`${M1:0:12}\`" "$summary" && grep -qF '**Passed:**' "$summary"
code=$?
expect 'branch mode: the summary names the branch and the merge-base with main' 0

run_branch release/v0.2.0 0.2.0 "$(git rev-parse HEAD~1)"
expect 'branch mode: a head that is not the branch tip is refused' 1 'head-not-branch-tip'

for ref in release/0.2.0 release/v02.0.0; do
  run_branch "$ref"
  expect "branch mode: the branch shape '$ref' is refused" 1 'is not a release branch'
done

run_branch release/v0.2.0 0.2.1
expect 'branch mode: a --version that is not the branch version is refused' 1 'version-not-branch'
for v in 0.2 02.0.0 0.2.0-rc.1 'v0.2.0'; do
  run_branch release/v0.2.0 "$v"
  expect "branch mode: a malformed --version '$v' is an error" 2 'is not X.Y.Z'
done

: >"$summary"
bash "$check" --rule-dir "$rule" --branch release/v0.2.0 --version 0.2.0 --base-ref release/v0.2.0 \
  --head-sha "$TIP" >"$out" 2>&1
code=$?
expect 'branch mode: --branch with --base-ref is an error' 2 'cannot be combined'
bash "$check" --rule-dir "$rule" --branch release/v0.2.0 --version 0.2.0 --base-sha "$BASE" \
  --head-sha "$TIP" >"$out" 2>&1
code=$?
expect 'branch mode: --branch with --base-sha is an error' 2 'cannot be combined'
bash "$check" --rule-dir "$rule" --base-ref release/v0.2.0 --base-sha "$BASE" --version 0.2.0 \
  --head-sha "$TIP" >"$out" 2>&1
code=$?
expect 'pr mode: --version without --branch is an error' 2 'only for branch mode'

bshallow="$work/bshallow"
git clone -q --depth=1 --branch release/v0.2.0 "file://$up" "$bshallow"
(
  cd "$bshallow" || exit 1
  bash "$check" --rule-dir "$rule" --branch release/v0.2.0 --version 0.2.0 --head-sha "$TIP" >"$out" 2>&1
)
code=$?
expect 'branch mode: a shallow clone is an error, not a pass' 2 'shallow'

pr_branch
mkdir -p .github/workflows
echo 'on: push' >.github/workflows/sneaky.yml
release_commit
publish
run_branch
expect 'branch mode: a release commit touching .github/ is refused by the rule' 1 'release-commit-forbidden-path'

git checkout -q -f --orphan orphan
git rm -rqf . && git clean -qfd
printf '0.2.0' >VERSION
git add VERSION && git commit -q -m 'chore(release): v0.2.0'
publish
run_branch
expect 'branch mode: an orphan release branch is refused' 1 'base-not-on-main'

# Main force-moved in the upstream after the cut. A second upstream so the
# first one keeps its main. Rewritten to a new root with the same tree (the
# cut commit dropped): no merge-base at all.
moved="$work/moved"
git clone -q --bare "$up" "$moved"
git remote add moved "$moved"
pr_branch
git cherry-pick -x "$M2" >/dev/null
release_commit
git push -q -f moved HEAD:refs/heads/release/v0.2.0
MTIP=$(git rev-parse HEAD)
run_branch release/v0.2.0 0.2.0 "$MTIP" moved
expect 'branch mode: the same branch passes against the second upstream before main moves' 0 'ok, every commit'
git --git-dir="$moved" update-ref refs/heads/main "$(git --git-dir="$moved" commit-tree -m 'rewritten main' 'main^{tree}')"
run_branch release/v0.2.0 0.2.0 "$MTIP" moved
if [ "$code" -eq 1 ] && grep -qE 'base-not-on-main|base-not-reachable' "$out"; then code=0; else code=1; fi
expect 'branch mode: main rewritten so the cut is gone is refused (base-not-on-main or base-not-reachable)' 0
# Main reset to before the cut: the merge-base slides back, the cut commit
# itself falls into the range and the rule refuses it. Never a pass.
git --git-dir="$moved" update-ref refs/heads/main "$(git rev-parse "$M1^")"
run_branch release/v0.2.0 0.2.0 "$MTIP" moved
expect 'branch mode: main reset to before the cut is refused, never a pass' 1 'REFUSED'

# Criss-cross: main and the branch each merged the other after the cut, so
# they share two merge-bases. Refused, never resolved by picking one. A third
# upstream so the others keep their history.
cross="$work/cross"
git clone -q --bare "$up" "$cross"
git remote add cross "$cross"
git fetch -q cross
git checkout -q -f -B xmain cross/main
printf 'x on main\n' >xmain.txt && git add xmain.txt && git commit -q -m 'x: main side'
XA=$(git rev-parse HEAD)
git checkout -q -f -B xbranch "$XA^"
printf 'x on branch\n' >xbranch.txt && git add xbranch.txt && git commit -q -m 'x: branch side'
XB=$(git rev-parse HEAD)
git checkout -q -f xmain && git merge -q --no-edit "$XB" >/dev/null
git checkout -q -f xbranch && git merge -q --no-edit "$XA" >/dev/null
git push -q -f cross xmain:refs/heads/main xbranch:refs/heads/release/v0.2.0
XTIP=$(git rev-parse xbranch)
nb=$(git merge-base --all xmain xbranch | grep -c .)
if [ "$nb" -eq 2 ]; then code=0; else code=1; fi
expect 'the criss-cross fixture really has two merge-bases' 0
run_branch release/v0.2.0 0.2.0 "$XTIP" cross
expect 'branch mode: a criss-cross history with two merge-bases is refused' 1 'base-ambiguous: release branch has 2 merge-bases with main; recut it'

echo
echo "release-branch-contents fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
