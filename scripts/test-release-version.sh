#!/usr/bin/env bash
# Fixture suite for scripts/release-version.sh and its use in
# .github/workflows/publish-docker.yml (DOR-4175).
#
# A pushed tag name is untrusted text. This suite feeds the script tags that
# try to run a command (`v1$(touch ...)`, backticks, `;`), escape a path, or
# smuggle a second line, and checks each is refused with nothing on stdout and
# that the command inside never ran. It then checks the workflow itself: every
# job gets its version from this script before anything else uses it, and no
# `run:` block expands `${{ }}` into the shell.
#
#   bash scripts/test-release-version.sh
#   CHECK=/path/to/other.sh bash scripts/test-release-version.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/release-version.sh}"
WORKFLOW="${WORKFLOW:-$repo_root/.github/workflows/publish-docker.yml}"

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
marker="$work/ran"

# run <tag>: sets rc, out (stdout) and err (stderr).
run() {
  out=$("$CHECK" "$1" 2>"$work/err")
  rc=$?
  err=$(cat "$work/err")
}

# Case 1: no tag.
out=$("$CHECK" 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '^usage:'; then ok; else bad "missing tag: rc=$rc out=$out"; fi

# Case 2: plain release tags give the bare version.
for pair in 'v0.135.6=0.135.6' 'v1.2.3-rc.1=1.2.3-rc.1' '0.1.0=0.1.0'; do
  run "${pair%%=*}"
  if [ "$rc" -eq 0 ] && [ "$out" = "${pair#*=}" ]; then ok; else bad "tag ${pair%%=*}: rc=$rc out=$out err=$err"; fi
done

# Case 3: tags that try to run a command. Refused, nothing on stdout, and the
# command inside never ran.
# shellcheck disable=SC2016 # these must stay literal: they are the attack
for tag in 'v1$(touch '"$marker"')' 'v1.2.3$(touch '"$marker"')' 'v1.2.3`touch '"$marker"'`' 'v1.2.3;touch '"$marker"; do
  rm -f "$marker"
  run "$tag"
  if [ "$rc" -eq 1 ] && [ -z "$out" ] && printf '%s' "$err" | grep -q '::error::'; then ok; else bad "tag '$tag': rc=$rc out=$out err=$err"; fi
  if [ -e "$marker" ]; then bad "tag '$tag': the command inside it ran"; else ok; fi
done

# Case 4: other tags that aren't a plain release.
for tag in 'main' 'v1.2' 'v1.2.3.4' 'v01.2.3' 'vv1.2.3' 'v1.2.3/../x' 'v1.2.3 ' 'v1.2.3-' 'v1.2.3+build' $'v1.2.3\n::warning::x'; do
  run "$tag"
  if [ "$rc" -eq 1 ] && [ -z "$out" ] && printf '%s' "$err" | grep -q '::error::'; then ok; else bad "tag '$tag': rc=$rc out=$out err=$err"; fi
done

# Case 5: the refusal never echoes the tag, so a second line can't become a
# workflow command of its own.
run $'v1.2.3\n::warning::injected'
if printf '%s' "$err" | grep -q 'injected'; then bad "refusal echoed the tag: $err"; else ok; fi

# Case 6: in the workflow, every "Extract version from tag" step gets its
# version from release-version.sh.
extracts=$(grep -c 'name: Extract version from tag' "$WORKFLOW")
# shellcheck disable=SC2016 # the literal step text, not an expansion
checked=$(grep -c 'bash scripts/release-version.sh "\$GITHUB_REF_NAME"' "$WORKFLOW")
if [ "$extracts" -gt 0 ] && [ "$extracts" -eq "$checked" ]; then
  ok
else
  bad "workflow: $extracts version steps, $checked use release-version.sh"
fi

# Case 7: no run: block in the workflow expands ${{ }} into the shell. Values
# go through env: instead.
expanded=$(awk '
  /^ *run: *[|>]/ { inrun = 1; ind = match($0, /[^ ]/); next }
  inrun && NF && match($0, /[^ ]/) <= ind { inrun = 0 }
  /^ *run:/ && /\$\{\{/ { print FNR ": " $0 }
  inrun && /\$\{\{/ { print FNR ": " $0 }
' "$WORKFLOW")
if [ -z "$expanded" ]; then ok; else bad "workflow: \${{ }} inside run:: $expanded"; fi

echo
echo "release-version fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
