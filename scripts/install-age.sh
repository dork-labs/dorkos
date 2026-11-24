#!/usr/bin/env bash
# install-age.sh — put a pinned, checksum-verified `age` and `age-keygen` in a directory.
#
#   scripts/install-age.sh <dest-dir>
#
# Used by the review workflow to encrypt a failing Security lens's details to
# Security's key (scripts/security-findings.sh post), and by scripts-test to run
# scripts/test-security-findings.sh against the real tool. One pin, one place.
#
# The tarball's SHA-256 must match the value below before anything is unpacked.
# To bump: download the new release's tarballs, compare `shasum -a 256` with the
# `digest` GitHub lists for each asset (gh api repos/FiloSottile/age/releases/tags/<tag>),
# and update VERSION and both sums together.
#
# Exit codes: 0 installed; 1 download or checksum failure; 2 usage or an
# unsupported platform.
set -euo pipefail

VERSION=v1.3.2
dest=${1:-}
[ $# -eq 1 ] && [ -n "$dest" ] || {
  echo "usage: install-age.sh <dest-dir>" >&2
  exit 2
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=linux-amd64 sum=cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10 ;;
  Linux-aarch64 | Linux-arm64) arch=linux-arm64 sum=6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4 ;;
  *)
    echo "install-age: no pinned age build for $(uname -s)-$(uname -m); install age yourself" >&2
    exit 2
    ;;
esac

tarball=age-$VERSION-$arch.tar.gz
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "$work/$tarball" \
  "https://github.com/FiloSottile/age/releases/download/$VERSION/$tarball" || {
  echo "install-age: could not download $tarball" >&2
  exit 1
}
echo "$sum  $work/$tarball" | sha256sum -c --quiet - || {
  echo "install-age: $tarball does not match its pinned SHA-256; refusing to install it" >&2
  exit 1
}

mkdir -p "$dest"
tar -xzf "$work/$tarball" -C "$work" age/age age/age-keygen
install -m 0755 "$work/age/age" "$work/age/age-keygen" "$dest/"
echo "Installed age $VERSION ($arch) in $dest"
