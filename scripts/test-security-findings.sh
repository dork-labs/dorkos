#!/usr/bin/env bash
# Fixture suite for scripts/security-findings.sh and the `security-findings`
# half of scripts/review-gh.sh: a failing Security lens's details reach Security
# only as age ciphertext, and their plaintext reaches no output, no comment and
# no leftover file.
#
#   bash scripts/test-security-findings.sh
#
# Two layers. The plumbing (what is posted where, what is deleted, what is
# refused) runs everywhere against a stub `age`. The round trip (real encryption
# to a throwaway key made here, then `decrypt`) needs the real `age` and
# `age-keygen`: on PATH, or in AGE_BIN_DIR. Without them that layer is SKIPPED
# with a message, never passed. CI's scripts-test installs the pinned build
# (scripts/install-age.sh) and sets REQUIRE_AGE=1, which turns a skip into a
# failure. Needs bash and jq.
# The workflow checks match literal `${{ }}` and `$VAR` text, so single quotes are meant:
# shellcheck disable=SC2016
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/security-findings.sh
HELPER=$repo_root/scripts/review-gh.sh
tmp=$(mktemp -d -t security-findings-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

H=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OLD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CANARY='CANARY-7f3e9 apps/server/src/x.ts:42 the attacker is a fork author'
R1=age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsqgfngh
R2=age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj

# Stub `gh`. Logs argv. POST copies its --input file to $tmp/posted.json.
# GET answers from FAKE_PULL (repos/R/pulls/N), FAKE_ALL (repos/R/issues/comments)
# or FAKE_COMMENTS (repos/R/issues/N/comments), through the script's own --jq.
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ "$1" = pr ] && [ "$2" = comment ] && exit 0 # review-gh.sh's verdict comment
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
shift
filter=. path= input= method=GET
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) filter=$2; shift ;;
    --input) input=$2; shift ;;
    --method) method=$2; shift ;;
    --paginate) ;;
    *) path=$1 ;;
  esac
  shift
done
[ -n "${FAKE_FAIL:-}" ] && exit 1
if [ "$method" = POST ]; then
  cp "$input" "$POSTED"
  echo '{"id":1}'
  exit 0
fi
case "$path" in
  */pulls/*) data=${FAKE_PULL:-'{}'} ;;
  */issues/comments*) data=${FAKE_ALL:-'[]'} ;;
  */issues/*/comments*) data=${FAKE_COMMENTS:-'[]'} ;;
  *) echo "stub gh: unexpected path $path" >&2; exit 1 ;;
esac
jq -r "$filter" <<<"$data"
EOF

# Stub `age`. Encrypting logs its argv and writes fixed armour that carries
# nothing of the input. Decrypting checks it got that armour back.
cat >"$tmp/age" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$AGE_LOG"
[ -n "${AGE_FAIL:-}" ] && { echo "age: error: stub failure" >&2; exit 1; }
if [ "$1" = -d ]; then
  [ "$(cat "$4")" = "$(printf '%s\n' '-----BEGIN AGE ENCRYPTED FILE-----' 'c3R1Yi1jaXBoZXJ0ZXh0' '-----END AGE ENCRYPTED FILE-----')" ] || { echo "age: error: bad armour" >&2; exit 1; }
  echo "stub plaintext"
  exit 0
fi
out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
if [ -n "${AGE_BIG:-}" ]; then
  { echo '-----BEGIN AGE ENCRYPTED FILE-----'; for _ in $(seq 1 1000); do printf '%064d\n' 0; done; echo '-----END AGE ENCRYPTED FILE-----'; } >"$out"
elif [ -n "${AGE_BAD:-}" ]; then
  printf '%s\n' '-----BEGIN AGE ENCRYPTED FILE-----' '--> <img src=x>' '-----END AGE ENCRYPTED FILE-----' >"$out"
else
  printf '%s\n' '-----BEGIN AGE ENCRYPTED FILE-----' 'c3R1Yi1jaXBoZXJ0ZXh0' '-----END AGE ENCRYPTED FILE-----' >"$out"
fi
EOF
chmod +x "$tmp/gh" "$tmp/age"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" POSTED="$tmp/posted.json" REPO=made-up/repo
export AGE_LOG="$tmp/age.log"

out=""
rc=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n        output:   %s\n' \
      "$1" "$2" "$3" "$out" >&2
  fi
}
has() { grep -qF -- "$2" <<<"$1" && echo yes || echo no; }
# Does the canary appear anywhere under a directory (file contents)?
leaked_in() { grep -rqF -- "CANARY-7f3e9" "$1" 2>/dev/null && echo yes || echo no; }

fdir=$tmp/findings
recips=$tmp/recipients.txt
save() { # head, text: what review-gh.sh security-findings leaves behind
  mkdir -p "$fdir"
  printf '%s\n' "$2" >"$fdir/findings.txt"
  printf '%s\n' "$1" >"$fdir/head"
}
run_post() {
  : >"$GH_LOG"
  : >"$AGE_LOG"
  rm -f "$POSTED"
  out=$(PR=12 AGE=${AGE_OVERRIDE:-$tmp/age} "$SCRIPT" post "$fdir" "$recips" 2>&1)
  rc=$?
}

# ── post ─────────────────────────────────────────────────────────────────────
printf '# DorkOS Security\n%s\n\n  %s  # second key\nnot-a-key\n' "$R1" "$R2" >"$recips"
save $H "$CANARY"
run_post
check 'post: exit 0' 0 "$rc"
check 'post: encrypts armoured to every recipient on the list, skipping junk' \
  "-a -r $R1 -r $R2 -o" "$(sed -E 's/ -o .*/ -o/' "$AGE_LOG")"
