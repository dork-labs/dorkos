#!/usr/bin/env python3
"""
changelog_backfill.py - Analyze commits and generate missing changelog fragments

Compares commits since the last tag against the fragments already in
`changelog/unreleased/` and identifies changes that have no fragment yet.
Transforms commit messages into user-friendly entries, and (with --apply) writes
one fragment file per missing change. It NEVER edits CHANGELOG.md — only the
release process compiles fragments into CHANGELOG.md (see `changelog/README.md`).

Usage:
    python3 .claude/scripts/changelog_backfill.py [options]

Options:
    --since TAG     Compare against a specific tag OR commit (default: last tag).
                    A commit SHA works too, so CI can scope to a PR's merge-base.
    --dry-run       Show what would be added without writing files
    --json          Output as JSON for programmatic consumption
    --apply         Write fragment files for the missing entries
    --check         Exit non-zero if any user-facing commit lacks a fragment.
                    Writes nothing — the PR-time gate and a local pre-flight both
                    use this to catch a missing fragment before it reaches main.
    --verbose       Show detailed analysis

Output (JSON mode):
    {
        "success": true,
        "since_tag": "v0.8.0",
        "commits_analyzed": 5,
        "existing_entries": 3,
        "missing_entries": [
            {"section": "Added", "entry": "- Entry text", "commit": "abc1234", "sha": "abc...", "original": "feat: ..."}
        ],
        "already_covered": ["abc1234", "def5678"]
    }
"""

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


@dataclass
class Commit:
    """Represents a parsed git commit."""
    sha: str
    message: str
    prefix: Optional[str]
    scope: Optional[str]
    description: str
    is_breaking: bool

    @property
    def short_sha(self) -> str:
        return self.sha[:7]


@dataclass
class ChangelogEntry:
    """Represents a proposed changelog entry."""
    section: str
    entry: str
    commit_sha: str
    original_message: str


# Prefix to changelog section mapping.
# docs/style/test/build/ci are deliberately absent: not user-facing by default.
# Hand-author a fragment when such a change genuinely affects users.
PREFIX_SECTION_MAP = {
    "feat": "Added",
    "fix": "Fixed",
    "refactor": "Changed",
    "perf": "Changed",
}

# Prefixes to skip (maintenance commits)
SKIP_PREFIXES = {"chore", "merge", "revert", "release"}

# Max length of the human-readable slug portion of a fragment filename.
SLUG_MAX_LEN = 40


def get_vault_root() -> Path:
    """Get the vault root directory from git."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True
        )
        return Path(result.stdout.strip())
    except subprocess.CalledProcessError:
        return Path(__file__).parent.parent.parent


def get_last_tag() -> Optional[str]:
    """Get the most recent git tag."""
    result = subprocess.run(
        ["git", "describe", "--tags", "--abbrev=0"],
        capture_output=True,
        text=True
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return None


def get_commits_since(tag: Optional[str]) -> list[tuple[str, str]]:
    """Get commits since a tag as (sha, message) tuples."""
    if tag:
        cmd = ["git", "log", f"{tag}..HEAD", "--pretty=format:%H|%s"]
    else:
        cmd = ["git", "log", "--pretty=format:%H|%s"]

    result = subprocess.run(cmd, capture_output=True, text=True)
    commits = []

    for line in result.stdout.strip().split("\n"):
        if "|" in line:
            sha, message = line.split("|", 1)
            commits.append((sha, message))

    return commits


def get_commit_stamp(sha: str) -> str:
    """Return the commit's UTC committer time as a YYMMDD-HHMMSS fragment stamp."""
    result = subprocess.run(
        ["git", "show", "-s", "--format=%ct", sha],
        capture_output=True,
        text=True,
    )
    try:
        epoch = int(result.stdout.strip().split("\n")[0])
    except (ValueError, IndexError):
        epoch = int(datetime.now(tz=timezone.utc).timestamp())
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%y%m%d-%H%M%S")


def slugify(description: str) -> str:
    """Kebab-case, lowercase, ASCII slug from a commit description, capped in length."""
    slug = re.sub(r"[^a-z0-9]+", "-", description.lower()).strip("-")
    if len(slug) > SLUG_MAX_LEN:
        slug = slug[:SLUG_MAX_LEN].rstrip("-")
    return slug or "change"


