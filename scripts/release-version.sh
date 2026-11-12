#!/usr/bin/env bash
# Turn a release tag into the bare version a release job may use, or refuse it
# (DOR-4175).
#
# WHY. The Docker jobs take their version from the pushed tag name, and a tag
# name is whatever the person who pushed it typed. A tag like `v1$(id)` or one
# with a newline in it must never reach a command line, a registry path or
# `$GITHUB_OUTPUT`. This script checks the whole string against strict semver
# first, so every later step only ever sees a plain version.
#
# Usage:
#   scripts/release-version.sh <tag>
#
#   <tag>  Required. The tag name, e.g. v0.135.6. One leading `v` is dropped.
#
# Prints the bare version (e.g. 0.135.6) on stdout and exits 0. Exits 1 with a
# `::error::` line on stderr, and nothing on stdout, for anything else. It
# never evaluates the tag: scripts/test-release-version.sh proves a `$(...)` in
# it doesn't run.

set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

VERSION="${TAG#v}"

# Whole-string semver (major.minor.patch, optional dot-separated prerelease),
# no leading zeros. Bash's =~ anchors $ at the end of the string, not a line.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
# The refusal never echoes the tag: a newline in it could start a workflow
# command (`::...::`) of its own in the job log.
if ! [[ "$VERSION" =~ $semver ]]; then
  echo "::error::the tag isn't a release tag like v0.135.6; refusing it" >&2
  exit 1
fi

printf '%s\n' "$VERSION"
