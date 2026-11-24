#!/usr/bin/env bash
# Fixture suite for scripts/browser-smoke-scope.sh, the decision that lets a
# pull request whose diff no browser leg loads skip browser-test.yml's four
# `browser-smoke` shards (DOR-5111).
#
# Both directions fail, and not equally:
#
#   too broad  — a change a page loads skips the smoke at PR time, goes green,
#                and is first seen as a merge queue ejection. This is the one
#                that matters.
#   too narrow — a workflow, test-only or docs change pays four smoke runners
#                (about 80 job-minutes per push) for code no page loads.
#
# So every kind of path the script lets through has a fixture that must score
# `false`, and every near-miss (a test beside its source, apps/e2e's own test
# folder, an inert package's package.json, ci-steward's bin/, browser-test.yml,
# a fixture-suite-shaped folder, a file moved out of the browser apps) has one
# that must score `true`.
#
# It runs browser-test.yml's own decision step, extracted from the YAML, in a
# depth-2 clone of a real test-merge commit: only a pull request on the full
# lane consults the script, only the base commit's copy counts, and the queue,
# the canary, a release pull request and a depth-1 checkout never stand the
# smoke down.
#
# Then it checks the script's INERT_WORKSPACES against the real tree: none may
# be in the workspace dependency closure of @dorkos/client, @dorkos/server or
# @dorkos/e2e, and no code on the smoke path may name one by path or package
# name. Add a dependency on one, or read a file out of one, and this suite goes
# red until the entry is removed from the list.
#
# Hermetic fixtures: each case builds a throwaway git repository in a temp
# directory. The real-tree checks read this checkout. No network, no pnpm.
#
#   bash scripts/test-browser-smoke-scope.sh
#   SCOPE=/path/to/other.sh bash scripts/test-browser-smoke-scope.sh
#   WORKFLOW=/path/to/browser-test.yml bash scripts/test-browser-smoke-scope.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/browser-smoke-scope.sh}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

pass=0
fail=0

ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}

# A fresh repository with a base commit shaped like the monorepo. Prints its
# path, and nothing else: it runs in a command substitution.
fresh_repo() {
  local repo
  repo=$(mktemp -d "$work/repo.XXXXXX")
  mkdir -p "$repo/apps/client/src" "$repo/apps/server/src/__tests__" "$repo/docs" \
    "$repo/packages/shared/src" "$repo/.github/workflows" "$repo/scripts"
  echo 'export const a = 1;' >"$repo/apps/client/src/index.ts"
  echo 'export const s = 1;' >"$repo/apps/server/src/index.ts"
  echo 'it("x", () => {});' >"$repo/apps/server/src/__tests__/x.test.ts"
  echo 'export const b = 1;' >"$repo/packages/shared/src/index.ts"
  echo 'on: pull_request' >"$repo/.github/workflows/browser-test.yml"
  echo 'on: pull_request' >"$repo/.github/workflows/test.yml"
  echo '# Docs' >"$repo/docs/index.mdx"
  echo '{}' >"$repo/package.json"
  {
    git -C "$repo" init -q
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
  } >/dev/null 2>&1
  echo "$repo"
}

score() { (cd "$1" && bash "$scope" "$2" "$3" 2>/dev/null); }

# expect <want> <label> <path...>: write each path (creating its folder) in a
# fresh repository, commit, and score HEAD^..HEAD.
expect() {
  local want=$1 label=$2 r p got
  shift 2
  r=$(fresh_repo)
  for p in "$@"; do
    mkdir -p "$r/$(dirname "$p")"
    echo "changed $RANDOM" >>"$r/$p"
  done
  git -C "$r" add -A && git -C "$r" commit -q -m change >/dev/null
  got=$(score "$r" HEAD^ HEAD)
  if [ "$got" = "$want" ]; then ok; else bad "$label: expected '$want', got '$got' for: $*"; fi
}

