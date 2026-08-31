#!/usr/bin/env bash
# Fixture suite for scripts/seeded-pack-changed.sh, the scoping decision behind
# the `version-outranks-base` required check.
#
# It exists because that decision is the whole of the guard's precision, in both
# directions, and each direction fails in its own quiet way:
#
#   too broad  — a comment-only edit demands a version bump nobody owes, and the
#                cheapest way out is a bump with no content behind it, which
#                writes six byte-identical files into every agent workspace and
#                puts a meaningless entry in the History block the ratchet
#                argument depends on.
#   too narrow — a real pack edit is waved through, `seed.ts` upgrades nobody,
#                and the correction reaches no existing agent. That is DOR-509,
#                the failure the guard was written for, and it is invisible: the
#                check goes green.
#
# So both verdicts are pinned here, and the DOR-509 shape is pinned explicitly.
#
# HERMETIC, on purpose (same argument as scripts/test-assert-tests-executed.sh):
# every case builds a throwaway git repository in a temp dir with the real
# PACK_FILE and SKILLS_DIR paths, so the suite exercises the actual constants
# without reading this repo's history or going red when the real pack changes.
# GIT_CONFIG_GLOBAL/SYSTEM are neutered so a developer's own git config — signing,
# hooksPath, diff drivers — cannot change what these fixtures measure.
#
#   bash scripts/test-seeded-pack-changed.sh
#   SCOPE=/path/to/other.sh bash scripts/test-seeded-pack-changed.sh
#
# SCOPE exists so a neutered implementation can be run against the same fixtures
# to show what it stops catching.

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope=${SCOPE:-$repo_root/scripts/seeded-pack-changed.sh}

work_dir=$(mktemp -d -t seeded-pack-changed.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT

# Keep git hermetic: no user identity, no signing, no hooksPath, no diff config.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

# Every case must be counted, so an emptied or mis-edited case list cannot report
# green off zero assertions.
EXPECTED_CASES=32
total=0
pass=0
fail=0

check() {
  local name=$1 expected=$2 actual=$3
  total=$((total + 1))
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' \
      "$name" "$expected" "$actual" >&2
  fi
}

pack_rel='packages/operating-skills/src/pack.ts'
skills_rel='packages/operating-skills/src/skills'

# The shape of the real pack.ts in miniature: a long TSDoc block carrying a
# History list, then imports, then the constant, then the array.
write_base_pack() {
  cat >"$1/$pack_rel" <<'PACK'
/**
 * The Operating DorkOS skill pack.
 *
 * History:
 * - 1: initial pack.
 *
 * Be precise about who a bump reaches. DOR-671 tracks that gap; do not close it
 * here.
 */
import { alpha } from './skills/alpha.js';
import { beta } from './skills/beta.js';

/** One authored skill in the pack. */
export interface OperatingSkill {
  name: string;
  body: string;
}

export const OPERATING_SKILLS_VERSION = 4;

export const OPERATING_SKILLS_PACK: readonly OperatingSkill[] = [alpha, beta];

// Content whose own lines start with `---`, so the `removed-dashes-line` case
// below has something to delete. See that case for what it pins.
export const DOC_EXAMPLE = `
---
title: example
---
`;

// Two real code lines that CONTAIN a comment token without being comments. The
// rule is anchored to the start of the line; a filter that merely looks for
// these tokens anywhere drops both and waves the edits through silently.
export const DOCS_URL = 'https://docs.dorkos.ai/skills';
export const RETRY_BUDGET = 3 * 2;
PACK
}

write_base_skill() {
  cat >"$1/$skills_rel/alpha.ts" <<'SKILL'
/** The alpha skill. */
export const alpha = {
  name: 'alpha',
  body: `
# Alpha

Run \`dorkos call\` to reach a tool.
`,
};
SKILL
}

# Build a repo whose first commit is the fork point, apply a mutation, commit it,
# and print "<repo> <fork_point_sha>".
#
#   make_case <name> [--allow-empty] <<'MUTATE'
#   ...bash operating on $repo...
#   MUTATE
#
# Returns 42 when the mutation changed nothing. That matters because the mutations
# are `perl` substitutions run with their output swallowed: when an anchor stops
# matching — say `write_base_pack` is reflowed — perl exits 0 having done nothing,
# and the case commits empty. Every `unchanged`-expecting case then passes for the
# wrong reason, and the suite reports 16/16 while testing nothing. Measured: a
# simulated reflow left the suite green with `comment-only` reduced to an exact
# duplicate of `nothing-touched`. The `changed`-expecting cases are self-
# protecting (a no-op flips them to `unchanged`), so only the other direction
# needed this. `--allow-empty` opts out, for the one case whose whole point is an
# empty commit.
make_case() {
  local name=$1
  local allow_empty=false
  [ "${2:-}" = '--allow-empty' ] && allow_empty=true
  local repo=$work_dir/$name
  mkdir -p "$repo/$skills_rel"
  (
    cd "$repo" || exit 1
    git init -q -b main .
    write_base_pack "$repo"
    write_base_skill "$repo"
    printf 'export const seed = 1;\n' >"packages/operating-skills/src/seed.ts"
    git add -A
    git commit -qm 'base'
  ) >/dev/null 2>&1 || {
    printf 'could not build fixture repo %s\n' "$name" >&2
    return 1
  }
  local fork_point
  fork_point=$(git -C "$repo" rev-parse HEAD)

  # The mutation script arrives on stdin so each case reads as a small patch.
  local mutate
  mutate=$(cat)
  (
    cd "$repo" || exit 1
    eval "$mutate"
    git add -A
    if [ "$allow_empty" != true ] && git diff --cached --quiet; then
      exit 42
    fi
    git commit -qm 'change' --allow-empty
  ) >/dev/null 2>&1
  local rc=$?
  case $rc in
    0) ;;
    42) return 42 ;;
    *)
      printf 'could not apply fixture mutation for %s\n' "$name" >&2
      return 1
      ;;
  esac

  printf '%s %s' "$repo" "$fork_point"
}

