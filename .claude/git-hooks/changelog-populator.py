#!/usr/bin/env python3
"""
changelog-populator.py - Git post-commit hook for auto-creating changelog fragments

Writes one changelog *fragment* per commit under `changelog/unreleased/`, derived
from the conventional-commit subject. Fragments are compiled into CHANGELOG.md only
at release time (`/system:release`) — this hook NEVER edits CHANGELOG.md.

Why fragments: a shared `[Unreleased]` block in CHANGELOG.md was edited by nearly
every branch, so parallel worktrees collided there constantly. One uniquely-named
file per change can never add/add-conflict (same coordination-free idea as
timestamp-id ADRs). See `changelog/README.md` and the fragments ADR.

Only processes commits that touch project files (apps/, packages/, etc.).
Non-project files (and the changelog dir itself) are ignored.

Commit Message Format (Conventional Commits):
    feat: Add new feature          -> ### Added
    fix: Fix a bug                 -> ### Fixed
    docs: Update documentation     -> ### Changed
    refactor: Refactor code        -> ### Changed
    BREAKING: or feat!:            -> (category above, with **BREAKING** note)
    chore:                         -> (skipped)

Fragment filename: <YYMMDD-HHMMSS>-<kebab-slug>.md (UTC commit time + subject slug).

Installation:
    ln -sf ../../.claude/git-hooks/changelog-populator.py .git/hooks/post-commit

Or run:
    .claude/scripts/install-git-hooks.sh
"""

import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

# System paths that trigger changelog fragments
SYSTEM_PATHS = [
    ".claude/",
    "apps/",
    "packages/",
    "contributing/",
    "docs/",
    "package.json",
    "tsconfig.json",
    "turbo.json",
]

# Paths explicitly excluded (even if they match system paths)
EXCLUDED_PATHS = [
    "CHANGELOG.md",  # Only the release process writes the compiled changelog
    "changelog/",    # Fragment dir + archive — editing a fragment isn't itself a change
]

# Commit prefixes to skip (maintenance, not notable)
SKIP_PREFIXES = [
    "chore:",
    "chore(",  # includes chore(release): — release commits are skipped
    "Merge ",
    "Revert ",
]

# Prefix to changelog category mapping (Keep a Changelog headings)
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

# Max length of the human-readable slug portion of a fragment filename.
SLUG_MAX_LEN = 40


def get_vault_root() -> Path:
    """Get the vault root directory from git."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        return Path(result.stdout.strip())
    except subprocess.CalledProcessError:
        # Fallback: assume script is in .claude/git-hooks/
        return Path(__file__).parent.parent.parent


def get_last_commit_message() -> str:
    """Get the message of the last commit."""
    result = subprocess.run(
        ["git", "log", "-1", "--pretty=%B"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def get_last_commit_timestamp() -> datetime:
    """Get the committer time of HEAD as a UTC datetime."""
    result = subprocess.run(
        ["git", "log", "-1", "--pretty=%ct"],
        capture_output=True,
        text=True,
    )
    epoch = int(result.stdout.strip() or "0")
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def get_last_commit_files() -> list[str]:
    """Get list of files changed in the last commit."""
    result = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        capture_output=True,
        text=True,
    )
    return [f for f in result.stdout.strip().split("\n") if f]


def is_system_file(path: str) -> bool:
    """Check if a path is a system file that should trigger changelog fragments."""
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


def slugify(description: str) -> str:
    """Kebab-case, lowercase, ASCII slug from a commit description, capped in length."""
    slug = re.sub(r"[^a-z0-9]+", "-", description.lower()).strip("-")
    if len(slug) > SLUG_MAX_LEN:
        slug = slug[:SLUG_MAX_LEN].rstrip("-")
    return slug or "change"


def entry_already_recorded(unreleased_dir: Path, entry: str) -> bool:
    """Return True if any existing fragment already contains this exact entry line.

    Idempotency guard: a commit that is amended, cherry-picked, or replayed by a
    rebase re-fires this hook with the same subject. Without this, the same entry
    would land in a second fragment. Matching by entry line (not filename) catches
    replays even when the commit time — and therefore the fragment name — differs.
    """
    if not unreleased_dir.is_dir():
        return False
    target = entry.strip()
    for frag in unreleased_dir.glob("*.md"):
        for line in frag.read_text().split("\n"):
            if line.strip() == target:
                return True
    return False


def resolve_fragment_path(unreleased_dir: Path, stamp: str, slug: str) -> Path:
    """Pick a free fragment path, disambiguating a same-second same-slug collision."""
    base = unreleased_dir / f"{stamp}-{slug}.md"
    if not base.exists():
        return base
    n = 2
    while True:
        candidate = unreleased_dir / f"{stamp}-{slug}-{n}.md"
        if not candidate.exists():
            return candidate
        n += 1


def main() -> int:
    """Main entry point for the post-commit hook."""
    vault_root = get_vault_root()
    unreleased_dir = vault_root / "changelog" / "unreleased"
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
    entry = format_changelog_entry(description, is_breaking)

    # Idempotency: skip if this exact entry already lives in a fragment (amend/rebase).
    if entry_already_recorded(unreleased_dir, entry):
        return 0

    stamp = get_last_commit_timestamp().strftime("%y%m%d-%H%M%S")
    slug = slugify(description)
    fragment_path = resolve_fragment_path(unreleased_dir, stamp, slug)
    content = f"### {section}\n\n{entry}\n"

    try:
        # Create lock file to prevent re-entry during amend
        lock_file.parent.mkdir(parents=True, exist_ok=True)
        lock_file.touch()

        unreleased_dir.mkdir(parents=True, exist_ok=True)
        fragment_path.write_text(content)

        # Stage the fragment
        subprocess.run(["git", "add", str(fragment_path)], capture_output=True)

        # Amend the commit to include the fragment.
        # We do this silently; the original commit message is preserved.
        subprocess.run(
            ["git", "commit", "--amend", "--no-edit", "--no-verify"],
            capture_output=True,
        )

        print(f"Changelog fragment created: {fragment_path.name}")
    finally:
        # Always remove lock file
        if lock_file.exists():
            lock_file.unlink()

    return 0


if __name__ == "__main__":
    sys.exit(main())
