#!/bin/sh
# Builds only; signing and Keychain provisioning belong to Dorian.
set -eu
out=${1:?Usage: build.sh /absolute/output/security-approve}
case "$out" in /*) ;; *) echo 'Output must be absolute' >&2; exit 1;; esac
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
xcrun swiftc -parse-as-library -O "$here/Approval.swift" "$here/Keychain.swift" "$here/Main.swift" -o "$out"
