#!/usr/bin/env bash
# The merge queue's door for the arm rule (DOR-4648). On every queue entry,
# whoever queued it, .github/workflows/arm-door.yml builds a payload about the
# pull request's head and this script decides:
#
#   1. The gates, which decide whether the entry stays. It is taken back out
#      when its head is missing what matters:
#        - Security's `security-reviewed` label, added at or after the head
#          (the newest label event is not older than the later of the head's
#          committer date and when this PR last got it: its latest
#          `typecheck.yml` `pull_request` run on the PR's own branch, from this
#          repo. The pusher sets the committer date, and a commit's check
#          suites belong to the SHA repo-wide, so a backdated, side-branch or
#          returning commit could make an old label look fresh, DOR-4706). The same rule
#          the release range check and the arm script apply to every pull
#          request, docs included (#3913 was client-only and still blocked a
#          release). If docs are ever exempted, the checks change in one PR.
#        - a verify proof: the arm script's `arm-record` stamp names one (a
#          local `pnpm verify` pass, a PM waiver, docs-only or green CI, all of
#          which only the arm script can see), or this script finds one itself:
#          docs-only (every changed file, by both names on a rename, under
#          contributing/ or docs/ or ending .md), or green CI (every required
#          check and all six `test-shard (k/6)` jobs passed as GitHub Actions
#          check runs at the head, never for a PR touching .github/, where a
#          workflow the PR adds could post such a run).
#        - QA's `qa-real-data` label, added after the head (the same head time
#          as above), when the PR touches config or migration code, writes the
#          connector upgrade ledger, has a file GitHub sent no patch for, or
#          carries that label at all. scripts/qa-real-data.sh decides, the
#          file the arm script reads from main, so the two can't drift apart (DOR-4904:
#          #4096 went in without the arm script and merged without it).
#      So a careful merge by a person from the GitHub page goes through: the
#      gates decide, not the tool.
#   2. The arm script, which only gets a comment. An entry whose gates are met
#      but whose head has no `success` `arm-record` stamp went in some other way
#      (#3913, #3934 on 2026-11-17 and 11-18), and the author is told once.
#
# It never jams the queue on its own errors: anything it cannot read keeps the
# entry and says so. A stamp is not a signature (every agent acts as one
# login); per-role GitHub Apps are the real fix (DOR-3183).
#
# Usage:
#   scripts/arm-door.sh verdict <payload.json>
#       payload: {head, headCommittedAt, headSeenAt (the head's latest
#       typecheck pull_request run on the PR's branch, or null), labelEvents: [security-reviewed
#       label times], statuses: [head commit statuses], checkRuns: [head check
#       runs], required: [required contexts], files: [{filename,
#       previous_filename}], changedFiles, labels: [current label names],
#       qaLabelEvents: [qa-real-data label times], patches: per-file patch text
#       built with `qa-real-data.sh patches-jq`}. Prints one line:
#         PULL <reason>[,<reason>]          take it out (no-security-label,
#                                           security-label-older-than-head, no-proof,
#                                           no-qa-label, qa-label-older-than-head)
#         KEEP gates-met proof=<p> stamp=<yes|no>
#         KEEP unreadable <field>           could not decide (exit 2)
#   scripts/arm-door.sh comment <pull|unarmed|unreadable> <pr> <head-sha> <detail>
#       prints the note left on the pull request; once per head and kind

set -uo pipefail

usage() {
  echo "usage: $0 verdict <payload.json> | comment <pull|unarmed|unreadable> <pr> <head-sha> <detail>" >&2
  exit 2
}

cmd=${1:-}
shift || :

