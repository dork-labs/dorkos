#!/usr/bin/env bash
# Fail when a raw NUL byte (U+0000) is pasted directly into a text file
# instead of written as its escape sequence. Canonical spelling in this
# repo: `\u0000`.
#
# WHY THIS EXISTS. A raw NUL byte in a text file makes both git and grep treat
# the WHOLE FILE as binary: `git diff`/`git show`/GitHub's PR view collapse to
# "Binary files differ", and this repo's default `grep` (ugrep) silently
# returns zero matches instead of erroring — so a search for something the
# file plainly contains just comes back empty, with no signal that anything
# went wrong. The escape sequence evaluates to the exact same runtime
# character, so switching to it is always a zero-behavior-change fix.
#
# This has happened twice. DOR-1450 (PR #1222) found two literal NUL bytes
# joining/splitting a mesh path key in the client's useBootState and rewrote
# them as `'\0'`, pinning the file to a textual diff via .gitattributes — but
# added no guard, so the same mistake was free to happen again. DOR-1561 found
# it again: TEN more raw NUL bytes across seven files, almost every one of them the
# same shape — a composite-key separator (`${a}\x00${b}`) pasted as a literal
# byte instead of typed as `\u0000` — because the pattern is easy to introduce
# by pasting a character rather than typing an escape, and there was nothing
# to catch it. This script is the guard neither round added.
#
#   bash scripts/check-nul-bytes.sh
#   ROOT=/path/to/checkout bash scripts/check-nul-bytes.sh
#
# WHAT IT SCANS. Every file `git ls-files` tracks in ROOT, which is already
# gitignore-aware and skips node_modules/dist/build output with no extra
# filtering — except the extensions in %skip_ext below, which legitimately
# contain NUL bytes as part of a real binary format and are not this bug.
# Anything not on that list is treated as text and scanned byte-for-byte, on
# the theory that a false RED (an extension this list forgot) is loud and
# cheap to fix, while a false GREEN (a real binary format skipped by scanning
# it as text) never happens because the point is never to flag binaries in
# the first place — only text files that should never hold a raw NUL.
#
# ONE PERL PROCESS for the whole scan, not a per-file bash loop. An earlier
# version filtered extensions with a bash function that shelled out to `tr`
# per candidate file — correct, but a separate process per one of this repo's
# ~9,800 tracked text files measured 88s locally, next to unusable as a CI
# gate. Doing the extension filter AND the byte scan inside one Perl
# invocation measured under 2s against the same tree.
#
# WHAT IS DELIBERATELY EXEMPT. A line may carry the `nul-byte-allow` marker in
# a comment on the same line for a raw byte that is not this bug — content
# UNDER TEST rather than a separator mistake, e.g. a fixture asserting how
# control characters render. Mark such a line with `nul-byte-allow` and a
# reason; unmarked, an unusual raw byte should be replaced with its escape
# like every other case here, not exempted by default.
#
# Pinned by scripts/test-check-nul-bytes.sh, which proves it goes red on a
# seeded raw NUL byte, respects the `nul-byte-allow` marker, and stays green
# on a file that spells the same separator as an escape.

set -uo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "check-nul-bytes: $ROOT is not a git checkout; nothing to scan." >&2
  exit 0
fi

# Perl strings hold embedded NULs natively (bash's do not), so the extension
# filter, the byte scan, and the `nul-byte-allow` marker check can all happen
# in this one process — bash only ever sees the redacted, NUL-free summary
# lines on stdout. The scanned-file count rides stderr into a temp file so it
# survives alongside a non-zero exit, which command substitution on stdout
# alone cannot carry.
scanned_file="$(mktemp)"
trap 'rm -f "$scanned_file"' EXIT

result="$(cd "$ROOT" && git ls-files -z | perl -e '
my @exts = qw(
  png jpg jpeg gif ico icns tiff tif webp avif bmp
  woff woff2 ttf otf eot
  mp3 mp4 mov wav webm avi ogg
  zip tar gz tgz 7z rar bz2 xz brotli
  pdf wasm node jar class pyc
  db sqlite sqlite3
);
my %skip_ext = map { $_ => 1 } @exts;

my $list = do { local $/; <STDIN> };
my @files = grep { length } split /\0/, $list;

my $scanned = 0;
my $violations = 0;
for my $f (@files) {
  if ($f =~ /\.([^.\/]+)$/) {
    next if $skip_ext{lc $1};
  }
  open(my $fh, "<:raw", $f) or next;
  $scanned++;
  my $n = 0;
  while (my $line = <$fh>) {
    $n++;
    next unless index($line, "\0") >= 0;
    next if index($line, "nul-byte-allow") >= 0;
    (my $display = $line) =~ s/\x00/<NUL>/g;
    $display =~ s/[\r\n]+$//;
    $display =~ s/^\s+//;
    $display = substr($display, 0, 140);
    print "$f:$n:$display\n";
    $violations++;
  }
  close($fh);
}
print STDERR "$scanned\n";
exit($violations > 0 ? 1 : 0);
' 2>"$scanned_file")"
status=$?

# The perl script signals exactly two outcomes on purpose: 0 (clean) or 1
# (violations found), with the scanned-file count on stderr either way. Any
# OTHER status means perl itself didn't run to completion — not found (127),
# a syntax error, a crash — and in that case stderr holds perl's own error
# text, not a count. Conflating the two branches would print the "raw NUL
# byte(s) found" banner over what is actually "the scan never ran".
if [ "$status" -eq 1 ]; then
  scanned="$(cat "$scanned_file" 2>/dev/null || echo '?')"
  echo "check-nul-bytes: raw NUL byte(s) found in text files:" >&2
  echo "" >&2
  while IFS= read -r hit; do
    printf '  %s\n' "$hit" >&2
  done <<<"$result"
  {
    echo ""
    echo "A raw NUL byte makes git and grep treat the whole file as binary —"
    echo "diffs collapse to \"Binary files differ\" and a grep for content the"
    echo "file plainly contains silently returns nothing (DOR-1450, DOR-1561)."
    echo ""
    echo "Fix: replace the raw byte with the \\u0000 escape sequence inside the"
    echo "string literal — it evaluates to the exact same character, so this is"
    echo "always a zero-behavior-change edit."
    echo ""
    echo "If the raw byte is genuinely content under test rather than a mistake,"
    echo "mark the line with a 'nul-byte-allow' comment explaining why."
  } >&2
  exit 1
elif [ "$status" -ne 0 ]; then
  echo "check-nul-bytes: the scan itself failed (perl exited ${status}), not a raw-NUL finding:" >&2
  echo "" >&2
  while IFS= read -r line; do
    printf '  %s\n' "$line" >&2
  done <"$scanned_file"
  exit "$status"
fi

scanned="$(cat "$scanned_file" 2>/dev/null || echo '?')"
echo "check-nul-bytes: clean — 0 raw NUL bytes across ${scanned} tracked file(s)."