# --- nothing a browser leg loads: false ---------------------------------------
expect false 'a changelog fragment' changelog/unreleased/261123-000000-x.md
expect false 'the root CHANGELOG.md and README.md' CHANGELOG.md README.md
expect false 'docs, blog and research' docs/guides/x.mdx blog/post.mdx research/20261123_x.md
expect false 'a contributing guide' contributing/ci.md contributing/deep/nested.md
expect false 'a ledger entry' ci/ledger/261123-000000-x.md
expect false 'another workflow' .github/workflows/test.yml .github/workflows/new.yaml
expect false 'a scripts vitest suite' scripts/__tests__/x.test.ts scripts/__tests__/fixtures/a.json
expect false 'a fixture suite' scripts/test-something.sh
expect false 'a server test folder' apps/server/src/services/x/__tests__/x.test.ts
expect false 'a client test folder' apps/client/src/layers/x/__tests__/X.test.tsx
expect false "a package's root test folder" apps/client/__tests__/setup.ts
expect false 'a shared-package test folder' packages/shared/src/__tests__/x.test.ts
expect false 'the marketing site' apps/site/src/app/page.tsx
expect false 'the desktop shell' apps/desktop/src/main/index.ts
expect false 'the design-system app' apps/design-system/src/App.tsx
expect false 'the evals package' packages/evals/src/suite/x.ts
expect false 'ci-steward source and tests' packages/ci-steward/src/cli.ts packages/ci-steward/src/__tests__/x.test.ts
expect false 'a typical CI change: workflow, fixture suite, ledger, steward' \
  .github/workflows/scripts-test.yml scripts/test-x.sh ci/ledger/x.md packages/ci-steward/src/census.ts
expect false 'docs paths with a space and non-ASCII names' 'docs/with space.mdx' 'docs/naïve-välkommen.mdx'

r=$(fresh_repo)
git -C "$r" rm -q apps/server/src/__tests__/x.test.ts
git -C "$r" commit -q -m delete >/dev/null
got=$(score "$r" HEAD^ HEAD)
if [ "$got" = false ]; then ok; else bad "a deleted server test: expected 'false', got '$got'"; fi

# --- something a browser leg loads: true --------------------------------------
expect true 'client source' apps/client/src/index.ts
expect true 'server source' apps/server/src/index.ts
expect true 'a shared package' packages/shared/src/index.ts
expect true 'the UI package' packages/ui/src/button.tsx
expect true 'a smoke spec' apps/e2e/tests/x.spec.ts
expect true "apps/e2e's own test folder" apps/e2e/__tests__/x.test.ts
expect true 'a page object' apps/e2e/pages/x.ts
expect true 'the Playwright config' apps/e2e/playwright.config.ts
expect true 'the browser workflow itself' .github/workflows/browser-test.yml
expect true 'a .github script' .github/scripts/x.sh
expect true 'a test beside its source, outside __tests__' apps/server/src/x.test.ts
expect true 'a __tests__ folder outside src/' apps/server/lib/__tests__/x.ts
expect true 'the lockfile' pnpm-lock.yaml
expect true 'turbo.json' turbo.json
expect true 'the root package.json' package.json
expect true "an inert workspace's package.json" apps/site/package.json
expect true "ci-steward's bin/, which heavy-run-lock.sh sources" packages/ci-steward/bin/time-wrap.sh
expect true 'a script' scripts/heavy-run-lock.sh
expect true 'a scripts/lib helper' scripts/lib/heavy-order.sh
expect true 'a fixture-suite-shaped folder' scripts/test-x/run.sh
expect true 'ci config the e2e lock reads' ci/config.yaml
expect true 'a package README' packages/shared/README.md
expect true 'a contributing file that is not Markdown' contributing/x.json
expect true 'a workflow in a nested folder' .github/workflows/sub/x.yml
expect true 'an unknown root file' .nvmrc
expect true 'docs mixed with client source' docs/x.mdx apps/client/src/index.ts
expect true 'a name that only starts like an inert workspace' apps/sitex/src/a.ts apps/desktop-two/a.ts
expect true 'a near-miss README' README.md.orig

r=$(fresh_repo)
git -C "$r" mv apps/client/src/index.ts docs/index.ts
git -C "$r" commit -q -m move >/dev/null
got=$(score "$r" HEAD^ HEAD)
if [ "$got" = true ]; then ok; else bad "a client file moved into docs: expected 'true', got '$got'"; fi

r=$(fresh_repo)
git -C "$r" commit -q --allow-empty -m empty >/dev/null
got=$(score "$r" HEAD^ HEAD)
if [ "$got" = true ]; then ok; else bad "an empty diff: expected 'true', got '$got'"; fi

r=$(fresh_repo)
got=$(score "$r" 0123456789abcdef0123456789abcdef01234567 HEAD)
if [ "$got" = true ]; then ok; else bad "an unknown base: expected 'true', got '$got'"; fi
got=$(score "$r" HEAD no-such-ref)
if [ "$got" = true ]; then ok; else bad "an unknown head: expected 'true', got '$got'"; fi

