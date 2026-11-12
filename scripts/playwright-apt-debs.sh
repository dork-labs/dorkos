#!/usr/bin/env bash
# Install the Chromium browser and the OS packages Playwright needs, without
# asking an Ubuntu server for anything when the packages are already cached.
#
# WHY THIS EXISTS. browser-test.yml's jobs installed Chromium's OS packages with
# `playwright install --with-deps` / `install-deps`, which is `apt-get update`
# plus `apt-get install`: every run asked archive.ubuntu.com and
# security.ubuntu.com for ~13 MB of indexes and ~21 MB of fonts. On 2026-11-09
# and 2026-11-11 those hosts timed out or crawled, and 45 browser jobs failed in
# that one step without reaching a test (QA's CI shared-cause report, cause C2;
# ledger 261112-190000-browser-test-apt-cache). The Azure mirror is no fallback:
# on Nov 11 it failed to resolve too (ledger 261111-163545).
#
# HOW. The runner image ships apt lists, verified against Ubuntu's archive key
# when the image was built. From them, with no network:
#   plan     `playwright install-deps --dry-run` names the missing packages
#            (it simulates `apt-get install -s` against those lists), and
#            `apt-cache show` gives each one's exact version, size and SHA256
#            from the signed index. `apt-get install --print-uris` must agree
#            on the file names and sizes. The cache key is a hash of that
#            manifest, so a new package version is a new key.
#   install  On a cache hit, every .deb is checked against the manifest's hash
#            and then installed by `apt-get install --no-download`, which
#            checks each one again against the image's signed index and
#            refuses to fetch anything. No `apt-get update`, no `dpkg -i`.
#            On a miss, `apt-get install --download-only` fetches exactly the
#            manifest's files (still no `apt-get update`), and they are checked
#            and installed the same way, so what a scheduled run saves is
#            byte for byte what it installed. If that download fails too, it
#            falls back to the old path, `playwright install-deps`.
#
# THE CACHE IS SAVED ONLY BY A SCHEDULED RUN ON MAIN (browser-test.yml's save
# step says so in its `if:`). Pull requests restore it and never save it, so a
# fork cannot plant a package that main later installs; and the hash checks
# above would refuse one anyway.
#
# Usage:
#   playwright-apt-debs.sh plan <dry-run-output-file> <work-dir>
#       Writes <work-dir>/packages.txt and manifest.txt. Appends to
#       $GITHUB_OUTPUT: mode=none (nothing missing), mode=cache (a manifest and
#       key=...), or mode=fallback (the dry run or the lists could not be read;
#       install takes the old path). Exits 0 in every one of those cases.
#   playwright-apt-debs.sh install <work-dir>
#       Reads env BROWSER_CACHE_HIT, APT_MODE, APT_CACHE_HIT. Two attempts.
#       Appends debs-ready=true to $GITHUB_OUTPUT when <work-dir>/debs holds
#       a checked copy of every file in the manifest (what the save step saves).
#
# Pinned by scripts/__tests__/playwright-apt-debs.test.ts.

set -euo pipefail

output() {
  echo "$1" >>"${GITHUB_OUTPUT:-/dev/null}"
}

# Read `playwright install-deps --dry-run chromium` (Playwright >= 1.6x): either
# "All system dependencies are installed." or "Missing system dependencies (N):"
# followed by N lines of "  <package>". Anything else is not understood.
parse_dry_run() {
  local file=$1
  if grep -qx 'All system dependencies are installed.' "$file"; then
    return 0
  fi
  local header count
  header=$(grep -E '^Missing system dependencies \([0-9]+\):$' "$file" | head -1) || return 1
  count=$(sed -E 's/^Missing system dependencies \(([0-9]+)\):$/\1/' <<<"$header")
  local packages
  packages=$(sed -n '/^Missing system dependencies (/,$p' "$file" | sed -n -E 's/^  ([a-z0-9][a-z0-9+.-]+)$/\1/p')
  [ "$(grep -c . <<<"$packages")" = "$count" ] || return 1
  printf '%s\n' "$packages"
}