check 'post: warns about the line that is not a recipient' yes "$(has "$out" 'not an age recipient')"
check 'post: posts one comment to the pinned PR' \
  "api --method POST repos/made-up/repo/issues/12/comments --input" "$(sed -E 's/ --input .*/ --input/' "$GH_LOG")"
body=$(jq -r .body "$POSTED" 2>/dev/null)
expected_body="<!-- dorkos-security-findings v1 pr=12 head=$H
-----BEGIN AGE ENCRYPTED FILE-----
c3R1Yi1jaXBoZXJ0ZXh0
-----END AGE ENCRYPTED FILE-----
-->"
check 'post: the comment is the fixed block and nothing else' "$expected_body" "$body"
# Everything in the comment that is not age armour is exactly the fixed header
# (pr= and head=) and the closing `-->`: no name, count, category or summary.
check 'post: the only clear text is the header with pr= and head=, and the closer' \
  "<!-- dorkos-security-findings v1 pr=12 head=$H|-->" \
  "$(grep -vxE '[A-Za-z0-9+/=]*|-----(BEGIN|END) AGE ENCRYPTED FILE-----' <<<"$body" | paste -sd '|' -)"
check 'post: the plaintext is not in the comment' no "$(has "$body" CANARY-7f3e9)"
check 'post: the plaintext is not in the output' no "$(has "$out" CANARY-7f3e9)"
check 'post: the findings directory is gone' no "$([ -e "$fdir" ] && echo yes || echo no)"
check 'post: the output names the size, not the content' yes "$(has "$out" 'bytes of details')"

: >"$recips"
save $H "$CANARY"
run_post
check 'no recipients: exit 0' 0 "$rc"
check 'no recipients: says the details were discarded' yes "$(has "$out" 'discarded unsent')"
check 'no recipients: nothing encrypted' "" "$(cat "$AGE_LOG")"
check 'no recipients: nothing posted' "" "$(cat "$GH_LOG")"
check 'no recipients: the plaintext is still deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"

rm -f "$recips"
save $H "$CANARY"
run_post
check 'recipients file absent on main: exit 0, nothing posted' "0:" "$rc:$(cat "$GH_LOG")"
check 'recipients file absent: the plaintext is deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"

printf '%s\n' "$R1" >"$recips"
rm -rf "$fdir"
run_post
check 'no details saved: exit 0, nothing encrypted or posted' "0::" "$rc:$(cat "$AGE_LOG"):$(cat "$GH_LOG")"

save $H "$CANARY"
AGE_FAIL=1 run_post
check 'age fails: exit 1' 1 "$rc"
check 'age fails: nothing posted' "" "$(cat "$GH_LOG")"
check 'age fails: the plaintext is still deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"
check 'age fails: no plaintext in the output' no "$(has "$out" CANARY-7f3e9)"

