#!/usr/bin/env bash
# open-pr-work-links.sh — step 6 of scripts/open-pr.sh (DOR-5264): tell this
# computer's DorkOS that the chat running this shell opened the pull request,
# and works on the tickets its body names, so the work graph records an
# `opened` link and a `works_on` link for each.
#
#   scripts/open-pr-work-links.sh <pr-url> <body-file>
#   scripts/open-pr-work-links.sh --dry-run <body-file>
#
# It never stops a PR: it always exits 0 and prints one `work-graph:` line,
# which says what was recorded, or that nothing was and why.
#
# WHO IS ASKING. The call names no chat. The server reads the chat off the
# identity token DorkOS gave this chat's process (DORKOS_AGENT_TOKEN), and
# refuses unless that chat is mid-turn. A shell with no token (outside
# DorkOS, or an OpenCode or Doe chat, which get none yet: DOR-5278) records
# nothing.
#
# HOW IT REACHES THE SERVER. Through `dorkos call work-graph.record-pr`, which
# reads the token from its environment, never from its arguments, and dials
# the turn's own server (DORKOS_API_URL, loopback only). The input goes on
# stdin. With no `dorkos` on PATH it falls back to curl, with the token in a
# config read from stdin (`--config -`), so `ps` never shows it.
#
# WHICH TICKETS. Only ones it is sure of, because a link is never removed:
#   - a Linear issue link (https://linear.app/<team>/issue/DOR-1234);
#   - a key on a line that starts Refs, Closes, Fixes or Resolves;
#   - a bare key whose prefix this repo declares (TICKET_PREFIXES).
# HTML comments (the provenance line) and fenced code are skipped, and so is
# every other ticket-shaped word: COVID-19 and HTTP-2 are never tickets here.
#
# Environment: OPEN_PR_DORKOS (the dorkos CLI; default `dorkos` on PATH, and
# an empty value means none), OPEN_PR_CURL (default curl), DORKOS_AGENT_TOKEN,
# DORKOS_API_URL, DORKOS_API_KEY.
set -uo pipefail

# This repo's Linear team key (AGENTS.md, "The /flow Workflow").
TICKET_PREFIXES='DOR'
# The capability's own cap (`RECORD_PR_MAX_TICKETS`).
MAX_TICKETS=25
# How long one call may take before the open moves on without it.
CALL_SECONDS=15
LOOPBACK_ORIGIN_RE='^http://(localhost|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|\[::1\]):[0-9]{1,5}$'

say() { echo "work-graph: $*"; }

dry_run=0
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=1
  shift
  pr_url=""
  body_file=${1:-}
else
  pr_url=${1:-}
  body_file=${2:-}
fi
if [ ! -r "$body_file" ]; then
  say "not recorded (cannot read the PR body)"
  exit 0
fi

# The tickets the body names for sure, one key per line, first mention first.
tickets=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [file, prefixes, max] = process.argv.slice(1);
  let text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?(-->|$)/g, "");
  text = text.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[^\n]*$/gm, "");
  const KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})(?![A-Za-z0-9_])/g;
  const declared = new Set(prefixes.split(/\s+/).filter(Boolean));
  const found = [];
  const add = (key) => { if (!found.includes(key)) found.push(key); };
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(/https:\/\/linear\.app\/[A-Za-z0-9_-]+\/issue\/([A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,6})(?![A-Za-z0-9_])/g)) add(m[1]);
    const named = /^[\s>*_-]*(refs?|closes?|closed|fix(es|ed)?|resolves?|resolved)\b/i.test(line);
    for (const m of line.replace(/https?:\/\/\S+/g, " ").matchAll(KEY))
      if (named || declared.has(m[1].split("-")[0])) add(m[1]);
  }
  process.stdout.write(found.slice(0, Number(max)).join("\n"));
' "$body_file" "$TICKET_PREFIXES" "$MAX_TICKETS" 2>/dev/null) || {
  say "not recorded (node could not read the PR body)"
  exit 0
}
named=$(paste -sd, - <<<"$tickets" | sed 's/,/, /g')

