#!/usr/bin/env python3
"""
changelog-populator.py - Git post-commit hook for auto-populating changelog

Automatically adds entries to CHANGELOG.md [Unreleased] section
based on conventional commit messages.

Only processes commits that touch project files (src/, prisma/, etc.).
Non-project files are ignored.

Commit Message Format (Conventional Commits):
    feat: Add new feature          -> ### Added
    fix: Fix a bug                 -> ### Fixed
    docs: Update documentation     -> ### Changed
    refactor: Refactor code        -> ### Changed
    BREAKING: or feat!:            -> ### Changed (with breaking note)
    chore:                         -> (skipped)

Installation:
    ln -sf ../../.claude/hooks/changelog-populator.py .git/hooks/post-commit

Or run:
    .claude/scripts/install-git-hooks.sh
"""

import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

# System paths that trigger changelog entries
SYSTEM_PATHS = [
    ".claude/",
    "src/",
    "prisma/",
    "developer-guides/",
    "next.config.ts",
    "package.json",
    "tsconfig.json",
    "VERSION",
]

# Paths explicitly excluded (even if they match system paths)
EXCLUDED_PATHS = [
    "CHANGELOG.md",  # Don't create entries for changelog edits
]

# Commit prefixes to skip (maintenance, not notable)
SKIP_PREFIXES = [
    "chore:",
    "chore(",
    "Merge ",
    "Revert ",
]

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
        # Fallback: assume script is in .claude/hooks/
        return Path(__file__).parent.parent.parent


def get_last_commit_message() -> str:
    """Get the message of the last commit."""
    result = subprocess.run(
        ["git", "log", "-1", "--pretty=%B"],
        capture_output=True,
        text=True
    )
    return result.stdout.strip()


def get_last_commit_files() -> list[str]:
    """Get list of files changed in the last commit."""
    result = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        capture_output=True,
        text=True
    )
    return [f for f in result.stdout.strip().split("\n") if f]


def is_system_file(path: str) -> bool:
    """Check if a path is a system file that should trigger changelog entries."""
    # Check exclusions first
    for excluded in EXCLUDED_PATHS:
        if path == excluded or path.startswith(excluded):
            return False

    # Check if it matches system paths
    for system_path in SYSTEM_PATHS:
        if path.startswith(system_path) or path == system_path:
            return True
    return False


def should_skip_commit(message: str) -> bool:
    """Check if this commit should be skipped."""
    first_line = message.split("\n")[0].strip()

    # Skip empty messages
    if not first_line:
        return True

    # Skip known maintenance prefixes
    for prefix in SKIP_PREFIXES:
        if first_line.startswith(prefix):
            return True

    return False


def parse_commit_message(message: str) -> Optional[Tuple[str, str, bool]]:
    """
    Parse a conventional commit message.

    Returns: (section, description, is_breaking) or None if not parseable
    """
    first_line = message.split("\n")[0].strip()

    # Check for breaking change markers
    is_breaking = "BREAKING" in message or "!" in first_line.split(":")[0] if ":" in first_line else False

    # Try to parse conventional commit format: type(scope): description
    # or type: description
    match = re.match(r'^(\w+)(?:\([^)]+\))?(!)?:\s*(.+)$', first_line)

    if not match:
        return None

    prefix = match.group(1).lower()
    has_bang = match.group(2) == "!"
    description = match.group(3)

    if has_bang:
        is_breaking = True

    # Map prefix to section
    section = PREFIX_SECTION_MAP.get(prefix)
    if not section:
        return None

    return (section, description, is_breaking)


def format_changelog_entry(description: str, is_breaking: bool) -> str:
    """Format a changelog entry line."""
    # Capitalize first letter
    if description and description[0].islower():
        description = description[0].upper() + description[1:]

    # Remove trailing period if present (we don't use periods in changelog entries)
    description = description.rstrip(".")

    if is_breaking:
        return f"- **BREAKING**: {description}"
    else:
        return f"- {description}"


def read_changelog(changelog_path: Path) -> str:
    """Read the changelog file."""
    try:
        return changelog_path.read_text()
    except FileNotFoundError:
        return ""


