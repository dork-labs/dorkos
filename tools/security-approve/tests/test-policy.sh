#!/bin/sh
# Safe on the operator Mac: canned strings, a fake GitHub and private temp files only.
# Never links Keychain.swift, Main.swift or Provision.swift; no helper or Keychain API runs.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/dorkos-signature-policy.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
xcrun swiftc -parse-as-library "$here/Policy.swift" "$here/Approval.swift" "$here/HelperPolicy.swift" "$here/tests/HelperPolicyTests.swift" -o "$tmp/helper-policy-tests"
xcrun swiftc -parse-as-library "$here/Policy.swift" "$here/Approval.swift" "$here/LocalFiles.swift" "$here/tests/TestSupport.swift" "$here/tests/PolicyTests.swift" -o "$tmp/policy-tests"
xcrun swiftc -parse-as-library "$here/Policy.swift" "$here/Approval.swift" "$here/tests/TestSupport.swift" "$here/tests/CoreTests.swift" -o "$tmp/core-tests"
xcrun swiftc -parse-as-library "$here/Policy.swift" "$here/Approval.swift" "$here/tests/TestSupport.swift" "$here/tests/BatchTests.swift" -o "$tmp/batch-tests"
for suite in helper-policy-tests policy-tests core-tests batch-tests; do "$tmp/$suite"; done
"$here/tests/test-enqueue.sh"