for args in '' 'one' 'one two three' '--inert-workspaces extra'; do
  # shellcheck disable=SC2086
  got=$(cd "$r" && bash "$scope" $args 2>/dev/null)
  if [ "$got" = true ]; then ok; else bad "bad arguments '$args': expected 'true', got '$got'"; fi
done

mkdir -p "$work/not-a-repo"
got=$(cd "$work/not-a-repo" && GIT_CEILING_DIRECTORIES=$work bash "$scope" HEAD^ HEAD 2>/dev/null)
if [ "$got" = true ]; then ok; else bad "outside a repository: expected 'true', got '$got'"; fi

# --- the workflow step, run as a runner would -----------------------------------
# browser-test.yml's step body, extracted and run over a real test-merge commit.
# Its base carries a STUB scope script that records being reached and answers
# `false`, so these cases show which events and lanes ever consult the script,
# and that only the base's copy counts.
workflow=${WORKFLOW:-$repo_root/.github/workflows/browser-test.yml}
step_body=$(awk '
  /^ *- name: Decide whether a browser can load this change$/ { found = 1; next }
  found && !inrun && /^ *run: \|$/ { inrun = 1; next }
  inrun {
    if ($0 !~ /^ *$/) {
      match($0, /^ */)
      if (!indent) indent = RLENGTH
      if (RLENGTH < indent) exit
    }
    print substr($0, indent + 1)
  }' "$workflow")
if [ -n "$step_body" ]; then ok; else bad "browser-test.yml has no 'Decide whether a browser can load this change' step"; fi
printf '%s\n' "$step_body" >"$work/step.sh"

# run_step <event> <lane> <pr-file> <base-script> [depth] [shape]: build main
# with <base-script> as its scripts/browser-smoke-scope.sh (`stub`, which
# records being reached and answers `false` without looking; `real`, this
# checkout's copy; or `none`), a feature branch changing <pr-file>, and on top
# of main either the test-merge commit (<shape> `merge`, the default, what a
# pull request checks out) or one squash commit (`squash`, what a merge-queue
# entry checks out). Then clone that at <depth> (default 2, what the job's
# checkout fetches) and run the step in the clone, as a runner would. Sets
# step_out (GITHUB_OUTPUT) and step_reached.
run_step() {
  local event=$1 lane=$2 file=$3 base_script=$4 depth=${5:-2} shape=${6:-merge} r t c
  r=$(mktemp -d "$work/merge.XXXXXX")
  t=$(mktemp -d "$work/runner.XXXXXX")
  c=$(mktemp -d "$work/clone.XXXXXX")
  mkdir -p "$r/scripts" "$r/docs" "$r/apps/client/src"
  echo '# Docs' >"$r/docs/index.mdx"
  echo 'export const a = 1;' >"$r/apps/client/src/index.ts"
  case $base_script in
    stub) printf '#!/usr/bin/env bash\necho reached >>"%s/reached"\necho false\n' "$t" >"$r/scripts/browser-smoke-scope.sh" ;;
    real) cp "$scope" "$r/scripts/browser-smoke-scope.sh" ;;
  esac
  {
    git -C "$r" init -q -b main
    git -C "$r" add -A
    git -C "$r" commit -q -m base
    git -C "$r" checkout -q -b feature
    mkdir -p "$r/$(dirname "$file")"
    echo 'echo false' >>"$r/$file"
    git -C "$r" add -A
    git -C "$r" commit -q -m change
    git -C "$r" checkout -q main
    if [ "$shape" = squash ]; then
      git -C "$r" merge -q --squash feature
      git -C "$r" commit -q -m 'queue entry'
    else
      git -C "$r" merge -q --no-ff -m 'test merge' feature
    fi
    git clone -q --depth "$depth" "file://$r" "$c"
  } >/dev/null 2>&1
  : >"$t/output"
  (cd "$c" && EVENT=$event LANE=$lane GITHUB_OUTPUT=$t/output RUNNER_TEMP=$t bash "$work/step.sh" >/dev/null 2>&1)
  step_out=$(cat "$t/output")
  step_reached=no
  [ -f "$t/reached" ] && step_reached=yes
  return 0
}

