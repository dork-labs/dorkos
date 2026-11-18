#!/usr/bin/env bash
# The merge queue's door for the arm rule (DOR-4648). On every queue entry,
# whoever queued it, .github/workflows/arm-door.yml builds a payload about the
# pull request's head and this script decides:
#
#   1. The gates, which decide whether the entry stays. It is taken back out
#      when its head is missing what matters:
#        - Security's `security-reviewed` label, added at or after the head
#          commit (the newest label event is not older than the head's committer
#          date). The same rule the release range check applies to every pull
#          request, docs included (#3913 was client-only and still blocked a
#          release). If docs are ever exempted, both checks change in one PR.
#        - a verify proof: the arm script's `arm-record` stamp names one (a
#          local `pnpm verify` pass, a PM waiver, docs-only or green CI, all of
#          which only the arm script can see), or this script finds one itself:
#          docs-only (every changed file, by both names on a rename, under
#          contributing/ or docs/ or ending .md), or green CI (every required
#          check and all six `test-shard (k/6)` jobs passed as GitHub Actions
#          check runs at the head, never for a PR touching .github/, where a
#          workflow the PR adds could post such a run).
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
#       payload: {head, headCommittedAt, labelEvents: [security-reviewed
#       label times], statuses: [head commit statuses], checkRuns: [head check
#       runs], required: [required contexts], files: [{filename,
#       previous_filename}], changedFiles}. Prints one line:
#         PULL <reason>[,<reason>]          take it out (no-security-label,
#                                           security-label-older-than-head, no-proof)
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
    jq -r '
      def isdoc: ((test("^/") or test("(^|/)\\.\\.(/|$)")) | not)
                 and (test("^(contributing|docs)/") or test("\\.md$"));
      .head as $h
      | ([.files[] | .filename, (.previous_filename // empty)]) as $names
      # Gate 1: the newest security-reviewed label event at or after the head commit.
      | ([.labelEvents[] | strings] | max) as $label
      | (if $label == null then "no-security-label"
         elif $label < .headCommittedAt then "security-label-older-than-head"
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
      | ([$labelbad, (if $proof == null then "no-proof" else null end)] | map(select(. != null))) as $bad
      | if ($bad | length) > 0 then "PULL \($bad | join(","))"
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
        echo
        echo "**What to do:** get the missing check at this commit, then arm it through the arm script."
        ;;
      unarmed)
        echo "**Queued without the arm script.** This commit (\`${head:0:7}\`) has what it needs to merge ($detail), so it stays in the queue. But it went in some other way, so the arm script's other checks (QA's and the designer's sign-offs) were not run."
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
