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
xcrun swiftc -parse-as-library "$here/Approval.swift" "$here/tests/CoreTests.swift" -o "$tmp/core-tests"
"$tmp/core-tests"
"$here/tests/test-policy.sh"
"$here/build.sh" "$tmp/security-approve" >"$tmp/build.log" 2>&1
"$here/build-provisioner.sh" "$tmp/provision" >"$tmp/provision-build.log" 2>&1
if "$tmp/security-approve" 12 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$tmp/result" 2>&1; then
  echo 'FAIL: placeholder identity accepted' >&2; exit 1
fi
grep -q 'not provisioned' "$tmp/result"
"$here/tests/test-keychain.sh"

"$here/tests/test-keychain.sh" certificate
