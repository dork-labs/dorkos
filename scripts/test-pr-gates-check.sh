#!/usr/bin/env bash
# Fixture suite for scripts/pr-gates-check.sh: the `pr-gates` check runs
# arm-door's own decision (scripts/arm-door.sh, qa-real-data.sh, design-ok.sh)
# on the pull request, minus the verify-proof reason, with Security's sign-off
# taken from a signed review marker or the cloud verdict, never a label. A
# stubbed `gh` (GH=...) answers every read from canned JSON through the script's
# own --jq filter, so nothing reaches GitHub. Signatures are real: a throwaway
# ed25519 key made here signs them. Needs bash, jq and ssh-keygen.
#
#   bash scripts/test-pr-gates-check.sh
set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPT=$repo_root/scripts/pr-gates-check.sh
tmp=$(mktemp -d -t pr-gates-test.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

H=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222
NS=dorkos-security-review

# Throwaway keys: `key` is Security's (in the test allowed_signers), `other` is not.
keys=$tmp/keys
mkdir -p "$keys"
ssh-keygen -q -t ed25519 -N '' -C test-security -f "$keys/key" || exit 1
ssh-keygen -q -t ed25519 -N '' -C test-other -f "$keys/other" || exit 1
signers() { printf 'security@dorkos namespaces="%s" %s\n' "$NS" "$(cat "$1.pub")"; }
signers "$keys/key" >"$keys/allowed_signers"
export ALLOWED_SIGNERS=$keys/allowed_signers
# sig <key> <namespace> <text>: an armored SSH signature over <text>, no newline added.
sig() { printf '%s' "$3" | ssh-keygen -q -Y sign -f "$1" -n "$2"; }
# marker <repo> <pr> <head> <verdict> <armor>: a review comment body.
marker() { printf '<!-- dorkos-security-review v1 repo=%s pr=%s head=%s verdict=%s\n%s\n-->' "$1" "$2" "$3" "$4" "$5"; }
# review [repo pr head verdict [key [namespace [signed-text]]]]: a correctly signed
# marker for this PR by default; each argument overrides one part.
review() {
  local repo=${1:-made-up/repo} pr=${2:-12} head=${3:-$H} verdict=${4:-pass} key=${5:-$keys/key} ns=${6:-$NS} text
  text=${7:-dorkos-security-review v1 repo=$repo pr=$pr head=$head verdict=$verdict}
  marker "$repo" "$pr" "$head" "$verdict" "$(sig "$key" "$ns" "$text")"
}
# comments <body>...: the PR's comments, oldest first, one minute apart.
comments() {
  local i=0 b
  for b in "$@"; do
    i=$((i + 1))
    jq -n --arg b "$b" --argjson i "$i" '{id: (100 + $i), created_at: "2026-11-23T10:\(10 + $i):00Z", body: $b}'
  done | jq -s . >"$fx/comments"
}
# Canned answers, one file per endpoint, rewritten by each case.
fx=$tmp/fx
mkdir -p "$fx"
# pull_json <head repo> <changed files>: the PR, opened from <head repo> into made-up/repo.
pull_json() {
  jq -n --arg h "$H" --arg r "$1" --argjson n "$2" \
    '{head: {sha: $h, ref: "feat/x", repo: (if $r == "" then null else {full_name: $r} end)},
      base: {repo: {full_name: "made-up/repo"}}, title: "feat(server): x", changed_files: $n}' >"$fx/pull"
}
# files_json <name>...: the PR's changed files, all modified.
files_json() {
  printf '%s\n' "$@" | jq -R '{filename: ., status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b"}' |
    jq -s . >"$fx/files"
}
reset_fixtures() {
  pull_json made-up/repo 1
  echo '{"commit":{"committer":{"date":"2026-11-23T10:00:00Z"}}}' >"$fx/commit"
  echo '{"workflow_runs":[{"path":".github/workflows/typecheck.yml","head_branch":"feat/x","head_repository":{"full_name":"made-up/repo"},"created_at":"2026-11-23T10:01:00Z"}]}' >"$fx/runs"
  echo '[]' >"$fx/statuses"
  echo '{"check_runs":[]}' >"$fx/checkruns"
  echo '[]' >"$fx/events"
  echo '[{"name":"review:light"}]' >"$fx/labels"
  comments "$(review)"
  # shellcheck disable=SC2028 # the \n is JSON's, for jq, not the shell's
  echo '[{"filename":"apps/server/src/lib/thing.ts","status":"modified","additions":1,"deletions":0,"patch":"@@ -1 +1 @@\n-a\n+b"}]' >"$fx/files"
  FAKE_FAIL=
}

cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_LOG"
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
# Print a --jq result the way gh does: a string raw, a null as an empty line
# (`jq -r` alone prints "null"), anything else as compact JSON.
gh_jq() {
  jq -rc "($1
) | if . == null then \"\" else . end" "${@:2}"
}
url= filter=. paginate=
args=("$@")
for ((i = 1; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --jq) filter=${args[$((i + 1))]}; i=$((i + 1)) ;;
    --paginate) paginate=1 ;;
    *) [ -z "$url" ] && url=${args[$i]} ;;
  esac
done
case "$url" in
  */pulls/*/files*) f=files ;;
  */pulls/*) f=pull ;;
  */commits/*/statuses*) f=statuses ;;
  */commits/*/check-runs*) f=checkruns ;;
  */commits/*) f=commit ;;
  */actions/runs*) f=runs ;;
  */issues/*/events*) f=events ;;
  */issues/*/labels*) f=labels ;;
  */issues/*/comments*) f=comments ;;
  *) echo "stub gh: unexpected $url" >&2; exit 1 ;;
esac
[ "${FAKE_FAIL:-}" = "$f" ] && exit 1
# A list answer comes in pages of 100, as GitHub's does: without --paginate only
# the first page, with it every page, the filter run on each (as gh does).
if jq -e 'type == "array"' "$FX/$f" >/dev/null; then
  last=$([ -n "$paginate" ] && echo 1000000 || echo 100)
  jq -c --argjson last "$last" '. as $a | range(0; [length, $last] | min; 100) | $a[.:. + 100]' "$FX/$f" >"$FX/.pages" || exit 1
  while IFS= read -r page; do gh_jq "$filter" <<<"$page" || exit 1; done <"$FX/.pages"
  exit 0
fi
gh_jq "$filter" "$FX/$f"
EOF
chmod +x "$tmp/gh"
export GH="$tmp/gh" GH_LOG="$tmp/gh.log" REPO=made-up/repo FX=$fx

out=""
rc=0
run() {
  : >"$GH_LOG"
  out=$(FAKE_FAIL=${FAKE_FAIL:-} "$SCRIPT" "$@" 2>&1)
  rc=$?
}
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

# --- decide: arm-door's verdict line to a check result ---
export SECURITY_SIGNOFF=signed
run decide 'KEEP gates-met proof=ci-green stamp=yes'
check 'gates-met with a signed review passes' 0 "$rc"
run decide 'PULL no-proof'
check 'a missing verify proof alone passes (the required checks are the proof)' 0 "$rc"
run decide 'PULL no-security-label,no-proof'
check "arm-door's label reason does not count once Security signed" 0 "$rc"
run decide 'PULL design-ok-older-than-head'
check 'a stale design-ok no longer blocks (Security-only, DOR-5119)' 0 "$rc"
check 'it still notes it for the daily sweep' yes "$(has "$out" 'daily sweep')"
SECURITY_SIGNOFF=cloud run decide 'PULL no-security-label,no-proof'
check 'the cloud verdict counts as the sign-off' 0 "$rc"
SECURITY_SIGNOFF=none run decide 'KEEP gates-met proof=ci-green stamp=yes'
check 'gates-met without a sign-off fails (a label is not one)' 1 "$rc"
check 'it explains the reason' yes "$(has "$out" 'no signed review marker that verifies')"
check 'it does not list no-proof' no "$(has "$out" 'no-proof')"
SECURITY_SIGNOFF=label run decide 'PULL no-proof'
check 'an unknown sign-off value is none' 1 "$rc"
SECURITY_SIGNOFF=none run decide 'PULL no-security-label,no-qa-label,no-proof'
check 'Security still blocks beside a QA note' 1 "$rc"
check 'the QA reason is only a note' yes "$(has "$out" 'Note (not a merge gate; the daily sweep picks it up): no-qa-label')"
run decide 'PULL some-new-reason'
check 'an unknown arm-door reason still blocks' 1 "$rc"
run decide 'KEEP unreadable headSeenAt'
check 'an unreadable verdict fails closed with exit 2' 2 "$rc"
run decide 'something else'
check 'an unknown verdict is exit 2' 2 "$rc"
unset SECURITY_SIGNOFF

# --- run: end to end through the real arm-door.sh ---
reset_fixtures
run run 12
check 'server change, signed review at the head: passes' 0 "$rc"
check 'it prints the arm-door verdict' yes "$(has "$out" 'arm-door verdict for #12')"
check 'it says the signed review counted' yes "$(has "$out" "verifies against main's key (comment 101)")"
check 'it reads the comments' yes "$(grep -q 'issues/12/comments' "$GH_LOG" && echo yes || echo no)"

reset_fixtures
comments
run run 12
check 'no signed review and no cloud verdict: fails' 1 "$rc"
check 'and names it' yes "$(has "$out" 'no-security-signoff')"

# --- the label alone no longer counts ---
reset_fixtures
comments
echo '[{"name":"review:light"},{"name":"security-reviewed"}]' >"$fx/labels"
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T10:05:00Z"}]' >"$fx/events"
run run 12
check 'a fresh security-reviewed label alone: fails' 1 "$rc"
check 'and a note says the label is not the sign-off' yes "$(has "$out" 'a label alone is not')"

reset_fixtures
echo '[{"name":"review:light"},{"name":"security-reviewed"}]' >"$fx/labels"
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T10:05:00Z"}]' >"$fx/events"
run run 12
check 'a label beside a valid signed review: passes' 0 "$rc"
check 'with no label note' no "$(has "$out" 'a label alone is not')"

reset_fixtures
echo '{"workflow_runs":[]}' >"$fx/runs"
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T10:05:00Z"}]' >"$fx/events"
run run 12
check 'a label of unknowable age does not make the check unreadable' 0 "$rc"

reset_fixtures
echo '[{"name":"needs-design"}]' >"$fx/labels"
run run 12
check 'needs-design with no design-ok: passes (not a merge gate)' 0 "$rc"
check 'and notes the design gate' yes "$(has "$out" 'no-design-ok')"

reset_fixtures
echo '[{"name":"needs-design"},{"name":"design-ok"}]' >"$fx/labels"
echo '[{"event":"labeled","label":{"name":"design-ok"},"created_at":"2026-11-23T10:06:00Z"}]' >"$fx/events"
run run 12
check 'needs-design with a fresh design-ok: passes' 0 "$rc"
check 'and no design note' no "$(has "$out" 'design-ok')"

# --- what a signed review must get right ---
reset_fixtures
comments "$(review made-up/repo 12 "$H2")"
run run 12
check 'a signed review for another head: fails' 1 "$rc"

reset_fixtures
comments "$(review made-up/repo 13)"
run run 12
check 'a signed review for another PR: fails' 1 "$rc"
check 'and says why' yes "$(has "$out" 'names another repo or PR')"

reset_fixtures
comments "$(review other/repo)"
run run 12
check 'a signed review for another repo: fails' 1 "$rc"

reset_fixtures
comments "$(review '' '' '' '' '' other-namespace)"
run run 12
check 'a signature in another namespace: fails' 1 "$rc"
check 'and says it does not verify' yes "$(has "$out" "does not verify against main's key")"

reset_fixtures
comments "$(review '' '' '' '' "$keys/other")"
run run 12
check 'a signature by a key not on main: fails' 1 "$rc"

reset_fixtures
comments "$(review '' '' '' '' '' '' "dorkos-security-review v1 repo=made-up/repo pr=12 head=$H2 verdict=pass")"
run run 12
check 'a signature over different text (tampered marker): fails' 1 "$rc"

reset_fixtures
comments "$(review '' '' '' '' '' '' "dorkos-security-review v1 repo=made-up/repo pr=12 head=$H verdict=pass
")"
run run 12
check 'a signature over the text plus a newline: fails' 1 "$rc"

reset_fixtures
comments "$(review '' '' '' fail)"
run run 12
check 'a signed verdict other than pass: fails' 1 "$rc"
check 'and says it is not a pass' yes "$(has "$out" 'is not a pass')"

reset_fixtures
ALLOWED_SIGNERS=$tmp/missing-signers run run 12
check 'no allowed_signers file: a valid signature does not count' 1 "$rc"
check 'and says main has no key' yes "$(has "$out" 'main has no Security key')"

reset_fixtures
printf '# Security public key goes here\n\n' >"$tmp/empty-signers"
ALLOWED_SIGNERS=$tmp/empty-signers run run 12
check 'an allowed_signers with no key line: fails' 1 "$rc"

reset_fixtures
echo "[$(printf '{"context":"security-verdict","state":"success","creator":{"login":"github-actions[bot]"},"created_at":"2026-11-23T10:10:00Z","id":1}')]" >"$fx/statuses"
ALLOWED_SIGNERS=$tmp/missing-signers run run 12
check 'no allowed_signers file: the cloud verdict still passes' 0 "$rc"

good=$(sig "$keys/key" "$NS" "dorkos-security-review v1 repo=made-up/repo pr=12 head=$H verdict=pass")
reset_fixtures
comments "$(marker made-up/repo 12 "$H" pass "${good//-----END SSH SIGNATURE-----/}")"
run run 12
check 'armor with no END line: fails' 1 "$rc"
check 'and says the signature is malformed' yes "$(has "$out" 'no well-formed SSH signature')"

reset_fixtures
comments "$(marker made-up/repo 12 "$H" pass "$(sed '2s/^./!/' <<<"$good")")"
run run 12
check 'armor with a stray character: fails' 1 "$rc"

reset_fixtures
comments "$(marker made-up/repo 12 "$H" pass "$(sed '2s/^.\(.\)/\1A/' <<<"$good")")"
run run 12
check 'armor with a corrupted byte: fails' 1 "$rc"

reset_fixtures
comments "$(marker made-up/repo 12 "$H" pass "$good" | sed 's/$/\r/')"
run run 12
check 'CRLF line endings (as GitHub may store them): passes' 0 "$rc"

reset_fixtures
comments "Looks good to me.
$(review)
Thanks."
run run 12
check 'a marker inside a longer comment: passes' 0 "$rc"

reset_fixtures
comments "$(review)$(printf '%17000s' '')"
run run 12
check 'a comment over the size cap is ignored' 1 "$rc"

reset_fixtures
junk=$(marker made-up/repo 12 "$H" pass "$(sed '2s/^.\(.\)/\1A/' <<<"$good")")
comments "$(review)" "$(review '' '' '' '' "$keys/other")" "$junk" "$(review '' '' '' fail)"
run run 12
check 'a valid signature followed by newer junk markers: still passes' 0 "$rc"
check 'and names the valid comment' yes "$(has "$out" 'comment 101')"

reset_fixtures
comments "$(review '' '' '' '' "$keys/other")" "$(review)"
run run 12
check 'a valid signature after a junk marker: passes' 0 "$rc"

reset_fixtures
comments "$(review '' '' '' '' "$keys/other")" "$junk" "$(review '' '' '' '' '' other-namespace)"
run run 12
check 'only junk markers: fails' 1 "$rc"
check "and gives the newest marker's reason" yes "$(has "$out" 'newest marker for this head (comment 103 does not verify')"

bodies=("$(review)")
for _ in $(seq 19); do bodies+=("$junk"); done
reset_fixtures
comments "${bodies[@]}"
run run 12
check 'a valid marker among the 20 newest: passes' 0 "$rc"
reset_fixtures
comments "${bodies[@]}" "$junk"
run run 12
check 'a valid marker older than the 20 newest is not tried' 1 "$rc"

reset_fixtures
comments "$(review)" "$(review made-up/repo 12 "$H2")"
run run 12
check 'a newer marker for another head does not hide this head'"'"'s' 0 "$rc"

reset_fixtures
comments "\$(touch $tmp/pwned) \`touch $tmp/pwned\`
$(review)"
run run 12
check 'shell text in a comment beside a valid marker: passes' 0 "$rc"
check 'and nothing in it is evaluated' no "$([ -e "$tmp/pwned" ] && echo yes || echo no)"

# --- allowed_signers comes from main's copy: the path the workflow gives ---
# A copy of the scripts as main's checkout, whose own ci/security/allowed_signers
# holds a different key, run from a directory standing in for the PR's checkout.
main=$tmp/main
mkdir -p "$main/scripts" "$main/ci/security" "$tmp/prco/ci/security"
cp "$repo_root"/scripts/{pr-gates-check.sh,arm-door.sh,qa-real-data.sh,design-ok.sh} "$main/scripts/"
cp "$repo_root/ci/required-checks.json" "$main/ci/"
signers "$keys/key" >"$main/ci/security/allowed_signers"
signers "$keys/other" >"$tmp/prco/ci/security/allowed_signers"
mainrun() { : >"$GH_LOG"; out=$(cd "$tmp/prco" && env -u ALLOWED_SIGNERS "$@" bash "$main/scripts/pr-gates-check.sh" run 12 2>&1); rc=$?; }
reset_fixtures
mainrun
check "with no ALLOWED_SIGNERS, the key beside main's scripts verifies" 0 "$rc"
reset_fixtures
comments "$(review '' '' '' '' "$keys/other")"
mainrun
check "a key only in the PR's checkout does not" 1 "$rc"
reset_fixtures
comments "$(review '' '' '' '' "$keys/other")"
mainrun ALLOWED_SIGNERS="$tmp/prco/ci/security/allowed_signers"
check 'ALLOWED_SIGNERS is the file read (the workflow sets it)' 0 "$rc"
wf=$repo_root/.github/workflows/pr-gates.yml
# shellcheck disable=SC2016 # the ${{ }} are the workflow's, matched literally
check "pr-gates.yml checks out main's (or the queue base's) copy" yes \
  "$(grep -qF 'ref: ${{ github.event.merge_group.base_sha || github.event.repository.default_branch }}' "$wf" && echo yes || echo no)"
check 'pr-gates.yml sparse-checks-out ci/security/allowed_signers' yes \
  "$(grep -qE '^ +ci/security/allowed_signers$' "$wf" && echo yes || echo no)"
# shellcheck disable=SC2016 # as above
check "pr-gates.yml points ALLOWED_SIGNERS at that checkout" yes \
  "$(grep -qF 'ALLOWED_SIGNERS: ${{ github.workspace }}/ci/security/allowed_signers' "$wf" && echo yes || echo no)"
check 'pr-gates.yml has a single checkout (no PR copy to read by mistake)' 1 \
  "$(grep -c 'uses: actions/checkout' "$wf")"

# --- the cloud Security lens is the other sign-off (Nov 23) ---
sv() { # state login time
  printf '{"context":"security-verdict","state":"%s","creator":{"login":"%s"},"created_at":"%s","id":1}' "$1" "$2" "$3"
}
reset_fixtures
comments
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'no label, but a cloud Security pass at the head: passes' 0 "$rc"
check 'it says the cloud verdict counted' yes "$(has "$out" 'counts as Security')"

reset_fixtures
comments
echo '[{"name":"security-reviewed"}]' >"$fx/labels"
echo '[{"event":"labeled","label":{"name":"security-reviewed"},"created_at":"2026-11-23T09:00:00Z"}]' >"$fx/events"
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'a stale label plus a cloud pass: passes' 0 "$rc"

reset_fixtures
comments
echo "[$(sv success 'someone' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'a security-verdict status not from GitHub Actions does not count' 1 "$rc"

reset_fixtures
comments
echo "[$(sv failure 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'a cloud fail does not count' 1 "$rc"

reset_fixtures
comments
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z),$(sv failure 'github-actions[bot]' 2026-11-23T10:20:00Z)]" >"$fx/statuses"
run run 12
check 'the newest cloud verdict wins (fail after pass)' 1 "$rc"

reset_fixtures
comments
echo '[{"name":"needs-design"}]' >"$fx/labels"
echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"
run run 12
check 'needs-design with only a cloud pass: passes' 0 "$rc"
check 'and notes the design gate' yes "$(has "$out" 'no-design-ok')"

# --- outside contributions: another repository's PR that changes workflows,
# scripts, package manifests or lockfiles needs Security's signed review ---
cloud_pass() { echo "[$(sv success 'github-actions[bot]' 2026-11-23T10:10:00Z)]" >"$fx/statuses"; }
SECURITY_SIGNOFF=cloud SIGNED_REVIEW_ONLY=yes run decide 'KEEP gates-met proof=ci-green stamp=yes'
check 'decide: an outside contribution with only the cloud verdict fails' 1 "$rc"
check 'and names the reason' yes "$(has "$out" 'outside-contribution-needs-signed-review')"
SECURITY_SIGNOFF=signed SIGNED_REVIEW_ONLY=yes run decide 'KEEP gates-met proof=ci-green stamp=yes'
check 'decide: an outside contribution with a signed review passes' 0 "$rc"

reset_fixtures
comments
cloud_pass
pull_json someone/fork 2
files_json apps/server/src/lib/thing.ts .github/workflows/x.yml
run run 12
check 'another repo, a workflow change, the cloud verdict only: fails' 1 "$rc"
check 'and names the reason' yes "$(has "$out" 'outside-contribution-needs-signed-review')"
check 'and lists the path' yes "$(has "$out" 'changed: ".github/workflows/x.yml"')"
check 'and not the other one' no "$(has "$out" 'changed: "apps/server')"
check 'and says the cloud verdict does not count for it' yes "$(has "$out" "only Security's signed review counts.")"

reset_fixtures
cloud_pass
pull_json someone/fork 2
files_json apps/server/src/lib/thing.ts .github/workflows/x.yml
run run 12
check 'another repo, a workflow change, a signed review: passes' 0 "$rc"

reset_fixtures
comments
pull_json someone/fork 2
files_json apps/server/src/lib/thing.ts .github/workflows/x.yml
run run 12
check 'another repo, a workflow change, no sign-off: fails' 1 "$rc"
check 'with the outside-contribution reason' yes "$(has "$out" 'outside-contribution-needs-signed-review')"

reset_fixtures
comments
cloud_pass
pull_json someone/fork 2
files_json docs/guide.mdx contributing/ci.md
run run 12
check 'another repo, docs only, the cloud verdict: passes' 0 "$rc"
check 'with no outside-contribution note' no "$(has "$out" 'Outside contribution')"

reset_fixtures
comments
cloud_pass
pull_json made-up/repo 3
files_json .github/workflows/x.yml scripts/x.sh pnpm-lock.yaml
run run 12
check 'this repo, workflow and lockfile changes, the cloud verdict: passes (unchanged)' 0 "$rc"

for p in packages/foo/package.json apps/site/package.json package.json pnpm-lock.yaml \
  pnpm-workspace.yaml .npmrc packages/foo/.npmrc lefthook.yml scripts/x.sh tools/t/run.sh \
  packages/cli/scripts/build.ts .claude/hooks/h.mjs ci/required-checks.json patches/p.patch \
  .pnpmfile.cjs turbo.json packages/ci-steward/src/cli.ts Scripts/x.sh .GitHub/workflows/a.yml \
  Package.JSON packages/foo/PACKAGE.json Dockerfile Dockerfile.hub apps/x/Dockerfile.dev \
  docker/entrypoint.sh apps/desktop/build/entitlements.mac.plist apps/desktop/electron-builder.yml \
  apps/desktop/electron.vite.config.ts; do
  reset_fixtures
  comments
  cloud_pass
  pull_json someone/fork 1
  files_json "$p"
  run run 12
  check "another repo changing $p with the cloud verdict only: fails" 1 "$rc"
done

reset_fixtures
cloud_pass
pull_json someone/fork 1
files_json packages/foo/package.json
run run 12
check 'another repo, a nested package.json, a signed review: passes' 0 "$rc"

for p in packages/foo/src/package.ts docs/scripts.md apps/client/src/tools.ts README.md \
  apps/desktop/src/main/index.ts apps/e2e/reporters/manifest-reporter.ts docs/docker.md \
  apps/client/vite.config.ts; do
  reset_fixtures
  comments
  cloud_pass
  pull_json someone/fork 1
  files_json "$p"
  run run 12
  check "another repo changing only $p with the cloud verdict: passes" 0 "$rc"
done

reset_fixtures
comments
cloud_pass
pull_json someone/fork 1
echo '[{"filename":"docs/x.sh","previous_filename":"scripts/x.sh","status":"renamed","additions":0,"deletions":0}]' >"$fx/files"
run run 12
check 'another repo renaming a file out of scripts/: needs the signed review' 1 "$rc"
check 'and lists the old name' yes "$(has "$out" 'changed: "scripts/x.sh"')"

reset_fixtures
comments
cloud_pass
pull_json '' 1
files_json .github/workflows/x.yml
run run 12
check 'a head repository that no longer exists counts as another repo' 1 "$rc"

reset_fixtures
comments
cloud_pass
pull_json someone/fork 1
files_json .github/workflows/x.yml
jq 'del(.base)' "$fx/pull" >"$fx/pull.new" && mv "$fx/pull.new" "$fx/pull"
run run 12
check 'an unreadable base repository fails closed with exit 2' 2 "$rc"

reset_fixtures
comments
cloud_pass
pull_json someone/fork 3
files_json docs/a.md docs/b.md
run run 12
check 'another repo with an incomplete file list fails closed with exit 2' 2 "$rc"

# Pagination: 150 files come in two pages; the one that matters is on the second.
many=()
for i in $(seq 1 150); do many+=("docs/page-$i.md"); done
reset_fixtures
comments
cloud_pass
pull_json someone/fork 150
files_json "${many[@]}"
run run 12
check 'another repo, 150 docs files, the cloud verdict: passes' 0 "$rc"
files_calls=$(grep -E 'pulls/12/files' "$GH_LOG" || true)
check 'the file list is read with --paginate' yes "$(grep -q -- '--paginate' <<<"$files_calls" && echo yes || echo no)"
many[139]=.github/workflows/late.yml
reset_fixtures
comments
cloud_pass
pull_json someone/fork 150
files_json "${many[@]}"
run run 12
check 'another repo, a workflow change on the second page: fails' 1 "$rc"
check 'and lists it' yes "$(has "$out" 'changed: ".github/workflows/late.yml"')"

many=()
for i in $(seq 1 25); do many+=("scripts/s-$i.sh"); done
reset_fixtures
comments
pull_json someone/fork 25
files_json "${many[@]}"
run run 12
check 'a long path list is cut at 20' yes "$(has "$out" '...and 5 more')"

for f in pull commit runs statuses checkruns events labels files comments; do
  reset_fixtures
  FAKE_FAIL=$f run run 12
  check "an unreadable $f fails closed with exit 2" 2 "$rc"
done
FAKE_FAIL=

reset_fixtures
REQUIRED_CHECKS=$tmp/missing.json run run 12
check 'a missing required-checks file is exit 2' 2 "$rc"

reset_fixtures
run payload 12
check 'payload mode prints JSON with the head' "$H" "$(jq -r .head <<<"$out" 2>/dev/null)"
check 'the payload carries the head-seen time' 2026-11-23T10:01:00Z "$(jq -r .headSeenAt <<<"$out" 2>/dev/null)"
check 'it makes no write call' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"
reset_fixtures
run run 12
check 'run mode makes no write call either' no "$(grep -qE -- '-X|--method|-f |--field|--input' "$GH_LOG" && echo yes || echo no)"

run
check 'no arguments is a usage error' 2 "$rc"
run run 0
check 'PR 0 is a usage error' 2 "$rc"
run run 12 13
check 'two PR numbers is a usage error' 2 "$rc"

echo "pr-gates-check fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
