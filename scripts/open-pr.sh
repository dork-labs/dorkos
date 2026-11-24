#!/usr/bin/env bash
# open-pr.sh — the one supported way to open a pull request in this repo.
#
#   scripts/open-pr.sh --title "<type>(<scope>): <summary>" --body-file <file>
#                      [--draft] [--hold "<reason>"] [--extra-label <label>]...
#                      [--p0 "<reason>"] [--dry-run]
#
# WHY THIS IS CODE AND NOT PROSE
#
# PRs used to be opened with a raw `gh pr create`, following the
# creating-pull-requests skill plus whatever a coordinator brief said. The two
# drifted: on 2026-11-20 a brief told agents to open security-path PRs with
# `hold`, while the arming script refuses `hold` and never lifts it, and 19 PRs
# sat for 9 hours with nobody knowing why they were held. The rules now live
# here, once, pinned by scripts/test-open-pr.sh, and a raw `gh pr create` is
# refused in Claude Code by .claude/hooks/pr-create-guard.mjs.
#
# WHAT IT DOES, IN ORDER
#   1. The open-PR cap (.agents/skills/creating-pull-requests/scripts/
#      open-pr-cap.sh). Its refusal is this script's refusal. `--p0` passes
#      through to it.
#   2. Labels, computed from the branch's diff against origin/main
#      (merge-base..HEAD, renames counted by both names):
#      - `review:deep` when a security path is touched, else `review:light`.
#        The security list is the one security-gate.yml carries
#        (SECURITY_PATH_PATTERN and SECURITY_DEEP_PATH_PATTERN, matched with
#        the gate's own case and Unicode folding, through
#        .github/scripts/security-gate.mjs), plus the three extras the
#        coordinator's interim checker adds (EXTRA_SECURITY_RE below).
#      - `skip-changelog` when the diff adds no changelog fragment and every
#        file is builder-only: docs, CI and harness, tests, or the CI ledger
#        (NON_USER_FACING_RE). The skill's label race applies: the `opened`
#        run of fragment-present can miss a label, so a skip-changelog PR
#        whose commits are typed feat/fix/refactor/perf is REFUSED until they
#        are retyped chore(/ci(/docs(/test(, which passes with or without the
#        label.
#      - `needs-design` when a user-visible UI path is touched outside tests
#        (UI_RE and UI_SKIP_RE, the design gate's own lists).
#   3. The provenance line (AGENTS.md "Signing outward writes"): a version 2
#      line from scripts/provenance/provenance-line.ts, appended unless the
#      body's last non-blank line is already one. A field it cannot read is left out and named; a CLI
#      that cannot run leaves a minimal line and a warning, never a refusal.
#   4. `gh pr create` with every label at creation, so the `opened` event and
#      the review see them. With `--hold`, `hold` is one of them and the reason
#      is posted straight after as a one-line comment, `hold: <reason>`, which
#      the hold-reason workflow looks for. Without `--hold` the PR never gets
#      `hold`, from here or from `--extra-label`.
#   5. Auto-merge (DOR-5107, under DOR-5098): `gh pr merge --auto`, so the PR
#      merges as soon as every required check is green, with nobody arming it.
#      Only when it is safe, decided here in code:
#        - not a draft (open a draft when you only want CI feedback), and not
#          opened with `--hold`;
#        - main's ci/required-checks.json (read from $OPEN_PR_BASE, never the
#          branch's copy) already requires `not-held`, `release-window` and
#          `pr-gates`. Those make a hold, a freeze or release, and a missing
#          Security sign-off block the merge by themselves (QA and design are
#          notes, not gates). Until
#          the ruleset requires them, the PR opens without auto-merge, exactly
#          as before, so this switches itself on when they become required.
#      The strategy flag is left off: the merge queue owns it.
#   Then it prints the PR URL, the head SHA, the labels GitHub reports, the
#   provenance line it appended, and whether auto-merge is on.
#
# `--extra-label` adds any other label, but never `hold` or another hold label
# (`do-not-merge`, `wip`, `blocked`), never a gate label someone else owns
# (`security-*`, `design-ok`, `qa-*`, `needs-qa-gate`), never `review:light`
# (the intensity is computed; `review:deep` may raise it) and never a comma
# (gh splits `--label a,b` into two labels).
#
# `--dry-run` runs no `gh` command at all, not even the cap's read: it prints
# the labels and the exact commands it would run.
#
# Environment: GH (the gh binary, for fixtures), OPEN_PR_CAP (the cap script),
# OPEN_PR_BASE (default origin/main), OPEN_PR_REMOTE (default origin),
# OPEN_PR_TSX (the tsx binary that runs the provenance CLI, default the repo's
# node_modules/.bin/tsx).
#
# Exit codes: 0 opened (or dry run); 1 refused by a rule or the cap; 2 usage;
# 3 a gh call failed (the PR may exist: read the message).
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$DIR/.." && pwd)
GH=${GH:-gh}
CAP=${OPEN_PR_CAP:-$REPO_ROOT/.agents/skills/creating-pull-requests/scripts/open-pr-cap.sh}
BASE=${OPEN_PR_BASE:-origin/main}
REMOTE=${OPEN_PR_REMOTE:-origin}
SECURITY_GATE_MJS=$REPO_ROOT/.github/scripts/security-gate.mjs