# The job's checkout must fetch the test-merge commit's parents.
job=$(awk '/^  text-only-scope:$/ { on = 1; next } on && /^  [a-z][a-z-]*:$/ { exit } on' "$workflow")
if grep -q 'fetch-depth: 2$' <<<"$job"; then ok; else
  bad 'the text-only-scope job no longer checks out at depth 2; the step cannot see the base'
fi

run_step pull_request full docs/x.mdx stub
if [ "$step_out" = 'browser=none' ] && [ "$step_reached" = yes ]; then ok; else
  bad "pull_request on the full lane: expected browser=none from the base script, got '$step_out' (reached: $step_reached)"
fi

# The real script, in a depth-2 clone: a docs change stands the smoke down, a
# client change runs it.
run_step pull_request full docs/x.mdx real
if [ "$step_out" = 'browser=none' ]; then ok; else bad "the real script on a docs change: expected browser=none, got '$step_out'"; fi
run_step pull_request full apps/client/src/index.ts real
if [ -z "$step_out" ]; then ok; else bad "the real script on a client change: expected no output, got '$step_out'"; fi

# Depth 1 has no base to diff: the smoke runs.
run_step pull_request full docs/x.mdx real 1
if [ -z "$step_out" ]; then ok; else bad "a depth-1 checkout: expected no output, got '$step_out'"; fi

# A merge-queue entry (DOR-5130) is one squash commit on its parent: the step
# diffs HEAD^1..HEAD with the base's script, as for a pull request.
run_step merge_group full docs/x.mdx stub 2 squash
if [ "$step_out" = 'browser=none' ] && [ "$step_reached" = yes ]; then ok; else
  bad "merge_group on the full lane: expected browser=none from the base script, got '$step_out' (reached: $step_reached)"
fi
run_step merge_group full docs/x.mdx real 2 squash
if [ "$step_out" = 'browser=none' ]; then ok; else bad "the real script on a queued docs change: expected browser=none, got '$step_out'"; fi
run_step merge_group full apps/client/src/index.ts real 2 squash
if [ -z "$step_out" ]; then ok; else bad "the real script on a queued client change: expected no output, got '$step_out'"; fi
run_step merge_group full docs/x.mdx real 1 squash
if [ -z "$step_out" ]; then ok; else bad "a depth-1 queue checkout: expected no output, got '$step_out'"; fi
run_step merge_group full scripts/browser-smoke-scope.sh none 2 squash
if [ -z "$step_out" ]; then ok; else bad "a queue entry whose base has no scope script: expected no output, got '$step_out'"; fi

for event in release_pull_request schedule workflow_dispatch push ''; do
  run_step "$event" full docs/x.mdx stub
  if [ -z "$step_out" ] && [ "$step_reached" = no ]; then ok; else
    bad "event '$event': expected no output and no script run, got '$step_out' (reached: $step_reached)"
  fi
done

for lane in specs none ''; do
  run_step pull_request "$lane" docs/x.mdx stub
  if [ -z "$step_out" ] && [ "$step_reached" = no ]; then ok; else
    bad "text-only lane '$lane': expected the step to keep it, got '$step_out' (reached: $step_reached)"
  fi
done

# The pull request adds its own copy, which answers `false`; the base has none,
# so the smoke runs: the PR cannot grade itself.
run_step pull_request full scripts/browser-smoke-scope.sh none
if [ -z "$step_out" ]; then ok; else bad "a base with no scope script: expected no output, got '$step_out'"; fi

# The job output reads this step before the text-only lane's, so `none` wins
# only where this step wrote it.
if grep -qF "browser: \${{ steps.browserscope.outputs.browser || steps.textonly.outputs.browser || 'full' }}" "$workflow"; then ok; else
  bad "text-only-scope's browser output no longer reads the no-browser step first"
fi

# --- the inert workspaces, against the real tree --------------------------------
inert=()
while IFS= read -r ws; do [ -n "$ws" ] && inert+=("$ws"); done < <(bash "$scope" --inert-workspaces)
if [ "${#inert[@]}" -gt 0 ]; then ok; else bad '--inert-workspaces printed nothing'; fi

# The smoke job builds exactly these two, so the closure below is what it builds.
if grep -qF 'pnpm exec turbo run build --filter=@dorkos/server --filter=@dorkos/client' \
  "$repo_root/.github/workflows/browser-test.yml"; then ok; else
  bad "browser-smoke no longer builds exactly @dorkos/server and @dorkos/client; recheck INERT_WORKSPACES against what it builds"
fi