case "$cmd" in
  verdict)
    src=${1:-}
    [[ -n "$src" ]] || usage
    if ! jq -e 'type == "object"' "$src" >/dev/null 2>&1; then
      echo "KEEP unreadable payload"
      exit 2
    fi
    # Anything missing or the wrong shape: keep, and say which.
    missing=$(jq -r '
      [ (if (.head | type) == "string" and (.head | test("^[0-9a-f]{40}$")) then empty else "head" end),
        (if (.headCommittedAt | type) == "string" and .headCommittedAt != "" then empty else "headCommittedAt" end),
        (if (.labelEvents | type) == "array" then empty else "labelEvents" end),
        (if (.statuses | type) == "array" then empty else "statuses" end),
        (if (.checkRuns | type) == "array" then empty else "checkRuns" end),
        (if (.required | type) == "array" and (.required | length) > 0 then empty else "required" end),
        (if (.files | type) == "array" and (.changedFiles | type) == "number"
              and (.files | length) == .changedFiles and .changedFiles > 0 then empty else "files" end)
      ] | first // ""' "$src" 2>/dev/null) || { echo "KEEP unreadable payload"; exit 2; }
    if [[ -n "$missing" ]]; then
      echo "KEEP unreadable $missing"
      exit 2
    fi
    # Gate 3: QA's real-data label, decided by scripts/qa-real-data.sh, the same file the arm
    # script runs, so the path rule and the label-time rule can't drift apart (DOR-4904). Its
    # inputs are the arm script's: current label names, the PR's file names, per-file patches.
    # A QA input it cannot read is a soft unknown, like an unknown seen time: the other gates
    # still pull, and only if they pass is the entry kept as unreadable.
    qabad=$(jq -r '
      [ (if (.labels | type) == "array" then empty else "labels" end),
        (if (.qaLabelEvents | type) == "array" then empty else "qaLabelEvents" end),
        (if (.patches | type) == "string" then empty else "patches" end)
      ] | first // "" | if . == "" then "" else "unreadable:\(.)" end' "$src" 2>/dev/null) || qabad=unreadable:payload
    if [[ -z "$qabad" ]]; then
      qtmp=$(mktemp -d) || { echo "KEEP unreadable payload"; exit 2; }
      trap 'rm -rf "$qtmp"' EXIT
      if jq -r '.labels[] | strings' "$src" > "$qtmp/labels" \
          && jq -r '.files[].filename | strings' "$src" > "$qtmp/files" \
          && jq -j '.patches' "$src" > "$qtmp/patches"; then
        qrc=0
        bash "$(dirname "$0")/qa-real-data.sh" needs "$qtmp/labels" "$qtmp/files" "$qtmp/patches" >/dev/null 2>&1 || qrc=$?
      else
        qrc=2
      fi
      case "$qrc" in
        1) ;;
        0)
          # The head time gate 1 uses: the later of the committer date and when this PR got it.
          # `|`, not a tab: read folds runs of a whitespace separator, so an empty field would shift.
          if IFS='|' read -r qhead qseen qlabel < <(jq -r '
              ((.headSeenAt | strings | select(. != "")) // null) as $seen
              | [([.headCommittedAt, $seen] | map(select(. != null)) | max),
                 ($seen // ""),
                 (if any(.labels[]; . == "qa-real-data") then ([.qaLabelEvents[] | strings] | max // "") else "" end)]
              | join("|")' "$src" 2>/dev/null); then
            if bash "$(dirname "$0")/qa-real-data.sh" fresh "$qhead" "$qlabel" >/dev/null 2>&1; then
              # Newer than the committer date, but GitHub's own time is unknown: can't judge.
              [[ -n "$qseen" ]] || qabad=unreadable:headSeenAt
            elif [[ -z "$qlabel" ]]; then
              qabad=no-qa-label
            else
              qabad=qa-label-older-than-head
            fi
          else
            qabad=unreadable:payload
          fi
          ;;
        *) qabad=unreadable:qa-real-data ;;
      esac
    fi
    jq -r --arg qabad "$qabad" '
      def isdoc: ((test("^/") or test("(^|/)\\.\\.(/|$)")) | not)
                 and (test("^(contributing|docs)/") or test("\\.md$"));
      .head as $h
      | ([.files[] | .filename, (.previous_filename // empty)]) as $names
      # Gate 1: the newest security-reviewed label event at or after the head,
      # timed by the later of its committer date and when this PR got it. With no
      # seen time, a label older than the committer date is still stale; a newer
      # one cannot be judged, so the entry is kept as unreadable (DOR-4706).
      | ((.headSeenAt | strings | select(. != "")) // null) as $seen
      | ([.headCommittedAt, $seen] | map(select(. != null)) | max) as $headtime
      | ([.labelEvents[] | strings] | max) as $label
      | (if $label == null then "no-security-label"
         elif $label < $headtime then "security-label-older-than-head"
         elif $seen == null then "unreadable-seen"
         else null end) as $labelbad
      # The arm script stamp: the newest arm-record, by time then id.
      | ([.statuses[] | select(type == "object" and .context == "arm-record")]
         | sort_by(.created_at // "", .id // 0) | last) as $stamp
      | ($stamp != null and $stamp.state == "success") as $stamped
      | (if $stamped then (($stamp.description // "") | capture("proof=(?<p>[a-z-]+)").p // null) else null end) as $stampproof
      # Gate 2: a verify proof.
      | ($names | all(isdoc)) as $docs
      | ($names | any(test("^\\.github/"))) as $gh
      | ([.checkRuns[] | select(type == "object" and .app.slug == "github-actions" and .head_sha == $h)]
         | group_by(.name) | map(max_by(.id)) | map({key: .name, value: .}) | from_entries) as $runs
      | ([.checkRuns[] | select(type == "object" and .head_sha != $h)] | length) as $foreign
      | def ok($n; $skip): ($runs[$n] // null) as $r
          | $r != null and $r.status == "completed"
            and ($r.conclusion == "success" or ($skip and $r.conclusion == "skipped"));
        (($gh | not) and $foreign == 0
         and (.required | all(. as $c | ok($c; $c == "no-fragment-under-skip-label")))
         and ([range(1; 7) | "test-shard (\(.)/6)"] | all(ok(.; false)))) as $ci
      | (if $stampproof != null and ($stampproof | IN("local-verify", "waiver", "docs-only", "ci-green")) then $stampproof
         elif $docs then "docs-only"
         elif $ci then "ci-green"
         else null end) as $proof
      | ([(if $labelbad == "unreadable-seen" then null else $labelbad end),
          (if $proof == null then "no-proof" else null end),
          (if $qabad == "" or ($qabad | startswith("unreadable:")) then null else $qabad end)]
         | map(select(. != null))) as $bad
      | if ($bad | length) > 0 then "PULL \($bad | join(","))"
        elif $labelbad == "unreadable-seen" then "KEEP unreadable headSeenAt"
        elif ($qabad | startswith("unreadable:")) then "KEEP unreadable \($qabad | ltrimstr("unreadable:"))"
        else "KEEP gates-met proof=\($proof) stamp=\(if $stamped then "yes" else "no" end)" end
    ' "$src" 2>/dev/null || { echo "KEEP unreadable payload"; exit 2; }
    ;;

  comment)
    kind=${1:-} pr=${2:-} head=${3:-} detail=${4:-}
    [[ -n "$kind" && -n "$pr" && -n "$head" && -n "$detail" ]] || usage
    case "$kind" in
      pull)
        echo "**Taken out of the merge queue.** This commit (\`${head:0:7}\`) is missing a check it needs before it can merge:"
        echo
        case ",$detail," in *",no-security-label,"*) echo "- Security's \`security-reviewed\` label was never added." ;; esac
        case ",$detail," in *",security-label-older-than-head,"*) echo "- Security's \`security-reviewed\` label is older than this commit. Security labels each new commit." ;; esac
        case ",$detail," in *",no-proof,"*) echo "- No verify proof: no local \`pnpm verify\` pass or PM waiver recorded by the arm script, and the required checks and all six test shards are not green here (or the PR changes \`.github/\`)." ;; esac
        case ",$detail," in *",no-qa-label,"*) echo "- It needs QA's real-data upgrade check (config or migration code, the connector upgrade ledger, a file too big to read, or the label itself), and QA's \`qa-real-data\` label is not on it. QA runs the check at this commit first." ;; esac
        case ",$detail," in *",qa-label-older-than-head,"*) echo "- QA's \`qa-real-data\` label is older than this commit. QA re-runs the real-data upgrade check at each new commit." ;; esac
        echo
        echo "**What to do:** get the missing check at this commit, then arm it through the arm script."
        ;;
      unarmed)
        echo "**Queued without the arm script.** This commit (\`${head:0:7}\`) has what it needs to merge ($detail), so it stays in the queue. But it went in some other way, so the arm script's other checks (the designer's sign-off among them) were not run."
        echo
        echo "**Next time:** agents arm only through the arm script, never \`gh pr merge\`."
        ;;
      unreadable)
        echo "**Could not check this queue entry.** The arm door could not read \`$detail\` for this commit (\`${head:0:7}\`), so it left it in the queue. The required checks still run."
        ;;
      *) usage ;;
    esac
    echo
    echo "<!-- arm-door $kind head=$head -->"
    ;;

  *) usage ;;
esac