plan() {
  local dry_run=$1 work=$2
  mkdir -p "$work"
  local packages
  if ! packages=$(parse_dry_run "$dry_run"); then
    echo "::warning::Could not read Playwright's dependency dry run; installing OS packages the old way (apt-get update)." >&2
    sed 's/^/  dry run: /' "$dry_run" >&2 || true
    output mode=fallback
    return 0
  fi
  if [ -z "$packages" ]; then
    echo 'Playwright reports every OS package Chromium needs is already installed.'
    : >"$work/packages.txt"
    output mode=none
    return 0
  fi
  printf '%s\n' "$packages" >"$work/packages.txt"

  # The manifest: one line per package, "name_version_arch.deb size SHA256:hex",
  # from `apt-cache show`, which reads the image's lists (no network) and gives
  # the strong hash the signed index carries. The file name is the one apt
  # stores in its archive dir, the version's epoch colon written as %3a.
  : >"$work/manifest.txt"
  local pkg record version arch size sha
  while read -r pkg; do
    if ! record=$(apt-cache show --no-all-versions "$pkg" 2>/dev/null); then
      echo "::warning::apt-cache has no record of $pkg in the image's lists; installing the OS packages the old way." >&2
      output mode=fallback
      return 0
    fi
    version=$(awk '/^Version: /{print $2; exit}' <<<"$record")
    arch=$(awk '/^Architecture: /{print $2; exit}' <<<"$record")
    size=$(awk '/^Size: /{print $2; exit}' <<<"$record")
    sha=$(awk '/^SHA256: /{print $2; exit}' <<<"$record")
    if [ -z "$version" ] || [ -z "$arch" ] || [ -z "$size" ] || ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
      echo "::warning::The image's lists give $pkg no version, size or SHA256; installing the OS packages the old way." >&2
      output mode=fallback
      return 0
    fi
    echo "${pkg}_${version//:/%3a}_${arch}.deb ${size} SHA256:${sha}" >>"$work/manifest.txt"
  done <"$work/packages.txt"
  LC_ALL=C sort -o "$work/manifest.txt" "$work/manifest.txt"

  # Cross-check: what apt would actually fetch, from the same lists, is exactly
  # these files at these sizes. Each --print-uris line is
  # 'URI' name_version_arch.deb size HASHTYPE:hex; on Ubuntu 24.04 that hash is
  # an MD5, which is why the manifest takes its hash from apt-cache instead.
  local scratch uris
  scratch=$(mktemp -d)
  sudo mkdir -p "$scratch/partial"
  # shellcheck disable=SC2046 # one package name per word, by construction
  if ! uris=$(sudo apt-get install --print-uris --no-install-recommends \
    -o Dir::Cache::archives="$scratch/" $(cat "$work/packages.txt")); then
    sudo rm -rf "$scratch"
    echo "::warning::apt could not resolve Chromium's packages from the image's lists; installing them the old way." >&2
    output mode=fallback
    return 0
  fi
  sudo rm -rf "$scratch"
  local fetch want
  fetch=$(grep -E "^'[^']+' [^ ]+\.deb [0-9]+ [A-Za-z0-9]+:[0-9a-f]+$" <<<"$uris" \
    | awk '{print $2, $3}' | LC_ALL=C sort || true)
  if [ "$fetch" != "$(awk '{print $1, $2}' "$work/manifest.txt")" ]; then
    echo "::warning::apt would fetch different files than the image's lists name for Chromium's packages; installing them the old way." >&2
    printf '  apt would fetch: %s\n' "$fetch" >&2
    output mode=fallback
    return 0
  fi
  want=$(grep -c . "$work/manifest.txt")
  local digest
  digest=$(sha256sum "$work/manifest.txt" | cut -c1-64)
  echo "Chromium needs $want OS packages; manifest:"
  sed 's/^/  /' "$work/manifest.txt"
  output mode=cache
  output "key=playwright-apt-v1-${ImageOS:?ImageOS is not set on this runner}-$(uname -m)-${digest}"
}