# Run the scope script inside a fixture repo and report its verdict, or
# `error(<status>)` when it refused to answer.
verdict() {
  local repo=$1 fork_point=$2 out status
  out=$(cd "$repo" && bash "$scope" "$fork_point" 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'error(%s)' "$status"
  else
    printf '%s' "$out"
  fi
  [ -n "${VERBOSE:-}" ] && {
    printf '\n--- %s ---\n' "$repo" >&2
    (cd "$repo" && bash "$scope" "$fork_point" >/dev/null) 2>&1 >/dev/null | sed 's/^/  /' >&2
  }
  return 0
}

run_case() {
  local name=$1 expected=$2 allow_empty=${3:-}
  local built repo fork_point rc
  if [ -n "$allow_empty" ]; then
    built=$(make_case "$name" "$allow_empty")
  else
    built=$(make_case "$name")
  fi
  rc=$?
  case $rc in
    0) ;;
    42)
      check "$name" "$expected" 'mutation-changed-nothing'
      return 0
      ;;
    *)
      check "$name" "$expected" 'fixture-build-failed'
      return 0
      ;;
  esac
  repo=${built%% *}
  fork_point=${built##* }
  check "$name" "$expected" "$(verdict "$repo" "$fork_point")"
}

# --- Comment-only edits to pack.ts owe no bump -------------------------------

# The DOR-671 case itself: the paragraph claiming the re-seed gap was still open
# is rewritten by the very PR that closes it. Nothing seeded moves.
run_case comment-only unchanged <<'MUTATE'
perl -0pi -e "s/ \* Be precise about who a bump reaches\. DOR-671 tracks that gap; do not close it\n \* here\.\n/ * Be precise about who a bump reaches. The server now re-seeds at boot, so a\n * bump reaches every registered agent under the agents directory.\n/" packages/operating-skills/src/pack.ts
MUTATE

run_case comment-added unchanged <<'MUTATE'
perl -0pi -e "s|export const OPERATING_SKILLS_VERSION|// A trailing note about the constant below.\nexport const OPERATING_SKILLS_VERSION|" packages/operating-skills/src/pack.ts
MUTATE