# From .temp/coord/security-paths-check.sh, the interim arm gate, which adds
# these to the workflow's list (nested drizzle/ migrations, marketplace-mcp/
# anywhere, and runtimes/shared/awareness/, whose text goes into agents' turns).
# That checker lives outside git; this copy is the reviewed one.
EXTRA_SECURITY_RE='(^|/)drizzle/|(^|/)marketplace-mcp/|^apps/server/src/services/runtimes/shared/awareness/'

# From .temp/coord/design-gate.sh (PM, 2026-11-13): screens and visuals a
# person sees, minus tests, snapshots and the Dev Playground.
UI_RE='^(apps/client/src/|apps/site/src/|apps/site/app/|apps/site/components/|apps/desktop/src/renderer/|packages/ui/src/|packages/icons/)'
UI_SKIP_RE='(/__tests__/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|/__snapshots__/|^apps/client/src/dev/)'

# Builder-only files (changelog/README.md: "a change only a DorkOS builder
# notices (harness, CI, tests, contributor docs, internal refactors) takes the
# skip-changelog label"). Docs, CI and harness, tests, and the CI ledger.
NON_USER_FACING_RE='^(contributing|docs|research|specs|plans|decisions|audits|ci|scripts|\.github|\.claude|\.agents|packages/ci-steward|apps/e2e)/|^[^/]+\.md$|^(lefthook\.yml|turbo\.json|knip\.config\.ts|vitest\.config\.ts|eslint\.config\.js)$|(^|/)(__tests__|__snapshots__)/|\.(test|spec)\.[cm]?[jt]sx?$'
FRAGMENT_RE='^changelog/unreleased/'
# changelog_backfill.py's user-facing commit types (PREFIX_SECTION_MAP).
USER_FACING_COMMIT_RE='^(feat|fix|refactor|perf)(\([^)]*\))?!?:'
HOLD_LABELS_RE='^(hold|do-not-merge|do not merge|wip|blocked)$'
GATE_LABELS_RE='^(security-.*|design-ok|qa-.*|needs-qa-gate)$'

usage() {
  sed -n '3,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() { # $1 exit code, rest: message
  local code=$1
  shift
  echo "open-pr: $*" >&2
  exit "$code"
}

title=""
body_file=""
draft=0
hold_given=0
hold_reason=""
p0_given=0
p0=""
dry_run=0
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --title | --body-file | --hold | --extra-label | --p0)
      [ $# -ge 2 ] || die 2 "$1 needs a value"
      case "$1" in
        --title) title=$2 ;;
        --body-file) body_file=$2 ;;
        --hold) hold_given=1 hold_reason=$2 ;;
        --extra-label) extra+=("$2") ;;
        --p0) p0_given=1 p0=$2 ;;
      esac
      shift 2
      ;;
    --draft) draft=1 && shift ;;
    --dry-run) dry_run=1 && shift ;;
    -h | --help) usage ;;
    *) die 2 "unknown argument: $1 (see the header of scripts/open-pr.sh)" ;;
  esac
done

[ -n "${title//[[:space:]]/}" ] || die 2 "--title is required"
[ -n "$body_file" ] || die 2 "--body-file is required"
[ -f "$body_file" ] && [ -r "$body_file" ] || die 2 "cannot read --body-file $body_file"
if [ "$hold_given" = 1 ]; then
  case "$hold_reason" in *$'\n'* | *$'\r'*) die 2 "--hold takes a one-line reason" ;; esac
  hold_reason=$(printf '%s' "$hold_reason" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$hold_reason" ] || die 2 "--hold needs a reason: a hold with no reason deadlocks the PR, because nobody knows who lifts it"
fi

for label in ${extra[@]+"${extra[@]}"}; do
  [ -n "${label//[[:space:]]/}" ] || die 2 "--extra-label needs a label name"
  case "$label" in *,*) die 1 "--extra-label '$label' has a comma; gh would split it into several labels. Pass each one on its own." ;; esac
  if grep -qiE "$HOLD_LABELS_RE" <<<"$label"; then
    die 1 "--extra-label '$label' is a hold label. Use --hold \"<reason>\": a hold needs a reason posted with it."
  fi
  if grep -qiE "$GATE_LABELS_RE" <<<"$label"; then
    die 1 "--extra-label '$label' is a gate label its owner adds after their own review (Security, the designer, QA). Ask them; never add it yourself."
  fi
  [ "$label" != "review:light" ] || die 1 "--extra-label review:light: review intensity is computed from the diff; pass review:deep to raise it, never lower it"
