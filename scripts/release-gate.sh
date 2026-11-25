#!/usr/bin/env bash
# release-gate.sh — may release vX.Y.Z, cut from main commit P, go to npm now?
#
#   scripts/release-gate.sh decide <facts.json>
#   scripts/release-gate.sh facts <version> <P-sha>
#
# DOR-5123 (daily release, design §5 `gate`). The decision the Release Publish
# workflow's `gate` job makes right before npm, with nobody clicking approve.
# It re-proves, at publish time, what made P worth releasing:
#
#   1. P is on main's first-parent history, nothing on main since has reverted
#      it, and no auto-revert PR is open for it;
#   2. P's own full run is green: the newest completed run of each full-run
#      workflow (FULL_RUN_WORKFLOWS, default browser-test.yml) on P, from a
#      `push` or `schedule` on main (FULL_RUN_EVENTS), concluded success;
#   3. P came through the merge queue green: every context in main's
#      ci/required-checks.json has a GitHub Actions check run on P from a
#      gh-readonly-queue/main/* build, and its latest attempt passed (success,
#      or skipped as GitHub's queue counts it). A squash queue merge lands the
#      queue's own commit on main, so those runs sit on P's SHA.
#
# What it does NOT re-check, because proof.ts (job `prove`) and release-cli.ts
# (job `prepare`) already prove it: the tip equals expected_sha, the branch was
# cut at P (merge-base with main), and P..tip holds only the release commit
# (version files, changelog, API version) and clean cherry-picks of main.
#
# `decide` prints exactly one line, `SHIP` or `REFUSE <reason>`, and exits 0.
# The caller ships only on the exact line `SHIP`.
# facts.json: {version, p, mainHead, unreadable[], compare{status, ahead_by,
#   behind_by, commits[{sha, parents[], message}]}, pSubject, pr, revertPrOpen,
#   fullRuns{workflows[], events[], runs[]}, required[], checkRuns[], suites[]}
# `facts` builds it from read-only GitHub reads (GH overrides the binary; REPO
# defaults to $GITHUB_REPOSITORY, then dork-labs/dorkos). A read that fails is
# listed in `unreadable`, and `decide` refuses on it.
#
# Exit codes: 0 a decision (or facts) was printed; 2 usage or unreadable input.
# Fixtures: scripts/test-release-gate.sh.
set -uo pipefail

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
FULL_RUN_WORKFLOWS=${FULL_RUN_WORKFLOWS:-browser-test.yml test.yml}
FULL_RUN_EVENTS=${FULL_RUN_EVENTS:-push schedule}
# The GitHub Actions app. Only its check runs count, never statuses.
ACTIONS_APP_ID=15368

