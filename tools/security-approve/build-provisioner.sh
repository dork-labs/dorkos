#!/bin/sh
set -eu
out=${1:?Usage: build-provisioner.sh /absolute/output/provision}
case "$out" in /*) ;; *) exit 1;; esac
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
obj=$(mktemp -d /tmp/dorkos-exact-acl.XXXXXX)
trap 'rm -rf "$obj"' EXIT
xcrun clang -Wno-deprecated-declarations -c "$here/ExactAccess.c" -o "$obj/ExactAccess.o"
xcrun swiftc -parse-as-library -O -import-objc-header "$here/ExactAccess.h" "$here/Approval.swift" "$here/Keychain.swift" "$here/HelperPolicy.swift" "$here/Provision.swift" "$obj/ExactAccess.o" -o "$out"
