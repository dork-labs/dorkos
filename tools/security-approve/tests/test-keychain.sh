#!/bin/bash
# Touches only its own temporary Keychain and synthetic signing-test credentials. No login items.
set -euo pipefail
# CI only: even disposable Keychains can raise a prompt in a person's session.
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_OS:-}" != macOS ]; then
  echo 'Real Keychain tests require a CI macOS runner.' >&2
  exit 1
fi
mode=${1:-adhoc}
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d /tmp/dorkos-keychain-acl.XXXXXX)
cleanup() {
  /usr/bin/security delete-keychain "$tmp/disposable.keychain-db" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
xcrun swiftc -parse-as-library "$here/Approval.swift" "$here/Keychain.swift" "$here/tests/ReadProbe.swift" -o "$tmp/allowed" 2>"$tmp/build.log"
# The second binary has the same test signing identity and identifier,
# but different code. It must not inherit the exact-hash access grant.
printf '\n// Different compiled code.\n' > "$tmp/Other.swift"
sed 's/ACL read allowed/OTHER ACL read allowed/' "$here/tests/ReadProbe.swift" >> "$tmp/Other.swift"
xcrun swiftc -parse-as-library "$here/Approval.swift" "$here/Keychain.swift" "$tmp/Other.swift" -o "$tmp/other" 2>>"$tmp/build.log"
if [ "$mode" = certificate ]; then
  # A synthetic one-day test identity, confined to this disposable Keychain.
  # These are throwaway signing-test credentials, never an App private key.
  /usr/bin/security create-keychain -p disposable-keychain-password "$tmp/disposable.keychain-db"
  cat > "$tmp/cert.cnf" <<'CONFIG'
[req]
distinguished_name=dn
x509_extensions=code
prompt=no
[dn]
CN=DorkOS disposable signing test
[code]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CONFIG
  /usr/bin/openssl req -config "$tmp/cert.cnf" -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=DorkOS disposable signing test' -keyout "$tmp/test-signing.key" -out "$tmp/test-signing.crt" >"$tmp/cert.log" 2>&1
  /usr/bin/openssl pkcs12 -export -inkey "$tmp/test-signing.key" -in "$tmp/test-signing.crt" -out "$tmp/test-signing.p12" -passout pass:disposable-signing-password >"$tmp/p12.log" 2>&1
  xcrun clang -Wno-deprecated-declarations "$here/tests/SignTestIdentity.c" -framework Security -framework CoreFoundation -o "$tmp/test-sign"
  /usr/bin/codesign --force --sign - "$tmp/test-sign"
  signing_hash=$(/usr/bin/codesign -dv --verbose=4 "$tmp/test-sign" 2>&1 | sed -n 's/^CDHash=//p')
  /usr/bin/security import "$tmp/test-signing.p12" -k "$tmp/disposable.keychain-db" -P disposable-signing-password -T "$tmp/test-sign" >"$tmp/import.log" 2>&1
  /usr/bin/security set-key-partition-list -S "cdhash:$signing_hash" -k disposable-keychain-password "$tmp/disposable.keychain-db" >"$tmp/key-partition.log" 2>&1
  for binary in allowed other; do "$tmp/test-sign" "$tmp/disposable.keychain-db" "$tmp/$binary"; done
else
  for binary in allowed other; do
    /usr/bin/codesign --force --sign - --identifier ai.dorkos.security-review-test --requirements '=designated => identifier "ai.dorkos.security-review-test"' "$tmp/$binary"
  done
fi
hash() { /usr/bin/codesign -dv --verbose=4 "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
allowed_hash=$(hash "$tmp/allowed")
other_hash=$(hash "$tmp/other")
test "$allowed_hash" != "$other_hash"
# A path/designated-requirement ACL would incorrectly accept both programs.
allowed_requirement=$(/usr/bin/codesign -dr - "$tmp/allowed" 2>&1 | sed -n '/^designated =>/p')
other_requirement=$(/usr/bin/codesign -dr - "$tmp/other" 2>&1 | sed -n '/^designated =>/p')
test -n "$allowed_requirement"
test "$allowed_requirement" = "$other_requirement"
# Real display-format proof runs only on the CI macOS user. The production
# policy refuses the existing non-runtime probe before any ACL provisioning.
xcrun swiftc -parse-as-library "$here/Approval.swift" "$here/HelperPolicy.swift" "$here/tests/RealPolicyProbe.swift" -o "$tmp/policy-probe"
if "$tmp/policy-probe" "$tmp/allowed" "$allowed_hash"; then
  echo 'FAIL: non-runtime helper accepted by provisioning policy' >&2; exit 1
fi
cp "$tmp/allowed" "$tmp/runtime"
/usr/bin/codesign --force --options runtime --sign - "$tmp/runtime"
runtime_hash=$(/usr/bin/codesign -dv --verbose=4 "$tmp/runtime" 2>&1 | sed -n 's/^CDHash=//p')
"$tmp/policy-probe" "$tmp/runtime" "$runtime_hash"
echo 'PASS: provisioning policy refuses non-runtime and accepts runtime display'
xcrun clang -Wno-deprecated-declarations "$here/ExactAccess.c" "$here/tests/CreateFixture.c" -framework Security -framework CoreFoundation -o "$tmp/create"
"$tmp/create" "$tmp/disposable.keychain-db" "$tmp/allowed" "$allowed_hash"
# Permit BOTH hashes through the additional partition gate. Only the explicit
# decrypt ACL's cdhash requirement can distinguish them in the test below.
/usr/bin/security set-generic-password-partition-list -a disposable -s ai.dorkos.security-review-test -S "cdhash:$allowed_hash,cdhash:$other_hash" -k disposable-keychain-password "$tmp/disposable.keychain-db" >"$tmp/partition.log" 2>&1 || { cat "$tmp/partition.log"; exit 1; }
"$tmp/allowed" "$tmp/disposable.keychain-db"
if "$tmp/other" "$tmp/disposable.keychain-db"; then echo 'FAIL: different binary read the item' >&2; exit 1; fi
cp "$tmp/allowed" "$tmp/stripped"
/usr/bin/codesign --remove-signature "$tmp/stripped"
if "$tmp/stripped" "$tmp/disposable.keychain-db"; then echo 'FAIL: stripped binary read the item' >&2; exit 1; fi
# Positive control after both denials: a locked/missing item is not a passing test.
"$tmp/allowed" "$tmp/disposable.keychain-db"
echo "PASS ($mode): exact cdhash allowed; same-identity different binary and stripped copy refused"