def parse_commit(sha: str, message: str) -> Optional[Commit]:
    """Parse a conventional commit message."""
    # Skip release commits
    if message.lower().startswith("release "):
        return None

    # Check for prefixes to skip
    message_lower = message.lower()
    for skip in SKIP_PREFIXES:
        if message_lower.startswith(skip):
            return None

    # Parse conventional commit: type(scope)!: description
    match = re.match(r'^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$', message)

    if not match:
        return None

    prefix = match.group(1).lower()
    scope = match.group(2)
    is_breaking = match.group(3) == "!" or "BREAKING" in message.upper()
    description = match.group(4)

    # Skip if prefix not in our mapping
    if prefix not in PREFIX_SECTION_MAP:
        return None

    return Commit(
        sha=sha,
        message=message,
        prefix=prefix,
        scope=scope,
        description=description,
        is_breaking=is_breaking
    )


def read_fragment_entries(unreleased_dir: Path) -> list[str]:
    """Collect every entry bullet from the fragments in changelog/unreleased/."""
    entries: list[str] = []
    if not unreleased_dir.is_dir():
        return entries
    for frag in sorted(unreleased_dir.glob("*.md")):
        for line in frag.read_text().split("\n"):
            if line.strip().startswith("- "):
                entries.append(line.strip())
    return entries


def normalize_text(text: str) -> str:
    """Normalize text for comparison."""
    # Remove punctuation, lowercase, collapse whitespace
    text = re.sub(r'[^\w\s]', '', text.lower())
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def is_covered_by_entries(commit: Commit, existing_entries: list[str], threshold: float = 0.6) -> bool:
    """Check if a commit is already represented in changelog entries."""
    commit_words = set(normalize_text(commit.description).split())

    for entry in existing_entries:
        entry_words = set(normalize_text(entry).split())

        if not commit_words or not entry_words:
            continue

        # Check word overlap (Jaccard similarity)
        intersection = commit_words & entry_words
        union = commit_words | entry_words
        similarity = len(intersection) / len(union)

        if similarity >= threshold:
            return True

        # Also check if key terms are present
        # Extract significant words (length > 3)
        significant_commit = {w for w in commit_words if len(w) > 3}
        significant_entry = {w for w in entry_words if len(w) > 3}

        if significant_commit and significant_entry:
            significant_overlap = len(significant_commit & significant_entry) / len(significant_commit)
            if significant_overlap >= 0.5:
                return True

    return False


def transform_to_user_friendly(commit: Commit) -> str:
    """Transform a commit description to user-friendly changelog entry."""
    description = commit.description

    # Capitalize first letter
    if description and description[0].islower():
        description = description[0].upper() + description[1:]

    # Remove trailing period
    description = description.rstrip(".")

    # Add breaking prefix if needed
    if commit.is_breaking:
        return f"- **BREAKING**: {description}"

    return f"- {description}"


def format_entry_for_display(entry: ChangelogEntry) -> str:
    """Format an entry for display with commit reference."""
    return f"{entry.entry} ({entry.commit_sha})"


def analyze_and_generate(
    since_tag: Optional[str] = None,
    verbose: bool = False
) -> dict:
    """
    Analyze commits and generate missing changelog entries.

    Returns a dictionary with analysis results.
    """
    vault_root = get_vault_root()
    unreleased_dir = vault_root / "changelog" / "unreleased"

    # Get tag to compare against
    if since_tag is None:
        since_tag = get_last_tag()

    result = {
        "success": True,
        "since_tag": since_tag,
        "commits_analyzed": 0,
        "existing_entries": 0,
        "missing_entries": [],
        "already_covered": [],
        "skipped_commits": [],
    }

    # Get commits
    commits_raw = get_commits_since(since_tag)
    result["commits_analyzed"] = len(commits_raw)

    if verbose:
        print(f"Analyzing {len(commits_raw)} commits since {since_tag or 'beginning'}...", file=sys.stderr)

    # Parse commits
    parsed_commits = []
    for sha, message in commits_raw:
        commit = parse_commit(sha, message)
        if commit:
            parsed_commits.append(commit)
        else:
            result["skipped_commits"].append({"sha": sha[:7], "message": message})

    if verbose:
        print(f"Parsed {len(parsed_commits)} conventional commits", file=sys.stderr)

    # Read existing fragment entries
    existing_entries = read_fragment_entries(unreleased_dir)
    result["existing_entries"] = len(existing_entries)

    if verbose:
        print(f"Found {len(existing_entries)} existing entries in changelog/unreleased/", file=sys.stderr)

    # Find missing entries
    for commit in parsed_commits:
        if is_covered_by_entries(commit, existing_entries):
            result["already_covered"].append(commit.short_sha)
            if verbose:
                print(f"  [covered] {commit.short_sha}: {commit.description}", file=sys.stderr)
        else:
            section = PREFIX_SECTION_MAP[commit.prefix]
            entry = transform_to_user_friendly(commit)

            result["missing_entries"].append({
                "section": section,
                "entry": entry,
                "commit": commit.short_sha,
                "sha": commit.sha,
                "description": commit.description,
                "original": commit.message
            })
            if verbose:
                print(f"  [MISSING] {commit.short_sha}: {commit.description}", file=sys.stderr)

    return result


