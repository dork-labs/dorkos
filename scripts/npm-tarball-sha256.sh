#!/usr/bin/env bash
# Print the sha256 of the published `dorkos` npm tarball, but only after
# proving the download IS that tarball (DOR-4161).
#
# WHY. In 0.135.5 npm's CDN served a cached HTML 404 for the plain tarball
# URL, and `curl -sL | shasum` turned the 404 page into the Homebrew formula's
# checksum for about 20 minutes. This script refuses to hash anything it has
# not checked three ways, in order:
#
#   1. `curl -f`: an HTTP error status fails the download, never feeds a hash.
#   2. gzip: the file must be a valid gzip stream (`gzip -t`). An HTML page,
#      or a truncated download, stops here.
#   3. npm's own record: the file's sha512 must equal `dist.integrity` from
#      `npm view dorkos@<version> dist.integrity`. A valid gzip with the wrong
#      contents (a stale or substituted tarball) stops here.
#
# Only then does it print the sha256 the formula needs, on stdout, alone.
#
# Usage:
#   scripts/npm-tarball-sha256.sh <version>
#
#   <version>  Required. The bare semver, e.g. 0.135.6.
#
# Exits 0 and prints the sha256 on success. Exits 1 with a `::error::` line on
# stderr on any failure, printing nothing on stdout.
#
# It never runs a package or installs anything. scripts/test-npm-tarball-sha256.sh
# stubs `curl` and `npm` on PATH to exercise every refusal without the network.

set -uo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

fail() {
  echo "::error::$1" >&2
  exit 1
}

url="https://registry.npmjs.org/dorkos/-/dorkos-${VERSION}.tgz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
file="$work/dorkos.tgz"

# 1. The plain URL, failing on any HTTP error status.
if ! curl -fsSL --max-time 300 -o "$file" "$url"; then
  fail "couldn't download ${url}; refusing to hash it"
fi

# 2. It must be gzip. An HTML 404 page served with a 200 still stops here.
if ! gzip -t "$file" 2>/dev/null; then
  fail "the download from ${url} isn't a gzip file; refusing to hash it"
fi

# 3. It must be the tarball npm recorded for this version.
expected=$(npm view "dorkos@${VERSION}" dist.integrity 2>/dev/null)
case "$expected" in
  sha512-*) ;;
  *) fail "npm has no sha512 integrity for dorkos@${VERSION}; refusing to hash" ;;
esac
actual="sha512-$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)"
if [ "$actual" != "$expected" ]; then
  fail "the download from ${url} doesn't match npm's dist.integrity for dorkos@${VERSION}"
fi

shasum -a 256 "$file" | cut -d ' ' -f 1