save $H "$CANARY"
AGE_BAD=1 run_post
check 'output that is not clean armour is refused: exit 1' 1 "$rc"
check 'and not posted' "" "$(cat "$GH_LOG")"

save $H "$CANARY"
AGE_BIG=1 run_post
check 'a comment over the size cap is refused: exit 1' 1 "$rc"
check 'and not posted' "" "$(cat "$GH_LOG")"
check 'and the plaintext is deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"

save "not-a-sha" "$CANARY"
run_post
check 'a saved head that is not a sha is refused: exit 1' 1 "$rc"
check 'and the plaintext is deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"

save $H "$CANARY"
FAKE_FAIL=1 run_post
check 'a failed post: exit 1' 1 "$rc"
check 'a failed post: the plaintext is deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"

save $H "$CANARY"
out=$(PR=abc AGE=$tmp/age "$SCRIPT" post "$fdir" "$recips" 2>&1)
rc=$?
check 'a PR that is not a number: exit 2' 2 "$rc"
check 'and the plaintext is deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"

# ── review-gh.sh security-findings (the reviewer's side) ─────────────────────
hlog=$tmp/helper-gh.log
call_helper() {
  : >"$hlog"
  out=$(REVIEW_REPO=made-up/repo REVIEW_PR=12 REVIEW_HEAD_SHA=$H REVIEW_FINDINGS_DIR=$fdir \
    GH_LOG="$hlog" PATH="$tmp:$PATH" bash "$HELPER" "$@" 2>&1)
  rc=$?
}
rm -rf "$fdir"
call_helper security-findings "$CANARY"
check 'helper: saves the details, exit 0' 0 "$rc"
check 'helper: saved byte-for-byte' "$CANARY" "$(cat "$fdir/findings.txt")"
check 'helper: stamps the head from the workflow' "$H" "$(cat "$fdir/head")"
check 'helper: the file is private' 600 "$(stat -c %a "$fdir/findings.txt" 2>/dev/null || stat -f %Lp "$fdir/findings.txt")"
check 'helper: never calls gh with the details' "" "$(cat "$hlog")"
check 'helper: does not echo the details' no "$(has "$out" CANARY-7f3e9)"

call_helper security-verdict fail 1 auth
check 'helper: a fail after saving details is posted' 0 "$rc"
check 'helper: the verdict comment carries no detail' no "$(has "$(cat "$hlog")" CANARY-7f3e9)"

rm -rf "$fdir"
call_helper security-verdict fail 1 auth
check 'helper: a fail with no details saved is refused' 2 "$rc"
check 'helper: and never reaches gh' "" "$(cat "$hlog")"
check 'helper: and says what to do' yes "$(has "$out" 'security-findings')"

save $OLD "$CANARY"
call_helper security-verdict fail 1 auth
check 'helper: details saved for another head do not count' 2 "$rc"

save $H "$CANARY"
call_helper security-verdict pass 0
check 'helper: a pass is posted' 0 "$rc"
check 'helper: a pass discards saved details' no "$([ -e "$fdir/findings.txt" ] && echo yes || echo no)"

call_helper security-findings ''
check 'helper: empty details are refused' 2 "$rc"
call_helper security-findings a b
check 'helper: two arguments are refused' 2 "$rc"
call_helper security-findings "$(head -c 16385 /dev/zero | tr '\0' x)"
check 'helper: details over 16384 bytes are refused' 2 "$rc"
check 'helper: the refusal names the size, not the content' no "$(has "$out" xxxxxxxx)"
out=$(REVIEW_REPO=made-up/repo REVIEW_PR=12 REVIEW_HEAD_SHA=$H GH_LOG="$hlog" PATH="$tmp:$PATH" \
  bash "$HELPER" security-findings "$CANARY" 2>&1)
rc=$?
check 'helper: refused when the workflow set no findings directory' 2 "$rc"
out=$(REVIEW_REPO=made-up/repo REVIEW_PR=12 REVIEW_HEAD_SHA=$H REVIEW_FINDINGS_DIR=relative/dir \
  GH_LOG="$hlog" PATH="$tmp:$PATH" bash "$HELPER" security-findings "$CANARY" 2>&1)
