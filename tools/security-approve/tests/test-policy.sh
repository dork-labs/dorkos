#!/bin/sh
# Safe on the operator Mac: canned strings only. No helper or Keychain API runs.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/dorkos-signature-policy.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
xcrun swiftc -parse-as-library "$here/Approval.swift" "$here/HelperPolicy.swift" "$here/tests/HelperPolicyTests.swift" -o "$tmp/policy-tests"
"$tmp/policy-tests"
