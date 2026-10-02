#!/usr/bin/env bash
# Fixtures for scripts/sweep-test-tmp.sh.
#
# Hermetic: every run points TMPDIR at a fresh fake root (marked with the
# fixture file the sweep only honours under DORKOS_TMP_SWEEP_FIXTURE_ROOT=1),
# and a stub `lsof` on PATH stands in for the machine's open-file table, so
# nothing outside the fake root is ever looked at. This sweep's failure mode is
# DELETING something, so every keep case is paired with a positive control: the
# same entry with the one protecting condition flipped, which the sweep must
# then remove. A keep case without its control could pass because the sweep
# never looked at anything.
#
# The sweep is run with /bin/bash, which on macOS is bash 3.2: that is the shell
# the launchd template runs it with, and the one a bash-4-ism would break.
set -uo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sweep="$script_dir/sweep-test-tmp.sh"
pass=0
fail=0

work="$(mktemp -d)"
cleanup() {
  # A fixture makes a folder unreadable; give it back before removing.
  chmod -R u+rwx "$work" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

# The stub lsof prints, in `-F n` field form, every path listed in
# $LSOF_STUB_OPEN (one per line). Knobs: $LSOF_STUB_FAIL makes it exit 2 with
# nothing printed; every call is logged so a fixture can prove it ran.
mkdir -p "$work/bin"
cat >"$work/bin/lsof" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$LSOF_STUB_LOG"
if [[ -n "${LSOF_STUB_FAIL:-}" ]]; then echo 'lsof: WARNING: something broke' >&2; exit 2; fi
echo p1
echo fcwd
echo n/
if [[ -s "${LSOF_STUB_OPEN:-}" ]]; then
  while IFS= read -r p; do echo f3; echo "n$p"; done <"$LSOF_STUB_OPEN"
fi
# Real lsof exits 1 for soft reasons while printing everything else.
exit "${LSOF_STUB_EXIT:-0}"
STUB
chmod +x "$work/bin/lsof"
export PATH="$work/bin:$PATH"

# An outside folder that must survive every run: symlinks point here.
outside="$work/outside"
mkdir -p "$outside/keep-me"
echo precious >"$outside/keep-me/file"

reset_root() {
  root="$work/root.$RANDOM$RANDOM"
  mkdir -p "$root"
  touch "$root/.dorkos-tmp-sweep-fixture"
  # Physical path, as the sweep resolves it (macOS mktemp hands out /var/...).
  root="$(cd -P "$root" && pwd -P)"
  : >"$work/open"
  : >"$work/lsof.log"
}

run_sweep() {
  TMPDIR="$root" DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 LSOF_STUB_OPEN="$work/open" \
    LSOF_STUB_LOG="$work/lsof.log" /bin/bash "$sweep" "$@"
}

now="$(date +%s)"
# A touch -t stamp for N hours ago, on BSD or GNU date.
stamp_hours_ago() {
  local e=$((now - $1 * 3600))
  date -r "$e" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$e" +%Y%m%d%H%M.%S
}
# Age a whole tree (contents first, so the folder's own mtime sticks).
age() { # path hours
  find "$1" -depth -exec touch -h -t "$(stamp_hours_ago "$2")" {} +
}
# An entry in the root with a little content, aged.
make_dir() { # name hours
  mkdir -p "$root/$1/sub"
  echo x >"$root/$1/sub/file"
  echo y >"$root/$1/top"
  age "$root/$1" "$2"
}
make_file() { # name hours
  echo z >"$root/$1"
  age "$root/$1" "$2"
}

present() { [[ -e "$root/$1" || -L "$root/$1" ]]; }
check() {
  if [[ "$2" == true ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1"
  fi
}
gone() { if present "$1"; then echo false; else echo true; fi; }
kept() { if present "$1"; then echo true; else echo false; fi; }
is() { if "$@"; then echo true; else echo false; fi; }

# 1. The case this exists for: an old leftover from an allowlisted test.
reset_root
make_dir srv-err-a1B2c3 48
make_file cli-err-Zz9Yy8 48
make_dir dorkos-0037-abcdef 48
make_dir dorkos-before-108-qwerty 48
make_dir smoke-e2e-no-hooks-AbCdEf 48
run_sweep >/dev/null
check "an old allowlisted folder is removed" "$(gone srv-err-a1B2c3)"
check "an old allowlisted regular file is removed" "$(gone cli-err-Zz9Yy8)"
check "a migration-number prefix is removed" "$(gone dorkos-0037-abcdef)"
check "a dorkos-before-<n> prefix is removed" "$(gone dorkos-before-108-qwerty)"
check "a smoke-e2e-<scenario> prefix is removed" "$(gone smoke-e2e-no-hooks-AbCdEf)"
check "the sweep leaves no work folder behind" "$(is test -z "$(find "$root" -mindepth 1 -maxdepth 1 -name 'dorkos-tmp-sweep.*')")"
check "the fixture marker is untouched" "$(kept .dorkos-tmp-sweep-fixture)"

# 2. Only the allowlist, and only mkdtemp's exact shape. The control is the
#    allowlisted twin with a well-formed six-character suffix.
reset_root
for n in com.apple.foo-abcdef node-compile-cache TemporaryItems random-abcdef \
  srv-err-abcde srv-err-abcdefg srv-err-abc_ef srv-err-abc.ef xsrv-err-abcdef \
  srv-errabcdef dorkos-00370-abcdef dorkos-0037 smoke-e2e--abcdef; do
  make_dir "$n" 200
done
make_dir srv-err-abcdef 200
run_sweep >/dev/null
for n in com.apple.foo-abcdef node-compile-cache TemporaryItems random-abcdef \
  srv-err-abcde srv-err-abcdefg srv-err-abc_ef srv-err-abc.ef xsrv-err-abcdef \
  srv-errabcdef dorkos-00370-abcdef dorkos-0037; do
  check "$n is not on the allowlist's exact shape, kept" "$(kept "$n")"
done
check "...while srv-err-abcdef goes (positive control)" "$(gone srv-err-abcdef)"

# 3. Young is kept, at the top or anywhere inside. The control is the same
#    entry past the floor.
reset_root
make_dir srv-err-young1 2
make_dir srv-err-23hold 23
make_dir srv-err-25hold 25
make_dir srv-err-deepyo 48
mkdir -p "$root/srv-err-deepyo/a/b/c"
echo new >"$root/srv-err-deepyo/a/b/c/fresh"
touch -t "$(stamp_hours_ago 48)" "$root/srv-err-deepyo" "$root/srv-err-deepyo/a" "$root/srv-err-deepyo/a/b"
run_sweep >/dev/null
check "a two-hour-old folder is kept" "$(kept srv-err-young1)"
check "a 23-hour-old folder is kept under the 24 h default" "$(kept srv-err-23hold)"
check "...while a 25-hour-old one goes (positive control)" "$(gone srv-err-25hold)"
check "an old folder with one fresh file deep inside is kept" "$(kept srv-err-deepyo)"
age "$root/srv-err-deepyo" 48
run_sweep >/dev/null
check "...and goes once that file is old too (positive control)" "$(gone srv-err-deepyo)"
run_sweep --min-age-hours 1 >/dev/null
check "a lower floor removes the two-hour-old one" "$(gone srv-err-young1)"
reset_root
make_dir srv-err-25hold 25
DORKOS_TMP_SWEEP_MIN_AGE_HOURS=48 run_sweep >/dev/null
check "a higher floor from the environment keeps the 25-hour-old one" "$(kept srv-err-25hold)"

# 4. In use: an open file or a working directory anywhere under the entry keeps
#    it. The control is its neighbour nobody holds.
reset_root
make_dir route-err-openf1 48
make_dir route-err-cwd001 48
make_dir route-err-free01 48
echo "$root/route-err-openf1/sub/file" >>"$work/open"
echo "$root/route-err-cwd001" >>"$work/open"
run_sweep >/dev/null
check "a folder with an open file inside is kept" "$(kept route-err-openf1)"
check "a folder that is a process's working directory is kept" "$(kept route-err-cwd001)"
check "...while the free neighbour goes (positive control)" "$(gone route-err-free01)"
check "lsof was asked" "$(is test -s "$work/lsof.log")"
: >"$work/open"
run_sweep >/dev/null
check "...and both go once nothing holds them (positive control)" "$(is test ! -e "$root/route-err-openf1" -a ! -e "$root/route-err-cwd001")"

# 5. lsof that cannot answer removes nothing; a soft exit 1 with output is fine.
reset_root
make_dir term-ws-abc123 48
LSOF_STUB_FAIL=1 run_sweep >/dev/null 2>&1
rc=$?
check "a failed lsof exits 1" "$(is test "$rc" -eq 1)"
check "...and removes nothing" "$(kept term-ws-abc123)"
LSOF_STUB_EXIT=1 run_sweep >/dev/null 2>&1
rc=$?
check "lsof's soft exit 1 with output is not an error" "$(is test "$rc" -eq 0)"
check "...and the sweep still removes (positive control)" "$(gone term-ws-abc123)"
# No lsof at all: PATH holds only the tools the sweep needs, minus lsof.
reset_root
make_dir term-ws-abc123 48
mkdir -p "$work/nolsof"
for tool in find sed awk grep sort comm wc tr xargs du mktemp rm date head cat id chmod; do
  ln -sf "$(command -v "$tool")" "$work/nolsof/$tool"
done
TMPDIR="$root" DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 PATH="$work/nolsof" /bin/bash "$sweep" >/dev/null 2>"$work/err"
rc=$?
check "no lsof exits 1" "$(is test "$rc" -eq 1)"
check "...says why" "$(is grep -q 'lsof is not installed' "$work/err")"
check "...and removes nothing" "$(kept term-ws-abc123)"

# 6. Symlinks never lead the sweep out of the root. A top-level symlink with an
#    allowlisted name is skipped; a symlink inside a removed folder is removed
#    as a link, and what it points at survives.
reset_root
ln -s "$outside" "$root/srv-err-linked"
make_dir srv-err-haslnk 48
ln -s "$outside/keep-me" "$root/srv-err-haslnk/escape"
age "$root/srv-err-haslnk" 48
run_sweep >/dev/null
check "a top-level symlink with an allowlisted name is left alone" "$(kept srv-err-linked)"
check "...and so is what it points at" "$(is test -f "$outside/keep-me/file")"
check "a folder holding a symlink out of the root is removed" "$(gone srv-err-haslnk)"
check "...and the symlink's target survives" "$(is grep -qx precious "$outside/keep-me/file")"

# 7. A folder we cannot fully read is kept; the rest of the sweep goes on.
#    (root reads everything, so this fixture only means something as a user.)
if [[ "$(id -u)" != 0 ]]; then
  reset_root
  make_dir term-test-locked 48
  mkdir -p "$root/term-test-locked/sealed/inner"
  touch "$root/term-test-locked/sealed/inner/young"
  age "$root/term-test-locked" 48
  chmod 000 "$root/term-test-locked/sealed"
  make_dir term-test-plain1 48
  run_sweep >/dev/null 2>"$work/err"
  rc=$?
  chmod 755 "$root/term-test-locked/sealed"
  check "an unreadable subfolder keeps its entry" "$(kept term-test-locked)"
  check "...without failing the run" "$(is test "$rc" -eq 0)"
  check "...while a readable neighbour goes (positive control)" "$(gone term-test-plain1)"
fi

# 8. --dry-run removes nothing and says what it would. The control is the same
#    root swept for real.
reset_root
make_dir check-any-dryrn1 48
make_dir check-any-dryrn2 48
out="$(run_sweep --dry-run)"
check "dry run removes nothing" "$(is test -e "$root/check-any-dryrn1" -a -e "$root/check-any-dryrn2")"
check "dry run names what it would remove" "$(is grep -q 'would remove 2 check-any-\*' <<<"$out")"
check "dry run totals it" "$(is grep -q 'would remove 2 of 2 allowlisted entries' <<<"$out")"
out="$(run_sweep)"
check "...and the real run removes them (positive control)" "$(gone check-any-dryrn1)"
check "the real run logs what it removed" "$(is grep -q 'removed 2 check-any-\*' <<<"$out")"
check "the real run logs the total" "$(is grep -q 'test tmp: removed 2 of 2 allowlisted entries' <<<"$out")"

# 9. The root must be the per-user temp folder. Each refusal is exit 2 and
#    touches nothing. The fixture marker alone, or the env alone, is not enough.
reset_root
make_dir srv-err-refuse 48
env -u TMPDIR DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 LSOF_STUB_LOG="$work/lsof.log" /bin/bash "$sweep" >/dev/null 2>&1
check "TMPDIR unset is refused" "$(is test $? -eq 2)"
TMPDIR="" DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 /bin/bash "$sweep" >/dev/null 2>&1
check "TMPDIR empty is refused" "$(is test $? -eq 2)"
TMPDIR="$root" LSOF_STUB_LOG="$work/lsof.log" /bin/bash "$sweep" >/dev/null 2>&1
check "a non-/var/folders root without the fixture switch is refused" "$(is test $? -eq 2)"
rm "$root/.dorkos-tmp-sweep-fixture"
TMPDIR="$root" DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 /bin/bash "$sweep" >/dev/null 2>&1
check "the fixture switch without the marker file is refused" "$(is test $? -eq 2)"
touch "$root/.dorkos-tmp-sweep-fixture"
for bad in / /tmp "$work/does-not-exist" /var/folders "$root/srv-err-refuse"; do
  TMPDIR="$bad" /bin/bash "$sweep" >/dev/null 2>&1
  check "TMPDIR=$bad is refused" "$(is test $? -eq 2)"
done
check "...and none of them touched anything" "$(kept srv-err-refuse)"
check "...not even asking lsof" "$(is test ! -s "$work/lsof.log")"

# 10. --prefix-file adds literal prefixes from outside the repo; a bad line is
#     a usage error that removes nothing.
reset_root
make_dir extra.suite-abcdef 48
make_dir extraXsuite-abcdef 48
make_dir srv-err-withpf 48
printf '# private suites\n\n  extra.suite  # trailing comment\n' >"$work/prefixes"
run_sweep --prefix-file "$work/prefixes" >/dev/null
check "a prefix from the file is swept" "$(gone extra.suite-abcdef)"
check "...literally: its dot is not a wildcard" "$(kept extraXsuite-abcdef)"
check "...alongside the built-in list" "$(gone srv-err-withpf)"
reset_root
make_dir srv-err-badpfx 48
for line in '../evil' 'a b' 'ab' '.*' 'x|y'; do
  printf '%s\n' "$line" >"$work/prefixes"
  run_sweep --prefix-file "$work/prefixes" >/dev/null 2>&1
  check "prefix line '$line' is a usage error" "$(is test $? -eq 2)"
done
run_sweep --prefix-file "$work/no-such-file" >/dev/null 2>&1
check "an unreadable prefix file is a usage error" "$(is test $? -eq 2)"
check "...and none of them removed anything" "$(kept srv-err-badpfx)"

# 11. Bad usage is exit 2, and does nothing. Octal, junk and overflow would all
#     shrink the floor, the deleting direction.
reset_root
make_dir srv-err-usage1 3
for floor in 010 08 soon -1 2562047788015216; do
  run_sweep --min-age-hours "$floor" >/dev/null 2>&1
  check "floor $floor is a usage error" "$(is test $? -eq 2)"
  DORKOS_TMP_SWEEP_MIN_AGE_HOURS="$floor" run_sweep >/dev/null 2>&1
  check "floor $floor from the environment is a usage error" "$(is test $? -eq 2)"
done
run_sweep --delete-everything >/dev/null 2>&1
check "an unknown flag is a usage error" "$(is test $? -eq 2)"
check "...and none of them touched anything" "$(kept srv-err-usage1)"
run_sweep --min-age-hours 0 >/dev/null
check "...while a plain 0 is accepted and sweeps (positive control)" "$(gone srv-err-usage1)"

# 12. Only bash. zsh's regex and sh's syntax would each misjudge something;
#     both are refused before anything runs.
reset_root
make_dir srv-err-shells 48
for shell in zsh sh; do
  command -v "$shell" >/dev/null 2>&1 || continue
  TMPDIR="$root" DORKOS_TMP_SWEEP_FIXTURE_ROOT=1 "$shell" "$sweep" >/dev/null 2>&1
  check "$shell refuses to run it" "$(is test $? -eq 2)"
done
check "...and removed nothing" "$(kept srv-err-shells)"

# 13. Nothing outside the root was ever touched by any fixture above.
check "the outside folder survived every run" "$(is grep -qx precious "$outside/keep-me/file")"

echo "sweep-test-tmp: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