rc=$?
check 'helper: refused when the findings directory is not absolute' 2 "$rc"

# ── list and decrypt (Security's side) ───────────────────────────────────────
block() { # head
  printf '<!-- dorkos-security-findings v1 pr=%s head=%s\\n-----BEGIN AGE ENCRYPTED FILE-----\\nc3R1Yi1jaXBoZXJ0ZXh0\\n-----END AGE ENCRYPTED FILE-----\\n-->' "${2:-12}" "$1"
}
cm() { # login type time body [pr]
  printf '{"user":{"login":"%s","type":"%s"},"created_at":"%s","issue_url":"https://api.github.com/repos/made-up/repo/issues/%s","body":"%s"}' \
    "$1" "$2" "$3" "${5:-12}" "$4"
}
GA='github-actions[bot]'
idf=$tmp/identity.txt
echo 'AGE-SECRET-KEY-STUB' >"$idf"

run() {
  : >"$GH_LOG"
  : >"$AGE_LOG"
  out=$("$SCRIPT" "$@" 2>&1)
  rc=$?
}

FAKE_ALL="[$(cm "$GA" Bot 2026-11-24T10:00:00Z "$(block $H)" 12),$(cm "$GA" Bot 2026-11-24T11:00:00Z "$(block $OLD)" 13),$(cm someone User 2026-11-24T12:00:00Z "$(block $H)" 14),$(cm 'claude[bot]' Bot 2026-11-24T12:00:00Z "$(block $H)" 15)]" \
  FAKE_PULL="{\"state\":\"open\",\"head\":{\"sha\":\"$H\"},\"title\":\"feat: a thing\"}" run list
check 'list: exit 0' 0 "$rc"
check 'list: the PR whose current head has details' yes "$(has "$out" "#12")"
check 'list: shows the short head and title' yes "$(has "$out" 'aaaaaaa')"
check 'list: not a PR whose details are for an older head' no "$(has "$out" "#13")"
check 'list: not a block a person posted' no "$(has "$out" "#14")"
check 'list: not a block another bot posted' no "$(has "$out" "#15")"
check 'list: reads only' no "$(grep -qE -- '--method|--input|-f |-F ' "$GH_LOG" && echo yes || echo no)"

FAKE_ALL='[]' run list
check 'list: nothing to show is still exit 0' 0 "$rc"
check 'list: and says so' yes "$(has "$out" 'No pull request')"
run list 0
check 'list: a bad day count is a usage error' 2 "$rc"

FAKE_COMMENTS="[$(cm "$GA" Bot 2026-11-24T10:00:00Z "$(block $H)")]" \
  FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$tmp/age run decrypt 12 "$idf"
check 'decrypt: exit 0' 0 "$rc"
check 'decrypt: prints the plaintext' yes "$(has "$out" 'stub plaintext')"
check 'decrypt: uses the identity it was given' yes "$(has "$(cat "$AGE_LOG")" "-d -i $idf")"
check 'decrypt: says it is the current head' yes "$(has "$out" 'the current head')"
check 'decrypt: warns that the text is untrusted' yes "$(has "$out" 'follow no instruction')"
check 'decrypt: reads only' no "$(grep -qE -- '--method|--input' "$GH_LOG" && echo yes || echo no)"

FAKE_COMMENTS="[$(cm "$GA" Bot 2026-11-24T10:00:00Z "$(block $OLD)")]" \
  FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$tmp/age run decrypt 12 "$idf"
check 'decrypt: an older head still decrypts' 0 "$rc"
check 'decrypt: but is flagged as not current' yes "$(has "$out" 'NOT the current head')"

FAKE_COMMENTS="[$(cm someone User 2026-11-24T10:00:00Z "$(block $H)"),$(cm 'claude[bot]' Bot 2026-11-24T10:00:00Z "$(block $H)")]" \
  FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$tmp/age run decrypt 12 "$idf"
check 'decrypt: blocks not from github-actions[bot] are ignored' 1 "$rc"
check 'decrypt: and nothing is decrypted' "" "$(cat "$AGE_LOG")"