# Every workspace package the browser apps reach through any dependency field.
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
closure=$(cd "$repo_root" && node -e '
  const fs = require("fs");
  const dirs = ["apps", "packages"].flatMap((top) =>
    fs.readdirSync(top).map((d) => `${top}/${d}`).filter((d) => fs.existsSync(`${d}/package.json`)));
  const pkg = {}, byName = {};
  for (const d of dirs) { pkg[d] = JSON.parse(fs.readFileSync(`${d}/package.json`, "utf8")); byName[pkg[d].name] = d; }
  const seen = new Set(), todo = ["apps/client", "apps/server", "apps/e2e"];
  while (todo.length) {
    const d = todo.pop();
    if (seen.has(d) || !pkg[d]) continue;
    seen.add(d);
    for (const f of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
      for (const n of Object.keys(pkg[d][f] || {})) if (byName[n]) todo.push(byName[n]);
  }
  console.log([...seen].join("\n"));
') || closure=''
if [ -n "$closure" ] && grep -qx apps/client <<<"$closure"; then ok; else bad 'could not compute the browser apps'"'"' workspace closure'; fi

# Code on the smoke path: the browser apps and every package they reach, minus
# test folders, builds and installs, plus the scripts the smoke job and the e2e
# script run. Comment lines are dropped: prose may name anything.
smoke_files() {
  local d
  while IFS= read -r d; do
    [ -n "$d" ] && find "$repo_root/$d" \( -name node_modules -o -name dist -o -name __tests__ -o -name .turbo -o -name .next \) -prune -o \
      -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.json' -o -name '*.sh' \) \
      ! -name '*.test.*' -print
  done <<<"$closure"
  printf '%s\n' "$repo_root/scripts/heavy-run-lock.sh" "$repo_root/scripts/playwright-apt-debs.sh" "$repo_root/scripts/heavy-turbo-slot.mjs"
  find "$repo_root/scripts/lib" "$repo_root/scripts/load-gate" -type f ! -path '*/__tests__/*' 2>/dev/null
}
files=$(smoke_files | sort -u)

# References read and judged not to put an inert workspace on the smoke path.
# Each names one file and one workspace, so a NEW reference anywhere, even in
# the same folder to a different workspace, still goes red. Keep the reason.
known_reference() {
  case "$1|$2" in
    # A hand-run icon generator; `vite build` never runs it.
    'apps/client/scripts/generate-pwa-icons.ts|apps/desktop') return 0 ;;
    # The packaged two-desktop runner and the screenshot capture tooling are
    # their own tsx entry points, not Playwright projects the smoke runs.
    apps/e2e/community-two-desktop/*'|apps/desktop') return 0 ;;
    apps/e2e/capture/*'|apps/site') return 0 ;;
    # '@dorkos/desktop' here is the name of a user-data folder the server
    # protects, not an import.
    'apps/server/src/services/runtimes/shared/policy/protected-paths.ts|apps/desktop') return 0 ;;
  esac
  return 1
}

for ws in ${inert[@]+"${inert[@]}"}; do
  if [ -f "$repo_root/$ws/package.json" ]; then ok; else
    bad "inert workspace '$ws' has no package.json in this tree"
    continue
  fi
  if grep -qx "$ws" <<<"$closure"; then
    bad "inert workspace '$ws' is in the browser apps' dependency closure; remove it from INERT_WORKSPACES"
  else ok; fi
  name=$(jq -r .name "$repo_root/$ws/package.json")
  base=${ws#*/}
  # ci-steward's bin/time-wrap.sh is sourced by heavy-run-lock.sh; the scope
  # script keeps that folder in scope, so that one reference is expected.
  hits=$(xargs grep -nE -- "$ws/|(\.\./)+$base/|['\"]$name(/[^'\"]*)?['\"]" <<<"$files" 2>/dev/null |
    grep -vE ':[0-9]+:[[:space:]]*(\*|//|/\*|#)' |
    grep -vE "packages/ci-steward/bin/" || true)
  hits=$(while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    rel=${hit#"$repo_root"/}
    rel=${rel%%:*}
    known_reference "$rel" "$ws" || echo "$hit"
  done <<<"$hits")
  if [ -z "$hits" ]; then ok; else
    bad "inert workspace '$ws' is named by code on the smoke path; remove it from INERT_WORKSPACES or drop the reference:"$'\n'"$hits"
  fi
done

echo "browser-smoke-scope: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