done

# --- 1. The open-PR cap. -----------------------------------------------------
cap_args=()
[ "$p0_given" = 1 ] && cap_args+=(--p0 "$p0")
if [ "$dry_run" = 1 ]; then
  echo "would run: $(printf '%q ' "$CAP" ${cap_args[@]+"${cap_args[@]}"})"
else
  cap_rc=0
  "$CAP" ${cap_args[@]+"${cap_args[@]}"} || cap_rc=$?
  case "$cap_rc" in
    0) ;;
    1) die 1 "the open-PR cap refused (above). Keep building locally and open it when one lands." ;;
    *) die 1 "the open-PR cap could not decide (exit $cap_rc), so nothing was opened" ;;
  esac
fi

# --- 2. Labels from the diff. -----------------------------------------------
branch=$(git symbolic-ref --quiet --short HEAD) || die 2 "HEAD is detached; check out the branch to open"
case "$branch" in main | master) die 2 "you are on $branch; open a PR from a topic branch" ;; esac
head_sha=$(git rev-parse HEAD)
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || die 2 "$BASE is not a commit here; git fetch origin main first"
merge_base=$(git merge-base "$BASE" HEAD) || die 2 "no merge base between $BASE and HEAD"
files=$(git diff --no-renames --name-only "$merge_base" HEAD) || die 2 "could not diff $merge_base..HEAD"
[ -n "$files" ] || die 2 "the branch changes nothing against $BASE"
subjects=$(git log --format=%s "$merge_base..HEAD") || die 2 "could not read the branch's commits"