# A TRULY empty line removed. Note this is not the same as a blank line inside
# the TSDoc block, which is ` *` and is already covered by the comment pattern —
# the case that needs its own rule is the bare one between declarations, which
# renders as a bare `-` diff line and matches no comment pattern at all. Decided
# deliberately: a blank line carries no seeded text, so a change made only of
# them cannot move the constant or the pack array, and reflowing a docblock
# routinely takes the empty line after `*/` with it.
run_case blank-line-only unchanged <<'MUTATE'
perl -0pi -e "s|import \{ beta \} from './skills/beta.js';\n\n|import { beta } from './skills/beta.js';\n|" packages/operating-skills/src/pack.ts
MUTATE

# Editing anything else in the package is not seeded text either. This is the
# workflow header's own claim about seed.ts, the tests and the README.
run_case sibling-file-only unchanged <<'MUTATE'
printf 'export const seed = 2;\n' > packages/operating-skills/src/seed.ts
MUTATE

run_case nothing-touched unchanged --allow-empty <<'MUTATE'
:
MUTATE

# --- Real pack.ts edits owe a bump -------------------------------------------

run_case version-changed changed <<'MUTATE'
perl -pi -e "s/OPERATING_SKILLS_VERSION = 4;/OPERATING_SKILLS_VERSION = 5;/" packages/operating-skills/src/pack.ts
MUTATE

run_case import-changed changed <<'MUTATE'
perl -pi -e "s|import \{ beta \} from './skills/beta.js';|import { gamma } from './skills/gamma.js';|" packages/operating-skills/src/pack.ts
MUTATE

run_case pack-array-changed changed <<'MUTATE'
perl -pi -e "s/\[alpha, beta\]/[alpha, beta, gamma]/" packages/operating-skills/src/pack.ts
MUTATE

# A real code line whose content CONTAINS `//`. Pins the anchoring of the comment
# rule: broadening it to `^[<>].*(\*|//)` — matching those tokens anywhere on the
# line rather than at the start — swallows this edit and every other line holding
# a URL. Measured: that mutation left the suite 16/16 green before this case.
run_case code-line-with-url changed <<'MUTATE'
perl -pi -e "s|docs\.dorkos\.ai/skills|docs.dorkos.ai/pack|" packages/operating-skills/src/pack.ts
MUTATE

# The same, for a line containing `*` as an operator rather than as a TSDoc
# gutter. Both tokens are needed: the broadened pattern above covers either.
run_case code-line-with-asterisk changed <<'MUTATE'
perl -pi -e "s/3 \* 2/3 * 4/" packages/operating-skills/src/pack.ts
MUTATE

# A comment edit riding along with a real one must not launder the real one.
run_case comment-plus-code changed <<'MUTATE'
perl -0pi -e "s/ \* - 1: initial pack\./ * - 1: initial pack, reworded./" packages/operating-skills/src/pack.ts
perl -pi -e "s/OPERATING_SKILLS_VERSION = 4;/OPERATING_SKILLS_VERSION = 5;/" packages/operating-skills/src/pack.ts
MUTATE

# A DELETED line whose own content starts with `--` renders as `----`, which is
# indistinguishable from a `--- a/path` file header by prefix alone. Pins the
# `--output-indicator-old` spelling: the obvious `grep -vE '^(\+\+\+|---)'`
# spelling drops this line as a header and reports `unchanged`, waving a real
# pack edit through. Deletion-only on purpose — any added line would survive the
# naive filter too and the case would stop discriminating.
run_case removed-dashes-line changed <<'MUTATE'
perl -0pi -e "s/title: example\n---\n/title: example\n/" packages/operating-skills/src/pack.ts
MUTATE

# --- The skills directory stays byte-granular --------------------------------

run_case skill-body-changed changed <<'MUTATE'
perl -pi -e "s/^# Alpha$/# Alpha, revised/" packages/operating-skills/src/skills/alpha.ts
MUTATE

# A comment inside a skill file IS seeded text as far as this guard is concerned:
# the bodies are prose written for a model, and `seed.ts` hashes them verbatim.
# The pack.ts relaxation must not leak across to this side.
run_case skill-comment-changed changed <<'MUTATE'
perl -pi -e "s|/\*\* The alpha skill\. \*/|/** The alpha skill, which teaches tool calls. */|" packages/operating-skills/src/skills/alpha.ts
MUTATE

# --- The DOR-509 shape, and refusing to guess --------------------------------

