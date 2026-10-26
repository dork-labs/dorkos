#!/bin/sh
set -eu
# Never run real ACL tests in the operator's login session, even with /tmp items.
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_OS:-}" != macOS ]; then
  echo 'Real Keychain tests require a CI macOS runner. Use tests/test-policy.sh for canned local tests.' >&2
  exit 1
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/dorkos-approval-tests.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
"$here/tests/test-policy.sh"
"$here/build.sh" "$tmp/security-approve" >"$tmp/build.log" 2>&1
"$here/build-provisioner.sh" "$tmp/provision" >"$tmp/provision-build.log" 2>&1
# The CI user is not dorkos-approver and /tmp is not the pinned folder: both
# real binaries must refuse before reading arguments, a queue or a Keychain.
for run in "security-approve 12 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "security-approve --batch" \
  "provision $HOME/Library/Keychains/login.keychain-db aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; do
  # shellcheck disable=SC2086 # deliberate word splitting into program and arguments
  if "$tmp"/$run </dev/null >"$tmp/result" 2>&1; then
    echo "FAIL: accepted outside the approver user: $run" >&2; exit 1
  fi
  grep -q 'Run this as the dorkos-approver user' "$tmp/result" || { cat "$tmp/result"; exit 1; }
done
echo 'PASS: helper and provisioner refuse any user but dorkos-approver'
"$here/tests/test-keychain.sh"

"$here/tests/test-keychain.sh" certificate