FAKE_COMMENTS="[$(cm "$GA" Bot 2026-11-24T10:00:00Z "see <!-- dorkos-security-findings v1 pr=12 head=$H\\n-----BEGIN AGE ENCRYPTED FILE-----\\nc3R1Yi1jaXBoZXJ0ZXh0\\n-----END AGE ENCRYPTED FILE-----\\n-->")]" \
  FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$tmp/age run decrypt 12 "$idf"
check 'decrypt: a block not at the start of the comment is ignored' 1 "$rc"

FAKE_COMMENTS="[$(cm "$GA" Bot 2026-11-24T10:00:00Z "$(block $H 99)")]" \
  FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$tmp/age run decrypt 12 "$idf"
check 'decrypt: a block naming another PR is ignored' 1 "$rc"
FAKE_COMMENTS="[$(cm "$GA" Bot 2026-11-24T10:00:00Z "$(block $H)\\nplus some clear text")]" \
  FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$tmp/age run decrypt 12 "$idf"
check 'decrypt: a block with clear text after it is ignored' 1 "$rc"

run decrypt 12 "$tmp/no-such-identity"
check 'decrypt: a missing identity file is a usage error' 2 "$rc"
run decrypt abc "$idf"
check 'decrypt: a PR that is not a number is a usage error' 2 "$rc"
run decrypt 12
check 'decrypt: no identity is a usage error' 2 "$rc"