# The failure the whole guard exists for: fork from a base at 4, bump to 5, while
# the base moves to 5 underneath. The scope decision must still say `changed`, or
# the version comparison never runs and the collision ships green.
run_case dor-509-parallel-bump changed <<'MUTATE'
perl -pi -e "s/OPERATING_SKILLS_VERSION = 4;/OPERATING_SKILLS_VERSION = 5;/" packages/operating-skills/src/pack.ts
perl -0pi -e "s/ \* - 1: initial pack\.\n/ * - 1: initial pack.\n * - 5: a correction that must reach existing agents.\n/" packages/operating-skills/src/pack.ts
MUTATE

# --- Nothing to match must never read as nothing changed ---------------------
#
# The shape shared by the four cases below: a pathspec, a ref or a diff that
# yields no lines is not evidence that no lines moved. Each of these reported a
# clean `unchanged` before the guards that now sit in front of them.

# A repo carrying a REAL pack edit, reused by the cases that need one.
real_built=$(make_case real-edit <<'MUTATE'
perl -pi -e "s/OPERATING_SKILLS_VERSION = 4;/OPERATING_SKILLS_VERSION = 5;/" packages/operating-skills/src/pack.ts
MUTATE
) || real_built=''
real_repo=${real_built%% *}
real_fork=${real_built##* }

# Both paths are repo-root-relative and git resolves a pathspec against the CWD,
# so running from a subdirectory used to scope this guard onto nothing and answer
# `unchanged` for a version bump. CI is safe only because `run:` defaults to
# $GITHUB_WORKSPACE; one `working-directory:` key would have opened it silently.
if [ -n "$real_built" ]; then
  check 'a real edit is still seen when run from a subdirectory' 'changed' \
    "$(cd "$real_repo/packages" && bash "$scope" "$real_fork" 2>/dev/null ||
      printf 'error(%s)' $?)"
else
  check 'a real edit is still seen when run from a subdirectory' 'changed' 'fixture-build-failed'
fi

# A pathspec matching nothing produces an empty diff, byte-identical to "nothing
# changed". One typo in the workflow `env:` would disable the guard on every pull
# request forever. The coupling checks below prove the two sides AGREE on the
# strings; only this proves either points at something real.
if [ -n "$real_built" ]; then
  check 'a pathspec that resolves to nothing is refused' 'error(2)' \
    "$(cd "$real_repo" && PACK_FILE=nope.ts SKILLS_DIR=nope bash "$scope" "$real_fork" >/dev/null 2>&1 &&
      printf 'unchanged' || printf 'error(%s)' $?)"
else
  check 'a pathspec that resolves to nothing is refused' 'error(2)' 'fixture-build-failed'
fi

