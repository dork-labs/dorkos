#!/usr/bin/env bash
# Fixture suite for scripts/npm-tarball-sha256.sh (DOR-4161): the Homebrew
# formula's checksum must only ever come from the real npm tarball.
#
# In 0.135.5 the formula shipped the sha256 of npm's cached HTML 404 page. This
# suite feeds the script exactly that, plus a valid gzip with the wrong
# contents, and checks each is refused with nothing on stdout. It never calls
# the real `npm`, `curl` or the registry: stubs for both go first on PATH.
#
#   bash scripts/test-npm-tarball-sha256.sh
#   CHECK=/path/to/other.sh bash scripts/test-npm-tarball-sha256.sh

set -uo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CHECK="${CHECK:-$repo_root/scripts/npm-tarball-sha256.sh}"

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  printf 'FAIL  %s\n' "$1"
}

fixtures=$(mktemp -d)
trap 'rm -rf "$fixtures"' EXIT

# The real tarball, another valid gzip, and npm's HTML 404 page.
printf 'made-up dorkos package contents\n' | gzip -c >"$fixtures/real.tgz"
printf 'some other package entirely\n' | gzip -c >"$fixtures/other.tgz"
printf '<html><body><h1>404 Not Found</h1></body></html>\n' >"$fixtures/404.html"
integrity_of() { printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"; }
real_integrity=$(integrity_of "$fixtures/real.tgz")
real_sha256=$(shasum -a 256 "$fixtures/real.tgz" | cut -d ' ' -f 1)

# Stubs: `curl` copies BODY to its -o path and exits CURL_EXIT; `npm` prints
# INTEGRITY for `npm view ... dist.integrity`.
stub_dir="$fixtures/bin"
mkdir -p "$stub_dir"
cat >"$stub_dir/curl" <<'EOF'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
[ -n "$out" ] && [ -n "${BODY:-}" ] && cp "$BODY" "$out"
exit "${CURL_EXIT:-0}"
EOF
cat >"$stub_dir/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${INTEGRITY:-}"
EOF
chmod +x "$stub_dir/curl" "$stub_dir/npm"

# run <body> <curl-exit> <integrity>: sets rc, out (stdout) and err (stderr).
run() {
  local errfile="$fixtures/err"
  out=$(PATH="$stub_dir:$PATH" BODY="$1" CURL_EXIT="$2" INTEGRITY="$3" "$CHECK" 9.9.9 2>"$errfile")
  rc=$?
  err=$(cat "$errfile")
}

# refused <name>: exit 1, a ::error:: line, and nothing on stdout to hash.
refused() {
  if [ "$rc" -eq 1 ] && [ -z "$out" ] && printf '%s' "$err" | grep -q '::error::'; then
    ok
  else
    bad "$1: expected exit 1, empty stdout and ::error::, got rc=$rc out=$out err=$err"
  fi
}

# Case 1: no version argument.
out=$("$CHECK" 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q '^usage:'; then ok; else bad "missing version: rc=$rc out=$out"; fi

# Case 2: the CDN answers 404, so `curl -f` fails.
run "$fixtures/404.html" 22 "$real_integrity"
refused "http 404"

# Case 3: an HTML 404 page served with a success status: not gzip.
run "$fixtures/404.html" 0 "$real_integrity"
refused "html 404 body"
if printf '%s' "$err" | grep -q "isn't a gzip file"; then ok; else bad "html 404 body: wrong reason: $err"; fi

# Case 4: a valid gzip with the wrong contents: integrity mismatch.
run "$fixtures/other.tgz" 0 "$real_integrity"
refused "wrong gzip"
if printf '%s' "$err" | grep -q "doesn't match npm's dist.integrity"; then ok; else bad "wrong gzip: wrong reason: $err"; fi

# Case 5: npm gives no sha512 integrity.
run "$fixtures/real.tgz" 0 ""
refused "no integrity"

# Case 6: the real tarball: prints its sha256 and nothing else.
run "$fixtures/real.tgz" 0 "$real_integrity"
if [ "$rc" -eq 0 ] && [ "$out" = "$real_sha256" ]; then ok; else bad "real tarball: rc=$rc out=$out err=$err"; fi

echo
echo "npm-tarball-sha256 fixtures: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
