#!/usr/bin/env python3
"""
changelog_backfill.py - Analyze commits and generate missing changelog entries

Compares commits since the last tag against the [Unreleased] section and
identifies entries that should be added. Transforms commit messages to
user-friendly changelog entries.

Usage:
    python3 .claude/scripts/changelog_backfill.py [options]

Options:
    --since TAG     Compare against specific tag (default: last tag)
    --dry-run       Show what would be added without modifying files
    --json          Output as JSON for programmatic consumption
    --apply         Apply changes directly to changelog
    --verbose       Show detailed analysis

Output (JSON mode):
    {
        "success": true,
        "since_tag": "v0.8.0",
        "commits_analyzed": 5,
        "existing_entries": 3,
        "missing_entries": [
            {"section": "Added", "entry": "- Entry text", "commit": "abc1234", "original": "feat: ..."}
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


# Prefix to changelog section mapping
PREFIX_SECTION_MAP = {
    "feat": "Added",
    "fix": "Fixed",
    "docs": "Changed",
    "refactor": "Changed",
    "perf": "Changed",
    "style": "Changed",
    "test": "Changed",
    "build": "Changed",
    "ci": "Changed",
}

# Prefixes to skip (maintenance commits)
SKIP_PREFIXES = {"chore", "merge", "revert", "release"}


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


def read_changelog_unreleased(changelog_path: Path) -> list[str]:
    """Extract entries from the [Unreleased] section."""
    try:
        content = changelog_path.read_text()
    except FileNotFoundError:
        return []

    entries = []
    in_unreleased = False

    for line in content.split("\n"):
        # Start of [Unreleased]
        if line.strip().startswith("## [Unreleased]"):
            in_unreleased = True
            continue

        # End of [Unreleased] (hit next version)
        if in_unreleased and line.strip().startswith("## [") and "Unreleased" not in line:
            break

        # Collect entry lines
        if in_unreleased and line.strip().startswith("- "):
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
    changelog_path = vault_root / "CHANGELOG.md"

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

    # Read existing entries
    existing_entries = read_changelog_unreleased(changelog_path)
    result["existing_entries"] = len(existing_entries)

    if verbose:
        print(f"Found {len(existing_entries)} existing entries in [Unreleased]", file=sys.stderr)

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
                "original": commit.message
            })
            if verbose:
                print(f"  [MISSING] {commit.short_sha}: {commit.description}", file=sys.stderr)

    return result


def apply_entries_to_changelog(entries: list[dict], changelog_path: Path) -> bool:
    """Apply missing entries to the changelog file."""
    try:
        content = changelog_path.read_text()
    except FileNotFoundError:
        return False

    lines = content.split("\n")
    result_lines = []

    in_unreleased = False
    current_section = None
    entries_by_section = {}

    # Group entries by section
    for entry in entries:
        section = entry["section"]
        if section not in entries_by_section:
            entries_by_section[section] = []
        entries_by_section[section].append(entry["entry"])

    i = 0
    while i < len(lines):
        line = lines[i]

        # Track [Unreleased] section
        if line.strip().startswith("## [Unreleased]"):
            in_unreleased = True
            result_lines.append(line)
            i += 1
            continue

        # End of [Unreleased]
        if in_unreleased and line.strip().startswith("## [") and "Unreleased" not in line:
            in_unreleased = False

        # Track subsections within [Unreleased]
        if in_unreleased and line.strip().startswith("### "):
            current_section = line.strip()[4:]  # Remove "### "
            result_lines.append(line)
            i += 1

            # Skip blank lines after header
            while i < len(lines) and lines[i].strip() == "":
                result_lines.append(lines[i])
                i += 1

            # Insert entries for this section
            if current_section in entries_by_section:
                for entry in entries_by_section[current_section]:
                    result_lines.append(entry)
                result_lines.append("")  # Blank line after entries
                del entries_by_section[current_section]

            continue

        result_lines.append(line)
        i += 1

    # Write back
    changelog_path.write_text("\n".join(result_lines))
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Analyze commits and generate missing changelog entries"
    )
    parser.add_argument(
        "--since",
        help="Compare against specific tag (default: last tag)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be added without modifying files"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON"
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes directly to changelog"
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
            print("Proposed Entries:")
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
        changelog_path = vault_root / "CHANGELOG.md"

        if apply_entries_to_changelog(result['missing_entries'], changelog_path):
            if not args.json:
                print(f"\nApplied {len(result['missing_entries'])} entries to changelog.")
        else:
            if not args.json:
                print("\nFailed to apply entries.", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