# A diff git does not render as a line stream yields zero `<`/`>` lines, which is
# the same shape as a fully-filtered comment diff. A real 4-to-5 bump in a file
# marked `-diff` therefore read as clean. `--numstat` is what tells the two apart.
binary_built=$(make_case binary-diff <<'MUTATE'
perl -pi -e "s/OPERATING_SKILLS_VERSION = 4;/OPERATING_SKILLS_VERSION = 5;/" packages/operating-skills/src/pack.ts
printf 'packages/operating-skills/src/pack.ts -diff\n' > .gitattributes
MUTATE
) || binary_built=''
if [ -n "$binary_built" ]; then
  check 'a diff git renders as binary is refused, never read as clean' 'error(2)' \
    "$(verdict "${binary_built%% *}" "${binary_built##* }")"
else
  check 'a diff git renders as binary is refused, never read as clean' 'error(2)' \
    'fixture-build-failed'
fi

# The whitelist on the rule above. A mode-only change genuinely moves zero lines,
# so it must stay a clean `unchanged` rather than joining the binary case — a
# guard that refuses a chmod would be switched off within a week.
mode_built=$(make_case mode-only-change <<'MUTATE'
chmod +x packages/operating-skills/src/pack.ts
MUTATE
) || mode_built=''
if [ -n "$mode_built" ]; then
  check 'a mode-only change stays a clean unchanged' 'unchanged' \
    "$(verdict "${mode_built%% *}" "${mode_built##* }")"
else
  check 'a mode-only change stays a clean unchanged' 'unchanged' 'fixture-build-failed'
fi

# An unresolvable ref must refuse loudly. Reporting `unchanged` here would switch
# the required check off without anything going red.
bad_built=$(make_case bad-ref --allow-empty <<'MUTATE'
:
MUTATE
) || bad_built=''
if [ -n "$bad_built" ]; then
  bad_repo=${bad_built%% *}
  check 'an unresolvable fork point is refused, never read as unchanged' 'error(2)' \
    "$(verdict "$bad_repo" 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')"
else
  check 'an unresolvable fork point is refused, never read as unchanged' 'error(2)' \
    'fixture-build-failed'
fi

# --- The workflow's own missing-script fallback (DOR-835) --------------------
#
# `operating-skills-version-check.yml`'s "Decide whether the seeded pack
# content changed" step calls this script directly. On `pull_request`, GitHub
# reads that YAML from a synthetic merge of base into head, so it always
# reflects the CURRENT workflow — but `actions/checkout` pins the WORKING TREE
# to the PR head, so a branch cut before this script existed checks out a tree
# that lacks it, and the unconditional call used to exit 127 for a reason that
# has nothing to do with the PR (live on PR #607 and #609). The fix falls back
# to `git show <base_tip>:scripts/seeded-pack-changed.sh` when the head's own
# copy is missing.
#
# That fallback is duplicated here rather than centralized into a shared repo
# script on purpose: a helper script would have EXACTLY the same staleness
# problem on exactly the branches this exists to fix, so it has to be inline
# bash in the workflow step, and the closest this suite can get to testing the
# genuine article is reproducing that inline logic byte-for-byte.
resolve_and_run() {
  local repo=$1 base_tip=$2 fork_point=$3 out status
  out=$(
    cd "$repo" || exit 1
    script=./scripts/seeded-pack-changed.sh
    if [ ! -f "$script" ]; then
      script=$(mktemp)
      git show "$base_tip:scripts/seeded-pack-changed.sh" >"$script" 2>/dev/null || exit 2
      chmod +x "$script"
    fi
    "$script" "$fork_point"
  ) 2>/dev/null
  status=$?
  if [ "$status" -ne 0 ]; then
    printf 'error(%s)' "$status"
  else
    printf '%s' "$out"
  fi
}

# A repo whose fork point (like every case above) never carried the script —
# standing in for a branch cut before it existed — that then makes a real pack
# edit. `base_tip` is a SEPARATE commit, off in its own branch of the same
# fixture repo, carrying a real copy of this repo's actual script: exactly the
# "base branch has since gained the script" shape the fallback exists for.
missing_script_built=$(make_case missing-script-fallback <<'MUTATE'
perl -pi -e "s/OPERATING_SKILLS_VERSION = 4;/OPERATING_SKILLS_VERSION = 5;/" packages/operating-skills/src/pack.ts
MUTATE
) || missing_script_built=''
if [ -n "$missing_script_built" ]; then
  fallback_repo=${missing_script_built%% *}
  fallback_fork=${missing_script_built##* }
  (
    cd "$fallback_repo" || exit 1
    git checkout -q -b main-tip "$fallback_fork"
    mkdir -p scripts
    cp "$repo_root/scripts/seeded-pack-changed.sh" scripts/seeded-pack-changed.sh
    chmod +x scripts/seeded-pack-changed.sh
    git add -A
    git commit -qm 'main has since gained the script'
    git checkout -q main
  ) >/dev/null 2>&1
  fallback_base_tip=$(cd "$fallback_repo" && git rev-parse main-tip 2>/dev/null)

  # The working tree really does lack the file — this is not asserting a
  # premise, it is the premise the fallback exists to handle.
  if [ -e "$fallback_repo/scripts/seeded-pack-changed.sh" ]; then
    check 'precondition: the head tree has no script of its own' 'absent' 'present'
  else
    check 'precondition: the head tree has no script of its own' 'absent' 'absent'
  fi

  check 'a branch predating the script falls back to the base tip copy' 'changed' \
    "$(resolve_and_run "$fallback_repo" "$fallback_base_tip" "$fallback_fork")"

  # Without the fallback — the exact call the workflow made before DOR-835 —
  # the same fixture just 127s, which is the bug this whole case exists to
  # prove is fixed. Manually confirmed the case above fails the same way when
  # `resolve_and_run`'s fallback branch is deleted (i.e. it "reddens" without
  # the fix); kept as a live assertion here too so a regression cannot go
  # unnoticed silently.
  check 'the naive call this replaces really did 127' 'error(127)' \
    "$(cd "$fallback_repo" && ./scripts/seeded-pack-changed.sh "$fallback_fork" 2>/dev/null; printf 'error(%s)' $?)"
else
  check 'precondition: the head tree has no script of its own' 'absent' 'fixture-build-failed'
  check 'a branch predating the script falls back to the base tip copy' 'changed' 'fixture-build-failed'
  check 'the naive call this replaces really did 127' 'error(127)' 'fixture-build-failed'
fi

# --- The script and the workflow must agree on which paths matter ------------
#
# In CI the two paths come from the workflow's job `env:`; in these fixtures they
# come from the script's own defaults. Drift between them is invisible from
# either side alone: the suite would keep passing against the defaults while the
# job scoped on something else. Read from the REAL script even when SCOPE points
# elsewhere — this pins a coupling, not a behaviour.
workflow=$repo_root/.github/workflows/operating-skills-version-check.yml
real_scope=$repo_root/scripts/seeded-pack-changed.sh

script_default() {
  sed -nE "s/^$1=\\\$\{$2:-(.*)\}$/\1/p" "$real_scope"
}
workflow_env() {
  sed -nE "s/^[[:space:]]+$1:[[:space:]]+(.*)$/\1/p" "$workflow"
}

check 'the script default PACK_FILE matches the workflow env' \
  "$(workflow_env PACK_FILE)" "$(script_default pack_file PACK_FILE)"
check 'the script default SKILLS_DIR matches the workflow env' \
  "$(workflow_env SKILLS_DIR)" "$(script_default skills_dir SKILLS_DIR)"

# The equality above is vacuously true when BOTH extractors stop matching, since
# '' equals ''. One refactor moving the paths out of job `env:` into script
# arguments would do it, and the coupling check would assert nothing forever
# while staying green. Single-sided drift is already caught by the two above.
for extracted in \
  "workflow PACK_FILE:$(workflow_env PACK_FILE)" \
  "workflow SKILLS_DIR:$(workflow_env SKILLS_DIR)" \
  "script pack_file:$(script_default pack_file PACK_FILE)" \
  "script skills_dir:$(script_default skills_dir SKILLS_DIR)"; do
  check "${extracted%%:*} is still extractable" 'found' \
    "$([ -n "${extracted#*:}" ] && printf 'found' || printf 'extracted-nothing')"
done

# --- The workflow still contains the missing-script fallback (DOR-835) ------
#
# `resolve_and_run` above is a hand-duplicated mirror of the workflow's inline
# bash — it has to be duplicated rather than centralized (see its own comment
# for why). Nothing else keeps the two in sync: if someone simplified the
# workflow step back to a bare `./scripts/seeded-pack-changed.sh ...` call, the
# fixtures above would keep exercising the MIRROR and stay green while the real
# fallback was gone, the same "tested the wrong thing" gap
# scripts/assert-tests-executed.sh exists to close for a cached "29
# successful". Pin that the workflow's own text still contains the fallback,
# not just that a hand-copy of its logic works.
for marker in \
  'if [ ! -f "$script" ]; then' \
  'git show "$base_tip:scripts/seeded-pack-changed.sh"' \
  'chmod +x "$script"'; do
  check "workflow step still contains: $marker" 'found' \
    "$(grep -qF "$marker" "$workflow" && printf 'found' || printf 'missing')"
done

# -----------------------------------------------------------------------------

if [ "$total" -ne "$EXPECTED_CASES" ]; then
  printf 'FAIL  ran %s case(s) but this suite declares %s.\n' "$total" "$EXPECTED_CASES" >&2
  printf '      A suite that stops emitting cases still exits 0 on the counters\n' >&2
  printf '      alone, so the count is asserted rather than trusted.\n' >&2
  fail=$((fail + 1))
fi

printf '\nseeded-pack-changed fixtures: %s passed, %s failed (%s cases)\n' \
  "$pass" "$fail" "$total"
[ "$fail" -eq 0 ]