usage() {
  sed -n '4,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
err() {
  echo "release-gate: $*" >&2
  exit 2
}

decide() {
  local f=$1
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || err "unreadable facts: $f"
  jq -r --argjson app "$ACTIONS_APP_ID" '
    def sha: type == "string" and test("^[0-9a-f]{40}$");
    def passing: . == "success" or . == "skipped";
    def refuse(r): "REFUSE " + r;
    . as $f
    | ($f.p // "") as $p
    | (($f.compare.commits // []) | map({key: .sha, value: (.parents[0] // "")}) | from_entries) as $parent
    | (if ($f.pr // 0) > 0 then "#\($f.pr)([^0-9]|$)" else null end) as $prRef
    | [($f.compare.commits // [])[]
        | select(
            (.message | contains($p) and test("revert"; "i"))
            or ((.message | split("\n")[0] | test("^revert"; "i"))
                and (($prRef != null and (.message | test($prRef)))
                     or (($f.pSubject // "") != "" and (.message | contains("\"" + $f.pSubject + "\""))))))
        | .sha] as $reverts
    # 2: the newest completed run of each full-run workflow on P.
    | [($f.fullRuns.workflows // [])[] as $w
        | [($f.fullRuns.runs // [])[]
            | select(.workflow == $w and .head_sha == $p and .head_branch == "main"
                     and .status == "completed"
                     and (.event as $e | ($f.fullRuns.events // []) | index($e)))]
        | sort_by(.created_at, .id) | last
        | {w: $w, run: .}] as $full
    # 3: each required context, from P own merge-queue build, latest attempt per suite.
    | ([($f.suites // [])[] | select((.head_branch // "") | startswith("gh-readonly-queue/main/")) | .id]) as $queue
    | [($f.required // [])[] as $c
        | [($f.checkRuns // [])[]
            | select(.name == $c and .app_id == $app and (.suite as $s | $queue | index($s)))]
        | group_by(.suite) | map(sort_by(.id) | last)
        | {c: $c, runs: .}] as $req
    | if ($f.version // "" | test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$") | not) then refuse("bad version")
      elif ($p | sha | not) then refuse("bad P sha")
      elif ($f.unreadable // ["facts"] | length) > 0 then refuse("unreadable: " + ($f.unreadable // ["facts"] | join(", ")))
      elif ($f.mainHead | sha | not) then refuse("unreadable: main head")
      # 1. On main, first parent, not reverted.
      elif (["ahead", "identical"] | index($f.compare.status)) == null or $f.compare.behind_by != 0 then
        refuse("P \($p[0:12]) is not on main (compare says \($f.compare.status))")
      elif ($f.compare.commits | length) != $f.compare.ahead_by then
        refuse("main history read incomplete (\($f.compare.commits | length) of \($f.compare.ahead_by) commits)")
      elif ($f.mainHead != $p and ([$f.mainHead | recurse($parent[.] // empty)] | index($p)) == null) then
        refuse("P \($p[0:12]) is not on main first-parent history")
      elif ($reverts | length) > 0 then
        refuse("P \($p[0:12])\(if ($f.pr // 0) > 0 then " (#\($f.pr))" else "" end) was reverted on main by \($reverts[0][0:12])")
      elif $f.revertPrOpen != false then refuse("an auto-revert PR is open for P \($p[0:12])")
      # 2. P own full run.
      elif ($full | length) == 0 then refuse("no full-run workflow configured")
      elif ($full | map(select(.run == null)) | length) > 0 then
        ($full | map(select(.run == null)) | first) as $m
        | refuse("no completed full \($m.w) run on P \($p[0:12]) from \(($f.fullRuns.events // []) | join("/")) on main")
      elif ($full | map(select(.run.conclusion != "success")) | length) > 0 then
        ($full | map(select(.run.conclusion != "success")) | first) as $m
        | refuse("the newest full \($m.w) run on P (\($m.run.id)) concluded \($m.run.conclusion)")
      # 3. Required checks from the merge queue.
      elif ($req | length) == 0 then refuse("main required-checks list is empty")
      elif ($req | map(select(.runs | length == 0)) | length) > 0 then
        refuse("required check \($req | map(select(.runs | length == 0)) | first | .c) has no merge-queue run on P \($p[0:12])")
      elif ($req | map(select(.runs | any(.conclusion | passing | not))) | length) > 0 then
        ($req | map(select(.runs | any(.conclusion | passing | not))) | first) as $m
        | refuse("required check \($m.c) on P merge-queue build is \($m.runs | map(.conclusion // .status // "pending") | map(select(passing | not)) | first)")
      else "SHIP"
      end' "$f" || err "could not decide"
}

# paged <path> <jq>: every page of a list whose pages give {total, items}, as one
# JSON array; fails unless the items add up to the total.
paged() {
  local raw try
  for try in 1 2 3; do
    raw=$("$GH" api --paginate "$1" --jq "$2") &&
      jq -cs 'if length > 0 and (map(.items | length) | add) == .[0].total
        and (map(.items) | add | map(.id) | unique | length) == .[0].total
        then map(.items) | add else error("short") end' <<<"$raw" 2>/dev/null && return 0
    [ "$try" -lt 3 ] && sleep "${RELEASE_GATE_RETRY_SLEEP:-5}"
  done
  return 1
}

facts() {
  local version=$1 p=$2 unreadable=() raw
  local head='null' compare='null' subject='' pr=0 open='null' required='null' runs='[]' checks='null' suites='null'
  # mark <what>: note a failed read.
  mark() { unreadable+=("$1"); }

  if raw=$("$GH" api "repos/$REPO/commits/main" --jq .sha) && [[ "$raw" =~ ^[0-9a-f]{40}$ ]]; then
    head="\"$raw\""
  else mark 'main head'; fi

  if [ "$head" != null ]; then
    # Oldest first, every page: P..main with each commit's parents and message.
    if raw=$("$GH" api --paginate "repos/$REPO/compare/$p...$(jq -r . <<<"$head")?per_page=100" \
      --jq '{status, ahead_by, behind_by, commits: [.commits[] | {sha, parents: [.parents[].sha], message: .commit.message}]}') &&
      compare=$(jq -cs 'if length == 0 then error("empty") else {status: .[0].status, ahead_by: .[0].ahead_by,
        behind_by: .[0].behind_by, commits: (map(.commits) | add)} end' <<<"$raw" 2>/dev/null); then :
    else compare='null'; mark 'main history'; fi
    if raw=$("$GH" api "repos/$REPO/contents/ci/required-checks.json?ref=$(jq -r . <<<"$head")" \
      --jq '.content | gsub("\n"; "") | @base64d | fromjson | .contexts') &&
      jq -e 'type == "array" and length > 0 and all(type == "string")' <<<"$raw" >/dev/null 2>&1; then
      required=$(jq -c . <<<"$raw")
    else mark 'required checks'; fi
  fi

  if raw=$("$GH" api "repos/$REPO/commits/$p" --jq '.commit.message | split("\n")[0]'); then
    subject=$raw
  else mark 'P commit'; fi
  if raw=$("$GH" api "repos/$REPO/commits/$p/pulls" --jq '[.[] | select(.merged_at != null)] | first | .number // 0') &&
    [[ "$raw" =~ ^[0-9]+$ ]]; then
    pr=$raw
  else mark 'P pull request'; fi
  if raw=$("$GH" api "repos/$REPO/pulls?state=open&head=${REPO%%/*}:auto-revert/${p:0:12}" --jq 'length > 0') &&
    [[ "$raw" =~ ^(true|false)$ ]]; then
    open=$raw
  else mark 'open auto-revert PRs'; fi

  local w wfs
  read -ra wfs <<<"$FULL_RUN_WORKFLOWS"
  for w in ${wfs[@]+"${wfs[@]}"}; do
    if raw=$("$GH" api "repos/$REPO/actions/workflows/$w/runs?head_sha=$p&per_page=100" \
      --jq '{total: .total_count, runs: [.workflow_runs[] | {id, event, status, conclusion, head_sha, head_branch, created_at, path}]}') &&
      jq -e '(.runs | length) == .total' <<<"$raw" >/dev/null 2>&1; then
      runs=$(jq -c --argjson acc "$runs" --arg w "$w" '$acc + [.runs[] | . + {workflow: $w}]' <<<"$raw")
    else mark "$w runs"; fi
  done

  # Latest attempt of every GitHub Actions check run on P, and the build (suite)
  # that made each. Suites keep appearing on main commits (workflow_run), so a
  # count that moved between pages is read again, up to three times.
  if checks=$(paged "repos/$REPO/commits/$p/check-runs?app_id=$ACTIONS_APP_ID&filter=latest&per_page=100" \
    '{total: .total_count, items: [.check_runs[] | {id, name, status, conclusion, app_id: .app.id, suite: .check_suite.id}]}'); then :
  else checks='null'; mark 'check runs'; fi
  if suites=$(paged "repos/$REPO/commits/$p/check-suites?app_id=$ACTIONS_APP_ID&per_page=100" \
    '{total: .total_count, items: [.check_suites[] | {id, head_branch, app_id: .app.id}]}'); then :
  else suites='null'; mark 'check suites'; fi

  local events workflows list
  read -ra list <<<"$FULL_RUN_EVENTS"
  events=$(jq -cn '$ARGS.positional' --args ${list[@]+"${list[@]}"})
  workflows=$(jq -cn '$ARGS.positional' --args ${wfs[@]+"${wfs[@]}"})
  jq -n --arg version "$version" --arg p "$p" --argjson head "$head" --argjson compare "$compare" \
    --arg subject "$subject" --argjson pr "$pr" --argjson open "$open" --argjson required "$required" \
    --argjson runs "$runs" --argjson checks "$checks" --argjson suites "$suites" --argjson events "$events" \
    --argjson workflows "$workflows" --args '{version: $version, p: $p, mainHead: $head,
      unreadable: $ARGS.positional, compare: $compare, pSubject: $subject, pr: $pr, revertPrOpen: $open,
      fullRuns: {workflows: $workflows, events: $events, runs: $runs},
      required: $required, checkRuns: $checks, suites: $suites}' ${unreadable[@]+"${unreadable[@]}"}
}

case "${1:-}" in
  decide) [ $# -eq 2 ] || usage; decide "$2" ;;
  facts)
    [ $# -eq 3 ] && [[ "$2" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] && [[ "$3" =~ ^[0-9a-f]{40}$ ]] || usage
    facts "$2" "$3"
    ;;
  *) usage ;;
esac
