#!/usr/bin/env bash
# Wait for a version of `dorkos` to become fetchable from the public npm
# registry after `npm publish`.
#
# WHY 30 MINUTES. npm reliably takes 10-15 minutes to propagate a fresh
# publish of this package — dorkos is a ~19 MB tarball, well above what
# registry replication treats as instant. A 5-minute wait (the previous
# 30 attempts * 10s loop) is not generous headroom, it is short of the
# typical case: it failed on the FIRST TRY of every release from v0.63.0
# through v0.66.0, because "typical" for this package is already past
# 5 minutes. 30 minutes is 2-3x the observed propagation time — enough
# headroom to absorb a slow day without masking a genuinely stuck publish
# (wrong version tagged, npm outage, auth failure upstream) behind an
# hours-long hang.
#
# WHY THIS IS ITS OWN SCRIPT. `.github/workflows/publish-docker.yml` and
# `.github/workflows/update-homebrew.yml` each carried their own copy of
# the undersized wait loop (DOR-1606) — copy-pasted, so it failed the
# same way twice, in the same release, every release. One script, used by
# both, means the fix (and the next fix) only has to happen once.
#
# Usage:
#   scripts/wait-for-npm.sh <version> [timeout-minutes]
#
#   <version>          Required. The bare semver, e.g. 0.67.0 — no leading
#                       `v`, no package name.
#   [timeout-minutes]  Optional. Defaults to 30.
#
# Exits 0 once BOTH `npm view dorkos@<version> version` answers AND the plain
# tarball URL (https://registry.npmjs.org/dorkos/-/dorkos-<version>.tgz, no
# cache-busting query) answers `curl -f`. Exits 1 with a clear error once the
# timeout elapses.
#
# WHY THE TARBALL TOO (DOR-4161). In 0.135.5 the metadata answered while
# npm's CDN still served a cached 404 for the plain tarball URL. Docker needed
# three runs, and the Homebrew tap shipped a checksum of the 404 page. Every
# consumer downloads that exact plain URL, so it is the one to wait on.
#
# Polls every 30 seconds by default. Two env vars override that for
# scripts/test-wait-for-npm.sh, which stubs `npm` on PATH and needs both the
# happy path and the timeout path to run in well under a second — they are
# not meant to be set outside a test:
#   WAIT_FOR_NPM_POLL_SECONDS     poll interval in seconds (default 30)
#   WAIT_FOR_NPM_TIMEOUT_SECONDS  timeout in seconds; overrides
#                                 [timeout-minutes] entirely when set

set -euo pipefail

VERSION="${1:-}"
TIMEOUT_MINUTES="${2:-30}"

if [ -z "$VERSION" ]; then
  echo "usage: $0 <version> [timeout-minutes]" >&2
  exit 1
fi

# Whole-string semver (major.minor.patch, optional dot-separated prerelease),
# no leading zeros, checked before the version reaches a URL or `npm view`.
# The same pattern as scripts/npm-tarball-sha256.sh (DOR-4161).
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if ! [[ "$VERSION" =~ $semver ]]; then
  echo "::error::version '${VERSION}' isn't a plain semver like 0.135.6; refusing it" >&2
  exit 1
fi
if ! [[ "$TIMEOUT_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "::error::timeout '${TIMEOUT_MINUTES}' isn't a whole number of minutes" >&2
  exit 1
fi

poll_seconds="${WAIT_FOR_NPM_POLL_SECONDS:-30}"
if [ -n "${WAIT_FOR_NPM_TIMEOUT_SECONDS:-}" ]; then
  timeout_seconds="$WAIT_FOR_NPM_TIMEOUT_SECONDS"
else
  timeout_seconds=$((TIMEOUT_MINUTES * 60))
fi

package="dorkos@${VERSION}"
tarball_url="https://registry.npmjs.org/dorkos/-/dorkos-${VERSION}.tgz"
echo "Waiting for ${package} and its tarball on npm (timeout ${TIMEOUT_MINUTES}m, polling every ${poll_seconds}s)..."

start=$(date +%s)
attempt=0
while true; do
  attempt=$((attempt + 1))

  if npm view "$package" version >/dev/null 2>&1 &&
    curl -fsSIL --max-time 30 -o /dev/null "$tarball_url"; then
    elapsed=$(($(date +%s) - start))
    echo "Available after ${elapsed}s (attempt ${attempt}): ${package}"
    exit 0
  fi

  elapsed=$(($(date +%s) - start))
  if [ "$elapsed" -ge "$timeout_seconds" ]; then
    echo "::error::${package} not found on npm after ${elapsed}s (timeout ${TIMEOUT_MINUTES}m)" >&2
    exit 1
  fi

  echo "Attempt ${attempt} — not yet available after ${elapsed}s, waiting ${poll_seconds}s..."
  sleep "$poll_seconds"
done
