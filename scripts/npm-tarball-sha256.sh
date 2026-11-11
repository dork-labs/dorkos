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
#   <version>  Required. The bare semver, e.g. 0.135.6. Anything that isn't a
#              whole, strict semver is refused before it reaches a URL or a
#              command line.
#
# Exits 0 and prints the sha256 on success. Exits 1 with a `::error::` line on
# stderr on any failure, printing nothing on stdout.
#
# It never runs a package or installs anything. scripts/test-npm-tarball-sha256.sh
# stubs `curl` and `npm` on PATH to exercise every refusal without the network.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

fail() {
  echo "::error::$1" >&2
  exit 1
}

# Whole-string semver (major.minor.patch, optional dot-separated prerelease),
# no leading zeros. Bash's =~ anchors $ at the end of the string, not a line.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if ! [[ "$VERSION" =~ $semver ]]; then
  fail "version '${VERSION}' isn't a plain semver like 0.135.6; refusing it"
fi

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
# Both sides are compared as hex digests, and an empty side is a failure, never
# a match: `npm view` failing, an empty or non-base64 integrity, and a hash
# that printed nothing all stop here.
if ! expected=$(npm view "dorkos@${VERSION}" dist.integrity 2>/dev/null); then
  fail "npm view failed for dorkos@${VERSION}; refusing to hash"
fi
case "$expected" in
  sha512-*) ;;
  *) fail "npm has no sha512 integrity for dorkos@${VERSION}; refusing to hash" ;;
esac
if ! expected_hex=$(printf '%s' "${expected#sha512-}" | openssl base64 -d -A | od -An -v -tx1 | tr -d ' \n'); then
  expected_hex=""
fi
if ! actual_hex=$(openssl dgst -sha512 -r "$file" | cut -d ' ' -f 1); then
  actual_hex=""
fi
if [ -z "$expected_hex" ] || [ -z "$actual_hex" ]; then
  fail "couldn't read a sha512 for dorkos@${VERSION} from npm or the download; refusing to hash"
fi
if [ "$actual_hex" != "$expected_hex" ]; then
  fail "the download from ${url} doesn't match npm's dist.integrity for dorkos@${VERSION}"
fi

sha256=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
[ -n "$sha256" ] || fail "shasum printed nothing for ${url}"
printf '%s\n' "$sha256"