# Every manifest file is present in <debs> and matches its hash. apt checks
# them again against the signed index; this check is ours, and names the file.
verify_debs() {
  local work=$1 debs=$1/debs
  local file size hash algo hex tool
  while read -r file size hash; do
    algo=${hash%%:*}
    hex=${hash#*:}
    case "$algo" in
      SHA256) tool=sha256sum ;;
      SHA512) tool=sha512sum ;;
      *)
        echo "::warning::$file: unsupported hash type $algo in the manifest." >&2
        return 1
        ;;
    esac
    if [ ! -f "$debs/$file" ]; then
      echo "::warning::$file is not in the restored packages." >&2
      return 1
    fi
    if [ "$(wc -c <"$debs/$file" | tr -d ' ')" != "$size" ] \
      || [ "$("$tool" "$debs/$file" | cut -d' ' -f1)" != "$hex" ]; then
      echo "::warning::$file does not match the hash in the image's apt lists." >&2
      return 1
    fi
  done <"$work/manifest.txt"
}

# apt writes partial/ and lock as root; leave the directory readable by the
# runner user so actions/cache can save it, and holding only the .deb files.
tidy_debs() {
  local debs=$1/debs
  sudo rm -rf "$debs/partial" "$debs/lock"
  sudo chown -R "$(id -u):$(id -g)" "$debs"
}

apt_local() {
  local work=$1 mode=$2
  local debs=$work/debs
  sudo mkdir -p "$debs/partial"
  # shellcheck disable=SC2046 # one package name per word, by construction
  sudo apt-get install -y -qq --no-install-recommends "$mode" \
    -o Dir::Cache::archives="$debs/" $(cat "$work/packages.txt")
}

install_deps() {
  local work=$1
  case "${APT_MODE:-fallback}" in
    none)
      echo 'No OS packages to install.'
      return 0
      ;;
    cache)
      if [ "${APT_CACHE_HIT:-}" = 'true' ]; then
        if verify_debs "$work" && apt_local "$work" --no-download; then
          tidy_debs "$work"
          echo 'Installed the OS packages from the cache; no Ubuntu server was contacted.'
          output debs-ready=true
          return 0
        fi
        echo '::warning::The cached OS packages could not be used; downloading them.' >&2
        sudo rm -rf "$work/debs"
      fi
      if apt_local "$work" --download-only && tidy_debs "$work" && verify_debs "$work" \
        && apt_local "$work" --no-download; then
        tidy_debs "$work"
        echo 'Downloaded and installed the OS packages without apt-get update.'
        output debs-ready=true
        return 0
      fi
      echo '::warning::Downloading the OS packages failed; installing them the old way (apt-get update).' >&2
      ;;
  esac
  pnpm --filter @dorkos/e2e exec playwright install-deps chromium
}

install_once() {
  local work=$1
  if [ "${BROWSER_CACHE_HIT:-}" != 'true' ]; then
    pnpm --filter @dorkos/e2e exec playwright install chromium || return 1
  fi
  install_deps "$work"
}

install() {
  local work=$1
  mkdir -p "$work"
  local attempt
  for attempt in 1 2; do
    if install_once "$work"; then
      return 0
    fi
    if [ "$attempt" = 1 ]; then
      echo 'playwright install attempt 1 failed; retrying once' >&2
      sleep "${RETRY_SLEEP:-15}"
    fi
  done
  return 1
}

subcommand=${1:-}
shift || true
case "$subcommand" in
  plan) plan "$@" ;;
  install) install "$@" ;;
  *)
    echo 'usage: playwright-apt-debs.sh plan <dry-run-output> <work-dir> | install <work-dir>' >&2
    exit 2
    ;;
esac