security=$(printf '%s\n' "$files" | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [gate, extra] = process.argv.slice(1);
  const { securityPathPattern, securityDeepPathPattern, touchesSecurity } = await import(gate);
  const files = readFileSync(0, "utf8").split("\n").filter(Boolean).map((filename) => ({ filename }));
  const hits = files.filter((f) =>
    [securityPathPattern(), securityDeepPathPattern(), extra].some((p) => touchesSecurity([f], p))
  );
  for (const f of hits) console.log(f.filename);
' "file://$SECURITY_GATE_MJS" "$EXTRA_SECURITY_RE") || die 1 "could not classify security paths (node and $SECURITY_GATE_MJS are needed); nothing was opened"

labels=()
if [ -n "$security" ]; then
  labels+=("review:deep")
  why_review="security path: $(head -1 <<<"$security")"
else
  labels+=("review:light")
  why_review="no security path"
fi
for label in ${extra[@]+"${extra[@]}"}; do
  if [ "$label" = "review:deep" ]; then
    labels[0]="review:deep"
    why_review="$why_review; raised by --extra-label"
  fi
done

fragments=$(grep -E "$FRAGMENT_RE" <<<"$files" || true)
user_facing_files=$(grep -vE "$NON_USER_FACING_RE" <<<"$files" | grep -vE "$FRAGMENT_RE" || true)
want_skip=0
for label in ${extra[@]+"${extra[@]}"}; do [ "$label" = "skip-changelog" ] && want_skip=1; done
if [ -z "$fragments" ] && [ -z "$user_facing_files" ]; then
  want_skip=1
fi
if [ "$want_skip" = 1 ]; then
  [ -z "$fragments" ] || die 1 "skip-changelog says no user-facing change, but the branch adds $(head -1 <<<"$fragments"); drop the label or the fragment (no-fragment-under-skip-label would fail)"
  typed=$(grep -E "$USER_FACING_COMMIT_RE" <<<"$subjects" || true)
  if [ -n "$typed" ]; then
    {
      echo "open-pr: this PR takes skip-changelog, but a commit is typed as user-facing:"
      printf '  %s\n' "$typed"
      echo "The label can lose a race with the opened run of fragment-present, and a re-run cannot fix it."
      echo "Not user-facing: reword the commit to chore(, ci(, docs( or test( (git commit --amend, then"
      echo "git push --force-with-lease). User-facing after all: add a changelog fragment."
    } >&2
    exit 1
  fi
fi
ui=$(grep -E "$UI_RE" <<<"$files" | grep -vE "$UI_SKIP_RE" || true)

add_label() { # dedupe
  local l
  for l in "${labels[@]}"; do [ "$l" = "$1" ] && return 0; done
  labels+=("$1")
}
[ "$want_skip" = 1 ] && add_label skip-changelog
[ -n "$ui" ] && add_label needs-design
[ "$hold_given" = 1 ] && add_label hold
for label in ${extra[@]+"${extra[@]}"}; do add_label "$label"; done

if [ "$want_skip" = 0 ] && [ -z "$fragments" ] && grep -qE "$USER_FACING_COMMIT_RE" <<<"$subjects"; then
  echo "open-pr: warning: user-facing files and feat/fix commits, but no changelog fragment; fragment-present will fail" >&2
fi

# --- 3. The provenance line. ------------------------------------------------
# Version 2, built by scripts/provenance/provenance-line.ts through
# @dorkos/shared/provenance, the one place its rules live. dork-labs/dorkos is
# public, so the chat is cut to 8 characters and host and turn never go in.
# The CLI derives the surface (dorkos, ci or bare-cli: where the work was
# driven from). A field the environment does not name is left out, and the
# note names it.
#
# Signing never stops a PR from opening. When the CLI cannot run (no
# node_modules, no node, a crash, or output that is not one signature line),
# the body gets PROVENANCE_MINIMAL instead, and the note and a warning say why.
#
# A body counts as signed only when its LAST non-blank line is a signature,
# the rule every reader uses (readProvenance): a line quoted mid-body or in a
# fence signs nothing, so such a body still gets one.
PROVENANCE_CLI=$REPO_ROOT/scripts/provenance/provenance-line.ts
# Without the CLI nothing is known, not even the surface.
PROVENANCE_MINIMAL='<!-- agent:provenance {"v":2} -->'
SIGNATURE_RE='^[[:space:]]*<!--[[:space:]]*(agent|flow):provenance[[:space:]]+\{.*\}[[:space:]]*-->[[:space:]]*$'
# tsx: OPEN_PR_TSX when set; else this checkout's, then the main checkout's,
# since a fresh worktree often has no install of its own.
if [ -n "${OPEN_PR_TSX:-}" ]; then
  tsx_tried=("$OPEN_PR_TSX")
else
  tsx_tried=("$REPO_ROOT/node_modules/.bin/tsx")
  if common_dir=$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    main_tsx=$(dirname "$common_dir")/node_modules/.bin/tsx
    [ "$main_tsx" = "${tsx_tried[0]}" ] || [ "$main_tsx" -ef "${tsx_tried[0]}" ] || tsx_tried+=("$main_tsx")
  fi
fi
TSX=""
for candidate in "${tsx_tried[@]}"; do
  if [ -x "$candidate" ]; then
    TSX=$candidate
    break
  fi
done
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
body="$tmp/body.md"
cat "$body_file" >"$body"
last_line=$(tr -d '\r' <"$body" | awk 'NF { l = $0 } END { print l }')
if grep -qE "$SIGNATURE_RE" <<<"$last_line"; then
  provenance_note="already in the body"
else
  cli_failed=""
  cli_rc=0
  line=""
  if [ -n "$TSX" ]; then
    line=$("$TSX" "$PROVENANCE_CLI" --visibility public 2>"$tmp/provenance.err") || cli_rc=$?
  fi
  if [ -z "$TSX" ]; then
    cli_failed="tsx is not installed (looked in $(printf '%s, ' "${tsx_tried[@]}" | sed 's/, $//')); run pnpm install"
  elif [ "$cli_rc" -ne 0 ]; then
    # The error, not the stack: the first line naming one, else the last line.
    reason=$(grep -m1 'Error' "$tmp/provenance.err" || awk 'NF { l = $0 } END { print l }' "$tmp/provenance.err")
    cli_failed="it exited $cli_rc: $(cut -c1-200 <<<"$reason")"
  elif [[ $line == *$'\n'* ]] || ! grep -qxE '<!-- agent:provenance \{.*\} -->' <<<"$line"; then
    cli_failed="it printed no signature line"
  fi
  if [ -n "$cli_failed" ]; then
    line=$PROVENANCE_MINIMAL
    provenance_note="appended the minimal line, because the provenance CLI could not sign ($cli_failed): $line"
    echo "open-pr: warning: $provenance_note" >&2
  else
    json=${line#<!-- agent:provenance }
    omitted=$(jq -r '["harness", "account", "agent", "chat", "space"] - keys | join(", ")' <<<"${json% -->}" 2>/dev/null) ||
      omitted="unknown (jq could not read the line)"
    provenance_note="appended: $line"
    [ -z "$omitted" ] || provenance_note="$provenance_note (omitted: $omitted)"
  fi
  [ -n "$(tail -c1 "$body")" ] && echo >>"$body"
  printf '\n%s\n' "$line" >>"$body"
fi

# --- 4. Open it. ------------------------------------------------------------
create=("$GH" pr create --base main --head "$branch" --title "$title" --body-file "$body")
[ "$draft" = 1 ] && create+=(--draft)
for label in "${labels[@]}"; do create+=(--label "$label"); done

# --- 5. Auto-merge, decided before anything is opened. -----------------------
AUTO_MERGE_GATES=(not-held release-window pr-gates)
auto_merge=0
if [ "$draft" = 1 ]; then
  auto_why="off: a draft (whoever marks it ready turns it on: gh pr merge --auto <n>)"
elif [ "$hold_given" = 1 ]; then
  auto_why="off: opened with --hold (whoever lifts the hold turns it on: gh pr merge --auto <n>)"
elif ! required_json=$(git show "$BASE:ci/required-checks.json" 2>/dev/null); then
  auto_why="off: $BASE has no ci/required-checks.json"
else
  absent=""
  for gate in "${AUTO_MERGE_GATES[@]}"; do
    jq -e --arg g "$gate" '.contexts | index($g)' >/dev/null 2>&1 <<<"$required_json" || absent="$absent $gate"
  done
  if [ -n "$absent" ]; then
    auto_why="off: main does not require$absent yet, so a hold, freeze or missing sign-off would not stop a merge"
  else
    auto_merge=1
    auto_why="on: merges when every required check is green"
  fi
fi

joined=$(IFS=,; echo "${labels[*]}")
if [ "$dry_run" = 1 ]; then
  echo "labels: $joined"
  echo "  review: $why_review"
  [ "$want_skip" = 1 ] && echo "  skip-changelog: no fragment, and every file is docs, CI, tests or the ledger"
  [ -n "$ui" ] && echo "  needs-design: $(head -1 <<<"$ui")"
  echo "provenance: $provenance_note"
  echo "head: $head_sha ($branch)"
  echo "would run: $(printf '%q ' "${create[@]}")"
  [ "$hold_given" = 1 ] && echo "would run: $(printf '%q ' "$GH" pr comment "<new PR>" --body "hold: $hold_reason")"
  echo "auto-merge: $auto_why"
  [ "$auto_merge" = 1 ] && echo "would run: $(printf '%q ' "$GH" pr merge "<new PR>" --auto)"
  exit 0
fi

# Open only a branch that is pushed at exactly this head: the review converged
# on the pushed commit, and gh must not push or prompt on our behalf.
remote_sha=$(git ls-remote --heads "$REMOTE" "refs/heads/$branch" | cut -f1) || die 2 "could not read $REMOTE"
[ "$remote_sha" = "$head_sha" ] || die 1 "$REMOTE/$branch is ${remote_sha:-missing}, not HEAD $head_sha; push the branch first"

url=$("${create[@]}") || die 3 "gh pr create failed; nothing was opened (check gh pr list --head $branch before retrying)"
url=$(tail -1 <<<"$url")
[ -n "$url" ] || die 3 "gh pr create printed no URL; check gh pr list --head $branch"

if [ "$hold_given" = 1 ]; then
  "$GH" pr comment "$url" --body "hold: $hold_reason" >/dev/null \
    || die 3 "opened $url with hold, but could not post its reason. Post it now: gh pr comment $url --body \"hold: $hold_reason\""
fi

view=$("$GH" pr view "$url" --json headRefOid,labels) || die 3 "opened $url, but could not read it back"
gh_head=$(jq -r '.headRefOid' <<<"$view")
gh_labels=$(jq -r '[.labels[].name] | join(",")' <<<"$view")
echo "url: $url"
echo "head: $gh_head"
echo "labels: $gh_labels"
echo "provenance: $provenance_note"
missing=""
for label in "${labels[@]}"; do
  case ",$gh_labels," in *",$label,"*) ;; *) missing="$missing $label" ;; esac
done
[ -z "$missing" ] || die 3 "opened $url, but GitHub does not show:$missing (does the label exist?)"
[ "$gh_head" = "$head_sha" ] || die 3 "opened $url at $gh_head, not the local HEAD $head_sha"

if [ "$auto_merge" = 1 ]; then
  "$GH" pr merge "$url" --auto >/dev/null ||
    die 3 "opened $url, but could not turn on auto-merge. Ask a maintainer to turn it on; never merge it directly"
fi
echo "auto-merge: $auto_why"
