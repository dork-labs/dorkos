#!/usr/bin/env bash
# hold-reason-check.sh — a `hold` label must come with a categorized reason.
#
#   scripts/hold-reason-check.sh <pr-number>
#   scripts/hold-reason-check.sh --reason "<category>: <detail>"
#
# Passes when the PR has no `hold` label, or when its newest comment starting
# `hold:`, or the last line starting `hold:` in its body, gives a reason this
# script accepts. Fails otherwise, naming the fix. The body counts because the
# workflow re-runs on a body edit but not on a comment (a comment's run reports
# against main), so editing the body is how a fixed reason turns the PR green.
# Either one is enough, so a stale body line keeps passing: delete it when the
# hold comes off. Lines inside a fenced code block or an HTML comment in the
# body never count, so a body that shows the format is not a reason.
# Run by .github/workflows/hold-reason.yml, an advisory check (never required).
# `--reason` judges one reason (the text after `hold:`) without reading GitHub;
# scripts/open-pr.sh calls it so `--hold` and this check share one rule.
#
# A REASON IS `<category>: <detail>`, and the category is one of:
#   migration-collision   another PR adds a migration with the same index
#   stacked               this PR sits on another one that must land first
#   external-dependency   it waits on something outside every gate
#   other                 anything else, said in the detail
# The detail must say something, and it must not name only a gate.
#
# WHY. merge-tail and the arm script both refuse a held PR, and neither lifts
# `hold`: only whoever set it can. A hold with no reason names nobody, so
# nobody lifts it. On 2026-11-20 a brief told agents to open security-path PRs
# with `hold` and 19 PRs sat for 9 hours. On Nov 22, 9 of 12 open PRs were held
# and 4 of those reasons named only a gate (Security, design, the release lead,
# verify) that arm.sh, the verify-proof check and the release pin already
# enforce. A hold like that only adds a person to wake (DOR-4974), so it fails
# here. scripts/open-pr.sh posts the reason itself (`--hold "<category>: <detail>"`); this
# check covers every other way a hold goes on, including Codex and OpenCode
# agents, which run no Claude hooks.
#
# "Names only a gate" is a word test, and deliberately a loose one: the detail
# is split into words (on spaces, punctuation and hyphens, so
# "security-reviewed" is two words), and it fails when nothing is left after
# dropping gate words (GATE_WORDS: the gates the arm script checks: Security,
# design, QA, the verify proof, the release pin and freeze) and filler
# (FILLER_WORDS: "waiting", "on", "the", times, days and months).
# "external-dependency: Security review" fails; "external-dependency: waits on
# #4105" passes, because "#4105" is neither. Any other word gets a reason
# through, so "other: Security review of the token change" passes: the test
# catches a reason that is only a gate, not one that hides a gate behind a
# noun. Only `hold:` comments are read, so a `hold-cleared: ...` note is not a
# reason.
#
# The reason may lag the label by a few seconds (open-pr.sh opens the PR with
# the label, then comments), so a missing or refused reason is re-read
# HOLD_REASON_TRIES times (default 3), HOLD_REASON_WAIT seconds apart (default
# 15), before it fails: a PR re-held after an old refused `hold:` comment gets
# the same wait for its new one.
#
# GRACE. Holds already on PRs when this rule landed use the old free-text form
# ("hold: waiting on Security"). Until HOLD_REASON_GRACE_UNTIL (a UTC date,
# default 2026-11-29) a refused reason on a PR is a warning with exit 0, so
# those PRs do not all turn red at once; from that date it fails. `--reason`,
# which open-pr.sh uses for new holds, never has a grace period. Delete the
# grace branch once that date passes (a DOR-4974 follow-up).
#
# Reads PR metadata only, through `gh api` (GH overrides the binary); it never
# needs the PR's code. REPO defaults to $GITHUB_REPOSITORY, then
# dork-labs/dorkos. The workflow checks out this one file, so it must stay
# self-contained.
#
# Exit codes: 0 no hold, or a hold with an accepted reason; 1 a hold with no
# reason or one not accepted (with --reason: the reason is not accepted);
# 2 usage, or GitHub could not be read.
set -euo pipefail