def write_fragments(entries: list[dict], unreleased_dir: Path) -> int:
    """Write one fragment file per missing entry. Returns the number written."""
    unreleased_dir.mkdir(parents=True, exist_ok=True)
    used: set[str] = set()
    written = 0

    for e in entries:
        stamp = get_commit_stamp(e["sha"]) if e.get("sha") else datetime.now(
            tz=timezone.utc
        ).strftime("%y%m%d-%H%M%S")
        slug = slugify(e.get("description") or e["entry"])
        name = f"{stamp}-{slug}.md"
        n = 2
        while name in used or (unreleased_dir / name).exists():
            name = f"{stamp}-{slug}-{n}.md"
            n += 1
        used.add(name)
        (unreleased_dir / name).write_text(f"### {e['section']}\n\n{e['entry']}\n")
        written += 1

    return written


def main():
    parser = argparse.ArgumentParser(
        description="Analyze commits and generate missing changelog fragments"
    )
    parser.add_argument(
        "--since",
        help="Compare against specific tag (default: last tag)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be added without writing files"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON"
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write fragment files for the missing entries"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if any user-facing commit lacks a fragment (writes nothing)"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed analysis"
    )

    args = parser.parse_args()

    # Run analysis
    result = analyze_and_generate(
        since_tag=args.since,
        verbose=args.verbose
    )

    # Output
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        # Human-readable output
        print(f"\n{'='*60}")
        print(f"Changelog Backfill Analysis")
        print(f"{'='*60}")
        print(f"Since tag: {result['since_tag'] or 'beginning'}")
        print(f"Commits analyzed: {result['commits_analyzed']}")
        print(f"Existing entries: {result['existing_entries']}")
        print(f"Already covered: {len(result['already_covered'])}")
        print(f"Missing entries: {len(result['missing_entries'])}")

        if result['missing_entries']:
            print(f"\n{'='*60}")
            print("Proposed Fragments:")
            print(f"{'='*60}")

            current_section = None
            for entry in result['missing_entries']:
                if entry['section'] != current_section:
                    current_section = entry['section']
                    print(f"\n### {current_section}\n")
                print(f"{entry['entry']} ({entry['commit']})")
                print(f"   From: {entry['original']}")

        if result['skipped_commits'] and args.verbose:
            print(f"\n{'='*60}")
            print("Skipped Commits (not conventional):")
            print(f"{'='*60}")
            for commit in result['skipped_commits']:
                print(f"  {commit['sha']}: {commit['message']}")

    # Apply if requested
    if args.apply and result['missing_entries']:
        vault_root = get_vault_root()
        unreleased_dir = vault_root / "changelog" / "unreleased"
        written = write_fragments(result['missing_entries'], unreleased_dir)
        if not args.json:
            print(f"\nWrote {written} fragment(s) to changelog/unreleased/.")

    # Gate mode: fail if any user-facing commit is missing a fragment.
    # Diagnostics go to stderr so a --json consumer still gets clean JSON on stdout.
    if args.check and result['missing_entries']:
        print(
            f"\n{len(result['missing_entries'])} user-facing commit(s) since "
            f"{result['since_tag'] or 'the base'} have no changelog fragment:",
            file=sys.stderr,
        )
        for entry in result['missing_entries']:
            print(
                f"  [{entry['section']}] {entry['commit']}  {entry['entry']}",
                file=sys.stderr,
            )
        print(
            "\nAdd one fragment per change under changelog/unreleased/ "
            "(see changelog/README.md and the writing-changelogs skill), or "
            "label the PR 'skip-changelog' if the change is deliberately not "
            "user-facing.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