def insert_changelog_entry(content: str, section: str, entry: str) -> str:
    """
    Insert an entry into the appropriate section of [Unreleased].

    Finds the ### {section} heading under ## [Unreleased] and inserts the entry.
    """
    lines = content.split("\n")
    result = []

    in_unreleased = False
    found_section = False
    entry_inserted = False

    i = 0
    while i < len(lines):
        line = lines[i]

        # Track when we enter [Unreleased]
        if line.startswith("## [Unreleased]"):
            in_unreleased = True
            result.append(line)
            i += 1
            continue

        # Track when we leave [Unreleased] (hit next version section)
        if in_unreleased and line.startswith("## [") and not line.startswith("## [Unreleased]"):
            in_unreleased = False

        # Look for our target section within [Unreleased]
        if in_unreleased and line.strip() == f"### {section}":
            found_section = True
            result.append(line)
            i += 1

            # Skip any blank lines after the header
            while i < len(lines) and lines[i].strip() == "":
                result.append(lines[i])
                i += 1

            # Insert the new entry
            result.append(entry)
            entry_inserted = True

            # Add blank line if next line is another entry (keep formatting nice)
            if i < len(lines) and not lines[i].startswith("-"):
                result.append("")

            continue

        result.append(line)
        i += 1

    # If we didn't find the section, we need to add it
    if not entry_inserted and in_unreleased:
        # Find [Unreleased] and add section after it
        new_result = []
        for j, line in enumerate(result):
            new_result.append(line)
            if line.startswith("## [Unreleased]"):
                # Add after the blank line following [Unreleased]
                # Look for where to insert the new section
                insert_idx = j + 1
                while insert_idx < len(result) and result[insert_idx].strip() == "":
                    insert_idx += 1

                # Check if we need to add the section
                if insert_idx < len(result) and not result[insert_idx].startswith(f"### {section}"):
                    # Find the right position to insert (maintain section order)
                    section_order = ["Added", "Changed", "Fixed", "Deprecated", "Removed", "Security"]
                    target_order = section_order.index(section) if section in section_order else 99

                    # For now, just add at the beginning
                    new_result.append("")
                    new_result.append(f"### {section}")
                    new_result.append("")
                    new_result.append(entry)

        if len(new_result) > len(result):
            result = new_result
            entry_inserted = True

    return "\n".join(result)


def write_changelog(changelog_path: Path, content: str) -> None:
    """Write the changelog file."""
    changelog_path.write_text(content)


def main() -> int:
    """Main entry point for the post-commit hook."""
    vault_root = get_vault_root()
    changelog_path = vault_root / "CHANGELOG.md"
    lock_file = vault_root / ".claude" / ".changelog-populator.lock"

    # Prevent re-entry (amend triggers post-commit again)
    if lock_file.exists():
        return 0

    # Get commit info
    message = get_last_commit_message()
    changed_files = get_last_commit_files()

    # Check if we should skip this commit
    if should_skip_commit(message):
        return 0

    # Check if any system files were changed
    system_files = [f for f in changed_files if is_system_file(f)]
    if not system_files:
        return 0

    # Parse the commit message
    parsed = parse_commit_message(message)
    if not parsed:
        # Non-conventional commit format, skip silently
        return 0

    section, description, is_breaking = parsed

    # Format the entry
    entry = format_changelog_entry(description, is_breaking)

    # Read, modify, and write changelog
    content = read_changelog(changelog_path)
    if not content:
        print(f"Warning: Changelog not found at {changelog_path}", file=sys.stderr)
        return 0

    new_content = insert_changelog_entry(content, section, entry)

    if new_content != content:
        try:
            # Create lock file to prevent re-entry during amend
            lock_file.touch()

            write_changelog(changelog_path, new_content)

            # Stage the changelog change
            subprocess.run(
                ["git", "add", str(changelog_path)],
                capture_output=True
            )

            # Amend the commit to include the changelog update
            # Note: We do this silently; the original commit message is preserved
            subprocess.run(
                ["git", "commit", "--amend", "--no-edit", "--no-verify"],
                capture_output=True
            )

            print(f"Changelog updated: {entry}")
        finally:
            # Always remove lock file
            if lock_file.exists():
                lock_file.unlink()

    return 0


if __name__ == "__main__":
    sys.exit(main())
