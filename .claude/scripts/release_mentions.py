#!/usr/bin/env python3
"""Refuse release notes that would ping strangers on GitHub.

GitHub turns a bare `@word` in a release body into a real user mention: it
notifies that account and lists it under the release. The v0.129.0 notes said
"cc @ana @bo" as an example, and three strangers got pinged.

Two gates share this module:

  * `changelog_backfill.py --validate` calls `find_mentions` on each fragment
    the PR touched, so a bare mention is caught at PR time.
  * `/system:release` runs this file on the compiled changelog section and on
    the release notes, right before they are published.

Usage:
    python3 .claude/scripts/release_mentions.py NOTES.md
    python3 .claude/scripts/release_mentions.py CHANGELOG.md --section 1.2.3

What is allowed, because GitHub does not ping for it: anything in inline code or
a fenced block, emails and versions (`me@example.com`, `dorkos@latest`), `@` in
a URL path, and an escaped `\\@word`. npm scopes (`@dork-labs/cloud-api`) are
allowed too, though GitHub reads that shape as an org team: it only links when
such a team exists, and a package name is what it means in these notes.

An indented code block is not recognized, on purpose. Four spaces also means a
nested bullet, and backticks are a cheap fix for a false alarm. Pure stdlib, like
the analyzer it serves.
"""

import argparse
import re
import sys
from pathlib import Path
from typing import NamedTuple, Optional

FENCE_RE = re.compile(r"^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$")
INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)")
# The lookbehind is what lets emails, versions, URL paths and escapes through.
MENTION_RE = re.compile(
    r"(?<![A-Za-z0-9_+\-/\\])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(/[A-Za-z0-9._-]+)?"
)


class Mention(NamedTuple):
    """One bare `@handle`, with the 1-based line it sits on."""

    line: int
    handle: str


def find_mentions(lines: list[str], first_line: int = 1) -> list[Mention]:
    """Return every `@handle` in markdown lines that GitHub would turn into a ping."""
    mentions: list[Mention] = []
    open_fence: Optional[str] = None
    for number, line in enumerate(lines, start=first_line):
        fence = FENCE_RE.match(line)
        if open_fence is not None:
            if (
                fence
                and fence.group(1)[0] == open_fence[0]
                and len(fence.group(1)) >= len(open_fence)
                and not fence.group(2).strip()
            ):
                open_fence = None
            continue
        # A backtick in the info string makes it inline code, not a fence: ```x```.
        if fence and not (fence.group(1)[0] == "`" and "`" in fence.group(2)):
            open_fence = fence.group(1)
            continue
        prose = INLINE_CODE_RE.sub(" ", line)
        for match in MENTION_RE.finditer(prose):
            if not match.group(2):
                mentions.append(Mention(number, match.group(1)))
    return mentions


def describe(mention: Mention) -> str:
    """Name the mention and the fix, in one line."""
    return (
        f"line {mention.line}: `@{mention.handle}` would ping a real GitHub account. "
        "Put it in backticks, or reword it."
    )


def changelog_section(lines: list[str], version: str) -> tuple[list[str], int]:
    """Return the lines of one `## [X.Y.Z]` section and its first 1-based line number."""
    start = next(
        (i for i, line in enumerate(lines) if line.startswith(f"## [{version}]")),
        None,
    )
    if start is None:
        raise ValueError(f"no `## [{version}]` section found")
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return lines[start:end], start + 1


def main() -> int:
    """Check one file, and exit 1 if it holds a bare mention."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("path", type=Path, help="the markdown file to check")
    parser.add_argument(
        "--section",
        metavar="VERSION",
        help="check only this version's `## [VERSION]` section",
    )
    args = parser.parse_args()

    try:
        lines = args.path.read_text(encoding="utf-8").split("\n")
        first_line = 1
        if args.section:
            lines, first_line = changelog_section(lines, args.section)
    except (OSError, ValueError) as error:
        print(f"{args.path}: {error}", file=sys.stderr)
        return 2

    mentions = find_mentions(lines, first_line)
    for mention in mentions:
        print(f"{args.path}: {describe(mention)}", file=sys.stderr)
    return 1 if mentions else 0


if __name__ == "__main__":
    sys.exit(main())