token=${DORKOS_AGENT_TOKEN:-}
dorkos_bin=${OPEN_PR_DORKOS-$(command -v dorkos 2>/dev/null || true)}
api_url=${DORKOS_API_URL:-}
if [ -z "$token" ]; then
  how="nothing: this shell has no DorkOS chat token"
elif [ -n "$dorkos_bin" ]; then
  how="dorkos call"
elif [[ $api_url =~ $LOOPBACK_ORIGIN_RE ]]; then
  how="curl to $api_url"
elif [ -n "$api_url" ]; then
  how="nothing: DORKOS_API_URL is not a loopback origin"
else
  how="nothing: no dorkos CLI and no DorkOS server address in this shell"
fi

if [ "$dry_run" = 1 ]; then
  say "would record opened <new PR> and works_on: ${named:-no tickets}, through $how"
  exit 0
fi
case "$how" in nothing:*)
  say "not recorded (${how#nothing: })"
  exit 0
  ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
jq -n --arg pr "$pr_url" --arg t "$tickets" \
  '{pr: $pr, tickets: ($t | split("\n") | map(select(. != "")))}' >"$tmp/input.json" || {
  say "not recorded (jq could not build the call)"
  exit 0
}

# Run "$@" with stdin from $1, for at most CALL_SECONDS, out and err to files.
bounded() {
  local stdin=$1 ticks=0 pid
  shift
  "$@" <"$stdin" >"$tmp/out" 2>"$tmp/err" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge $((CALL_SECONDS * 10)) ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      echo "no answer in ${CALL_SECONDS}s" >"$tmp/err"
      return 124
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$pid"
}

reason() { # the first line that says something, from a file
  awk 'NF { sub(/^Error: /, ""); print; exit }' "$1" | cut -c1-200
}

if [ "$how" = "dorkos call" ]; then
  if ! bounded "$tmp/input.json" "$dorkos_bin" call work-graph.record-pr --input-file -; then
    say "not recorded ($(reason "$tmp/err"))"
    exit 0
  fi
else
  esc() { sed 's/\\/\\\\/g; s/"/\\"/g' <<<"$1"; }
  {
    echo "url = \"$api_url/api/capabilities/work-graph.record-pr/invoke\""
    echo 'header = "Content-Type: application/json"'
    echo "header = \"X-DorkOS-Agent: $(esc "$token")\""
    [ -z "${DORKOS_API_KEY:-}" ] || echo "header = \"Authorization: Bearer $(esc "$DORKOS_API_KEY")\""
    echo "data = \"@$tmp/input.json\""
    echo 'write-out = "\n%{http_code}"'
  } >"$tmp/curl.conf"
  chmod 600 "$tmp/curl.conf"
  if ! bounded "$tmp/curl.conf" "${OPEN_PR_CURL:-curl}" --silent --show-error --max-time 10 --config -; then
    say "not recorded (no DorkOS server answered at $api_url: $(reason "$tmp/err"))"
    exit 0
  fi
  status=$(tail -1 "$tmp/out")
  sed '$d' "$tmp/out" >"$tmp/body.json"
  if [ "$status" != 200 ]; then
    detail=$(jq -r '.detail // .error // empty' "$tmp/body.json" 2>/dev/null)
    say "not recorded (the server answered $status${detail:+: $detail})"
    exit 0
  fi
  mv "$tmp/body.json" "$tmp/out"
fi

summary=$(jq -r '
  "recorded: this chat opened \(.pr)"
  + (if (.tickets | length) > 0 then "; works on \(.tickets | join(", "))" else "" end)
  + (if (.refused | length) > 0 then "; refused \([.refused[] | "\(.ref) (\(.reason))"] | join(", "))" else "" end)
' "$tmp/out" 2>/dev/null) || summary="not recorded (the answer was not the one expected)"
say "$summary"