CATEGORIES='migration-collision stacked external-dependency other'
# Matched against single words: hyphenated names arrive split ("design-ok" is
# "design" and "ok", "@dorkos-qa" is "dorkos" and "qa").
GATE_WORDS=' security auditor deputy sec design designer qa real data verify verified verification preopen proof release lead pin freeze frozen label labels labelled labeled review reviews reviewed reviewer sign off signoff signed approval approve approved ok oks go gate gates check checks ci green arm armed arming record pm '
FILLER_WORDS=' waiting wait waits on for the a an to from until till by and or of pending needs need needed held hold holding deep light read reads re range pass passes passed lift lifts lifted who it its at head sha after before is be then with this that new exact current final first still yet s dorkos utc ct z today tomorrow tonight am mon tue wed thu fri sat sun jan feb mar apr may jun jul aug sep oct nov dec '

# judge <reason> : prints why the reason is not accepted and returns 1, or
# returns 0. <reason> is the text after `hold:`, on one line.
judge() {
  local reason category detail word kept=""
  reason=$(printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  case "$reason" in
    *:*) ;;
    *)
      echo "it names no category"
      return 1
      ;;
  esac
  category=$(printf '%s' "${reason%%:*}" | sed 's/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')
  case "$category" in
    *[[:space:]]*)
      echo "'${reason%%:*}' is not one category"
      return 1
      ;;
  esac
  detail=$(printf '%s' "${reason#*:}" | sed 's/^[[:space:]]*//')
  case " $CATEGORIES " in
    *" $category "*) ;;
    *)
      echo "'${reason%%:*}' is not a category"
      return 1
      ;;
  esac
  if [ -z "$detail" ]; then
    echo "it says nothing after '$category:'"
    return 1
  fi
  # A version ("v0.140.0") is the release pin's business, so it is dropped
  # before the split rather than kept as three words.
  for word in $(printf '%s' "$detail" | tr '[:upper:]' '[:lower:]' | sed -E 's/v?[0-9]+(\.[0-9]+)+//g' | tr -cs 'a-z0-9#' ' '); do
    # A bare "#" says nothing.
    case "$word" in *[a-z0-9]*) ;; *) continue ;; esac
    case "$GATE_WORDS$FILLER_WORDS" in *" $word "*) continue ;; esac
    # Times and days of the month ("15:00Z", "by 21"), not what it waits on.
    if printf '%s' "$word" | grep -qE '^[0-9]{1,2}(z|am|pm|st|nd|rd|th)?$'; then continue; fi
    kept="$kept $word"
  done
  if [ -z "$kept" ]; then
    echo "it names nothing but a gate the arm script already checks, or a time"
    return 1
  fi
  return 0
}

explain() { # the fix, for a person reading a failure
  cat <<'EOF'
A hold reason is "<category>: <detail>", and the category is one of:
  migration-collision, stacked, external-dependency, other.
Security, design, QA, verify, the release pin and freeze are never a reason
to hold: arm.sh already waits for them, so take the label off instead.
EOF
}

if [ "${1:-}" = --reason ]; then
  [ $# -eq 2 ] || {
    echo "usage: hold-reason-check.sh --reason \"<category>: <detail>\"" >&2
    exit 2
  }
  if why=$(judge "$2"); then
    exit 0
  fi
  {
    echo "hold reason not accepted: $why."
    explain
  } >&2
  exit 1
fi

