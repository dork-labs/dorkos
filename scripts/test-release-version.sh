#!/usr/bin/env bash
# Fixture suite for scripts/release-version.sh and its use in
# .github/workflows/publish-docker.yml and update-homebrew.yml (DOR-4175).
#
# A pushed tag name is untrusted text. This suite feeds the script tags that
# try to run a command (`v1$(touch ...)`, backticks, `;`), escape a path, or
# smuggle a second line, and checks each is refused with nothing on stdout and
# that the command inside never ran. It then checks the workflows themselves:
# every job gets its version from this script before anything else uses it,
# no `run:` block expands `${{ }}` into the shell, and the real version steps,
# run as written, refuse a bad tag or input with nothing in $GITHUB_OUTPUT.
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
if [ "$rc" -eq 1 ] && grep <<<"$out" -q '^usage:'; then ok; else bad "missing tag: rc=$rc out=$out"; fi

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
  if [ "$rc" -eq 1 ] && [ -z "$out" ] && grep <<<"$err" -q '::error::'; then ok; else bad "tag '$tag': rc=$rc out=$out err=$err"; fi
  if [ -e "$marker" ]; then bad "tag '$tag': the command inside it ran"; else ok; fi
done

# Case 4: other tags that aren't a plain release.
for tag in 'main' 'v1.2' 'v1.2.3.4' 'v01.2.3' 'vv1.2.3' 'v1.2.3/../x' 'v1.2.3 ' 'v1.2.3-' 'v1.2.3+build' $'v1.2.3\n::warning::x'; do
  run "$tag"
  if [ "$rc" -eq 1 ] && [ -z "$out" ] && grep <<<"$err" -q '::error::'; then ok; else bad "tag '$tag': rc=$rc out=$out err=$err"; fi
done

# Case 5: the refusal never echoes the tag, so a second line can't become a
# workflow command of its own.
run $'v1.2.3\n::warning::injected'
if grep <<<"$err" -q 'injected'; then bad "refusal echoed the tag: $err"; else ok; fi

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

# Case 7: no run: block in either release workflow expands ${{ }} into the
# shell. Values go through env: instead.
HOMEBREW="${HOMEBREW:-$repo_root/.github/workflows/update-homebrew.yml}"
expanded=$(awk '
  FNR == 1 { inrun = 0 }
  /^ *run: *[|>]/ { inrun = 1; ind = match($0, /[^ ]/); next }
  inrun && NF && match($0, /[^ ]/) <= ind { inrun = 0 }
  /^ *run:/ && /\$\{\{/ { print FILENAME ":" FNR ": " $0 }
  inrun && /\$\{\{/ { print FILENAME ":" FNR ": " $0 }
' "$WORKFLOW" "$HOMEBREW")
if [ -z "$expanded" ]; then ok; else bad "workflow: \${{ }} inside run:: $expanded"; fi

# step_body <workflow> <step name>: print the first step's `run: |` block with
# its indent removed, so the fixtures below run the real step text.
step_body() {
  awk -v want="- name: $2" '
    index($0, want) && !found { found = 1; next }
    found && !inrun && /^ *run: *\|/ { inrun = 1; ind = match($0, /[^ ]/); next }
    found && inrun {
      if (NF && match($0, /[^ ]/) <= ind) exit
      print substr($0, ind + 2)
    }
  ' "$1"
}

# run_step <workflow> <step name> [VAR=value...]: run that step's body from the
# repo root under bash -e, as the runner does, with a fresh $GITHUB_OUTPUT and
# a stub `npm` on PATH. Sets rc, out (the $GITHUB_OUTPUT contents) and err.
printf '#!/usr/bin/env bash\necho 4.5.6\n' >"$work/npm"
chmod +x "$work/npm"
run_step() {
  local wf="$1" name="$2"
  shift 2
  step_body "$wf" "$name" >"$work/step.sh"
  : >"$work/output"
  (cd "$repo_root" && env -i PATH="$work:$PATH" GITHUB_OUTPUT="$work/output" "$@" \
    bash -e "$work/step.sh" >/dev/null 2>"$work/err")
  rc=$?
  out=$(cat "$work/output")
  err=$(cat "$work/err")
}

# Case 8: publish-docker's real extract step refuses a command-carrying tag
# before the command runs, and writes nothing to $GITHUB_OUTPUT.
rm -f "$marker"
run_step "$WORKFLOW" "Extract version from tag" GITHUB_REF_NAME="v1\$(touch $marker)"
if [ "$rc" -ne 0 ] && [ -z "$out" ] && [ ! -e "$marker" ]; then ok; else bad "docker step, v1\$(...): rc=$rc out=$out err=$err"; fi
run_step "$WORKFLOW" "Extract version from tag" GITHUB_REF_NAME=v1.2.3
if [ "$rc" -eq 0 ] && [ "$out" = "version=1.2.3" ]; then ok; else bad "docker step, v1.2.3: rc=$rc out=$out err=$err"; fi

# Case 9: update-homebrew's real "Get version" step routes the tag, the
# release tag and the manual input through the check. A bad value is refused
# with nothing written to $GITHUB_OUTPUT.
for args in \
  "GITHUB_EVENT_NAME=push|GITHUB_REF_NAME=v1.2.3|version=1.2.3" \
  "GITHUB_EVENT_NAME=release|RELEASE_TAG=v1.2.3-rc.1|version=1.2.3-rc.1" \
  "GITHUB_EVENT_NAME=workflow_dispatch|INPUT_VERSION=1.2.3|version=1.2.3" \
  "GITHUB_EVENT_NAME=workflow_dispatch|INPUT_VERSION=|version=4.5.6"; do
  IFS='|' read -r ev var want <<<"$args"
  run_step "$HOMEBREW" "Get version" "$ev" "$var"
  if [ "$rc" -eq 0 ] && [ "$out" = "$want" ]; then ok; else bad "homebrew step, $ev $var: rc=$rc out=$out err=$err"; fi
done
for bad_case in \
  "GITHUB_EVENT_NAME=push|GITHUB_REF_NAME=v1\$(touch $marker)" \
  "GITHUB_EVENT_NAME=release|RELEASE_TAG=main"; do
  IFS='|' read -r ev var <<<"$bad_case"
  rm -f "$marker"
  run_step "$HOMEBREW" "Get version" "$ev" "$var"
  if [ "$rc" -ne 0 ] && [ -z "$out" ] && [ ! -e "$marker" ]; then ok; else bad "homebrew step, $ev $var: rc=$rc out=$out err=$err"; fi
done
run_step "$HOMEBREW" "Get version" GITHUB_EVENT_NAME=workflow_dispatch $'INPUT_VERSION=1.2.3\nversion=6.6.6'
if [ "$rc" -ne 0 ] && [ -z "$out" ]; then ok; else bad "homebrew step, input with a newline: rc=$rc out=$out err=$err"; fi
if grep <<<"$err" -q '6.6.6'; then bad "homebrew step echoed the bad input: $err"; else ok; fi

echo
echo "release-version fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
