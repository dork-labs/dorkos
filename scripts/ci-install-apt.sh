#!/usr/bin/env bash
# Install CI tools without making every configured Ubuntu mirror a prerequisite.
# Only GitHub-hosted Ubuntu runners call this. Callers still check the real tools.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo 'Usage: ci-install-apt.sh <package> [...]' >&2
  exit 2
fi

options=(
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o Acquire::Retries=1
  -o DPkg::Lock::Timeout=30
)

# The image carries package indexes already. A refresh can fail even when the
# requested packages are resolvable (security.ubuntu.com DNS, Nov 11 2026).
if timeout --kill-after=5s 60s sudo apt-get "${options[@]}" install -y --no-install-recommends "$@"; then
  exit 0
fi

codename=$(lsb_release -cs)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# apt's unprivileged downloader must be able to read the scoped source file.
chmod 755 "$scratch"
sources="$scratch/ubuntu.sources"

# Retry through a different Ubuntu archive host if one is unavailable. Limit
# sources for these calls only: no security/third-party sources, no global edits,
# and the standard Ubuntu signing key remains mandatory.
for mirror in archive.ubuntu.com azure.archive.ubuntu.com; do
  cat > "$sources" <<EOF
Types: deb
URIs: https://$mirror/ubuntu
Suites: $codename $codename-updates
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  scoped=("${options[@]}" -o "Dir::Etc::sourcelist=$sources" -o Dir::Etc::sourceparts=-)
  if ! timeout --kill-after=5s 60s sudo apt-get "${scoped[@]}" update; then
    echo "Refresh from $mirror failed; trying available package indexes" >&2
  fi
  if timeout --kill-after=5s 60s sudo apt-get "${scoped[@]}" install -y --no-install-recommends "$@"; then
    exit 0
  fi
  echo "CI package install from $mirror failed" >&2
done

echo "Unable to install CI packages: $*" >&2
exit 1