# ── the review workflow's side ───────────────────────────────────────────────
# The step that runs `post` must clean up even when the review failed, and must
# never print or upload the details itself.
wf=$repo_root/.github/workflows/claude-code-review.yml
step=$(awk '/- name: Send the Security lens details to Security, encrypted/{on=1; print; next}
  on && /^      (- name: |# )/ {exit} on' "$wf")
check 'workflow: the send step exists' yes "$([ -n "$step" ] && echo yes || echo no)"
check 'workflow: it always runs, so the plaintext is always deleted' yes "$(has "$step" 'if: always()')"
check 'workflow: it deletes the findings directory on exit' yes "$(has "$step" "trap 'rm -rf \"\$FINDINGS_DIR\"' EXIT")"
check 'workflow: it runs main'"'"'s copy of the scripts' yesyes \
  "$(has "$step" 'for f in security-findings.sh install-age.sh; do')$(has "$step" 'git show "origin/$DEFAULT_BRANCH:scripts/$f"')"
check 'workflow: and not the checkout'"'"'s' no "$(has "$step" 'bash scripts/')"
check 'workflow: recipients come from main' yes "$(has "$step" 'git show "origin/$DEFAULT_BRANCH:ci/security/findings-recipients.txt"')"
check 'workflow: it never cats, uploads or summarises the details' no \
  "$(grep -qE 'cat .*findings\.txt|upload-artifact|GITHUB_STEP_SUMMARY|set -x' <<<"$step" && echo yes || echo no)"
check 'workflow: the reviewer is told where to save details' yes \
  "$(grep -qF 'REVIEW_FINDINGS_DIR: ${{ runner.temp }}/security-findings' "$wf" && echo yes || echo no)"
check 'workflow: the send step reads the same directory' yes "$(has "$step" 'FINDINGS_DIR: ${{ runner.temp }}/security-findings')"

# ── recipients come from MAIN, never the PR (Security's requirement) ─────────
# Runs the workflow step's own script in a scratch repository whose
# origin/main and checkout disagree about ci/security/findings-recipients.txt.
# A PR that could add its own key could read its own findings.
step_run=$(awk '/^        run: \|/{on=1; next} on' <<<"$step" | sed 's/^          //')
wfrepo=$tmp/wfrepo
run_step() { # [main recipient or empty] [PR-head recipient]
  rm -rf "$wfrepo"
  mkdir -p "$wfrepo/scripts" "$wfrepo/ci/security"
  cp "$SCRIPT" "$repo_root/scripts/install-age.sh" "$wfrepo/scripts/"
  [ -n "$1" ] && printf '%s\n' "$1" >"$wfrepo/ci/security/findings-recipients.txt"
  (
    cd "$wfrepo" || exit 1
    g() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }
    g init -q -b main . && g add -A && g commit -qm main && g update-ref refs/remotes/origin/main HEAD &&
      g checkout -qb pr-head && printf '%s\n' "$2" >ci/security/findings-recipients.txt &&
      g add -A && g commit -qm pr
  ) >/dev/null 2>&1
  save $H "$CANARY"
  : >"$GH_LOG"
  : >"$AGE_LOG"
  rm -f "$POSTED"
  out=$(cd "$wfrepo" && DEFAULT_BRANCH=main FINDINGS_DIR=$fdir RUNNER_TEMP=$tmp/runner PR=12 \
    AGE=$tmp/age bash -e -c "$step_run" 2>&1)
  rc=$?
}
mkdir -p "$tmp/runner"
check 'workflow: the step script was extracted' yes "$(has "$step_run" 'security-findings.sh" post')"
run_step "$R1" "$R2"
check 'main recipient: the step exits 0' 0 "$rc"
check 'main recipient: encrypts to main'"'"'s key only, never the PR head'"'"'s' \
  "-a -r $R1 -o" "$(sed -E 's/ -o .*/ -o/' "$AGE_LOG")"
run_step '' "$R2"
check 'a PR-head recipients file with none on main: exit 0' 0 "$rc"
check 'and nothing is encrypted' "" "$(cat "$AGE_LOG")"
check 'and nothing is posted' "" "$(cat "$GH_LOG")"
check 'and the plaintext is deleted' no "$([ -e "$fdir" ] && echo yes || echo no)"
check 'and no plaintext in the step output' no "$(has "$out" CANARY-7f3e9)"

# ── the round trip, with the real age ────────────────────────────────────────
age_bin='' keygen_bin=''
if [ -n "${AGE_BIN_DIR:-}" ] && [ -x "$AGE_BIN_DIR/age" ] && [ -x "$AGE_BIN_DIR/age-keygen" ]; then
  age_bin=$AGE_BIN_DIR/age keygen_bin=$AGE_BIN_DIR/age-keygen
elif command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1; then
  age_bin=$(command -v age) keygen_bin=$(command -v age-keygen)
fi
if [ -z "$age_bin" ]; then
  if [ -n "${REQUIRE_AGE:-}" ]; then
    fail=$((fail + 1))
    echo "FAIL  REQUIRE_AGE is set but age and age-keygen were not found" >&2
  else
    echo "SKIP  the real-age round trip: age and age-keygen are not installed (install them, or set AGE_BIN_DIR; CI runs it)" >&2
  fi
else
  "$keygen_bin" -o "$tmp/real-key.txt" 2>/dev/null
  real_r=$("$keygen_bin" -y "$tmp/real-key.txt")
  "$keygen_bin" -o "$tmp/other-key.txt" 2>/dev/null
  printf '%s\n' "$real_r" >"$recips"
  save $H "$CANARY"
  AGE_OVERRIDE=$age_bin run_post
  check 'real age: post exit 0' 0 "$rc"
  real_body=$(jq -r .body "$POSTED" 2>/dev/null)
  check 'real age: no plaintext in the comment' no "$(has "$real_body" CANARY-7f3e9)"
  check 'real age: no plaintext in the output' no "$(has "$out" CANARY-7f3e9)"
  check 'real age: no plaintext left on disk' no "$(leaked_in "$tmp")"
  check 'real age: the findings directory is gone' no "$([ -e "$fdir" ] && echo yes || echo no)"
  comments=$(jq -n --arg b "$real_body" '[{user: {login: "github-actions[bot]", type: "Bot"}, created_at: "2026-11-24T10:00:00Z", body: $b}]')
  FAKE_COMMENTS=$comments FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$age_bin run decrypt 12 "$tmp/real-key.txt"
  check 'real age: decrypt exit 0' 0 "$rc"
  check 'real age: decrypt returns the details' yes "$(has "$out" "$CANARY")"
  FAKE_COMMENTS=$comments FAKE_PULL="{\"head\":{\"sha\":\"$H\"}}" AGE=$age_bin run decrypt 12 "$tmp/other-key.txt"
  check 'real age: another key cannot decrypt' 1 "$rc"
  check 'real age: and prints nothing of the details' no "$(has "$out" CANARY-7f3e9)"
fi

echo "security-findings fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