GH=${GH:-gh}
REPO=${REPO:-${GITHUB_REPOSITORY:-dork-labs/dorkos}}
tries=${HOLD_REASON_TRIES:-3}
wait=${HOLD_REASON_WAIT:-15}
grace_until=${HOLD_REASON_GRACE_UNTIL:-2026-11-29}
pr=${1:-}
[ $# -eq 1 ] && [[ "$pr" =~ ^[1-9][0-9]*$ ]] || {
  echo "usage: hold-reason-check.sh <pr-number> | --reason \"<category>: <detail>\"" >&2
  exit 2
}
[[ "$tries" =~ ^[1-9][0-9]*$ ]] && [[ "$wait" =~ ^[0-9]+$ ]] || {
  echo "hold-reason-check: HOLD_REASON_TRIES must be a positive number and HOLD_REASON_WAIT a whole number" >&2
  exit 2
}
[[ "$grace_until" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
  echo "hold-reason-check: HOLD_REASON_GRACE_UNTIL must be a date, YYYY-MM-DD" >&2
  exit 2
}

attempt=1
while :; do
  labels=$("$GH" api "repos/$REPO/issues/$pr/labels?per_page=100" --jq '.[].name') || {
    echo "hold-reason-check: could not read the labels of #$pr" >&2
    exit 2
  }
  if ! grep -qxF hold <<<"$labels"; then
    echo "OK: #$pr has no hold label"
    exit 0
  fi
  # One JSON string per comment, so a multi-line body stays one record.
  bodies=$("$GH" api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" --jq '.[].body | tojson') || {
    echo "hold-reason-check: could not read the comments of #$pr" >&2
    exit 2
  }
  line=$(jq -r 'select(test("^\\s*hold:\\s*\\S")) | sub("^\\s+"; "") | split("\n")[0]' <<<"$bodies" | tail -1) || {
    echo "hold-reason-check: could not read the comments of #$pr" >&2
    exit 2
  }
  body=$("$GH" api "repos/$REPO/issues/$pr" --jq '.body // ""') || {
    echo "hold-reason-check: could not read the body of #$pr" >&2
    exit 2
  }
  # Drop fenced code blocks and HTML comments first: they show the format,
  # they do not state a reason.
  body_line=$(printf '%s\n' "$body" | tr -d '\r' | awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    { line = $0
      while (line != "") {
        if (comment) { i = index(line, "-->"); if (!i) { line = ""; break } line = substr(line, i + 3); comment = 0 }
        else { i = index(line, "<!--"); if (!i) break; printf "%s", substr(line, 1, i - 1); line = substr(line, i + 4); comment = 1 }
      }
      print line }' | grep -E '^[[:space:]]*hold:[[:space:]]*[^[:space:]]' | tail -1 | sed 's/^[[:space:]]*//') || true
  why=""
  refused=""
  for candidate in "$line" "$body_line"; do
    [ -n "$candidate" ] || continue
    if verdict=$(judge "${candidate#hold:}"); then
      echo "OK: #$pr is held: $candidate"
      exit 0
    fi
    # The first refused candidate (the comment, when there is one) is reported.
    [ -n "$why" ] || { why=$verdict; refused=$candidate; }
  done
  [ "$attempt" -lt "$tries" ] || break
  attempt=$((attempt + 1))
  sleep "$wait"
done

refresh="A comment does not re-run this check on the PR; editing the PR body does. Put the
reason on its own line in the body, starting \"hold:\", to turn it green."
if [ -n "$why" ]; then
  if [[ "$(date -u +%Y-%m-%d)" < "$grace_until" ]]; then
    {
      echo "WARN: #$pr is held with a reason that will fail from $grace_until: $why."
      echo "  $refused"
      explain
    } >&2
    # Shown on the run's summary page, where a green check would hide stderr.
    [ -z "${GITHUB_ACTIONS:-}" ] \
      || echo "::warning title=hold-reason::#$pr is held with a reason that will fail from $grace_until: $why"
    echo "OK (grace until $grace_until): #$pr is held: $refused"
    exit 0
  fi
  {
    echo "FAIL: #$pr is held with a reason that is not accepted: $why."
    echo "  $refused"
    explain
    echo "Whoever added it: give a new \"hold: <category>: <detail, and who lifts it>\", or take the label off."
    echo "$refresh"
  } >&2
  exit 1
fi
cat >&2 <<EOF
FAIL: #$pr has the hold label and no comment or body line starting "hold:".
A hold with no reason names nobody to lift it, so the PR waits forever.
Whoever added it: write "hold: <category>: <detail, and who lifts it>", or take the label off.
Opening a PR on hold: scripts/open-pr.sh --hold "<category>: <detail>" does both at once.
$refresh
EOF
explain >&2
exit 1
