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
    refactor: / perf:              -> ### Changed
    BREAKING: or feat!:            -> (category above, with **BREAKING** note)
    docs: / style: / test: / build: / ci: / chore: -> (skipped; hand-author a
        fragment when such a change is genuinely user-facing)

Fragment filename: <YYMMDD-HHMMSS>-<kebab-slug>.md (UTC commit time + subject slug).

Every fragment this hook writes opens with a `covers:` declaration naming the
commit it covers, by subject line:

    ---
    covers:
      - "fix(chat): stop dropping the last streamed token (DOR-123)"
    ---

That declaration is what makes the PR-time gate
(.claude/scripts/changelog_backfill.py --check) deterministic: coverage is a
declared fact, so you can rewrite the bullet for a human — the whole point of a
fragment — without the gate losing track of the commit. Curate the prose freely;
leave the frontmatter alone.

Why the subject and not the SHA: this hook amends the commit to include the
fragment, which changes the commit's SHA — a commit can never contain its own
SHA. Rebases rewrite SHAs too. The subject survives both.

The entry itself is raw, seeded prose — the commit subject, reshaped just
enough to look like a bullet — and nobody has read it yet. It ships with a
`SEED_MARKER` HTML comment above it, which `changelog_backfill.py --validate`
rejects until that comment is gone. Rewrite the bullet for a human (or delete
the fragment if the change needs no entry at all) and delete the marker with
it; the `covers:` declaration is unaffected and needs no changes.

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

# Prefix to changelog category mapping (Keep a Changelog headings).
# docs/style/test/build/ci are deliberately absent: not user-facing by default.
# Hand-author a fragment when such a change genuinely affects users.
PREFIX_SECTION_MAP = {
    "feat": "Added",
    "fix": "Fixed",
    "refactor": "Changed",
    "perf": "Changed",
}

# Max length of the human-readable slug portion of a fragment filename.
SLUG_MAX_LEN = 40

# Frontmatter field declaring which commits a fragment covers. Kept in sync with
# `.claude/scripts/changelog_backfill.py`, which reads it — the two scripts are
# deliberately standalone (a git hook must not depend on an import path).
COVERS_FIELD = "covers"

# Token inside the HTML comment this hook writes into every seeded fragment's
# body, right above the raw entry. `changelog_backfill.py --validate` rejects
# any fragment containing it, so a bullet nobody has read yet — a commit
# subject is developer shorthand, not prose written for a user — cannot compile
# into CHANGELOG.md silently. Kept in sync with `.claude/scripts/
# changelog_backfill.py`, which reads it — the two scripts are deliberately
# standalone (a git hook must not depend on an import path).
#
# Lives in the body, not the frontmatter: `covers:` staying byte-identical to
# the commit subject is correct and must keep working, so only the entry prose
# — the part nobody has actually read yet — is what needs to fail the gate.
SEED_MARKER_TOKEN = "dorkos-changelog:seeded"
SEED_MARKER = (
    f"<!-- {SEED_MARKER_TOKEN} — rewrite this bullet for a human, then delete "
    "this comment. If the change needs no changelog entry, delete the whole "
    "fragment instead. See changelog/README.md#seeded-fragments. -->"
)


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


def get_last_commit_subject() -> str:
    """Get HEAD's subject exactly as `git log --pretty=%s` renders it.

    Not `message.split("\\n")[0]`: git folds a wrapped subject into one line, and
    the analyzer compares against `%s`. Taking the first raw line instead would
    write a declaration that can never match its own commit.
    """
    result = subprocess.run(
        ["git", "log", "-1", "--pretty=%s"],
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


def is_replayed_commit() -> bool:
    """Return True when HEAD was produced by replaying an existing commit.

    An amend, cherry-pick, or rebase pick re-fires post-commit for a commit
    that already had its populator run — and whose fragment may have been
    hand-edited since, which defeats the entry-line idempotency guard below
    (the reworded fragment no longer matches the subject-derived entry, so a
    duplicate lands; bit PR #189). The reflog action is the reliable signal:
    only a plain `commit:` / `commit (initial):` mints a fragment.

    Fails open: if the reflog is unavailable (core.logAllRefUpdates off), every
    commit is treated as fresh and the entry-line guard remains the only
    defense — better an occasional duplicate than silently never creating
    fragments.

    `commit (merge):` is allowed through: a real merge commit is a fresh
    commit, not a replay (default "Merge ..." subjects are skipped later by
    SKIP_PREFIXES anyway; this matters only for merges with a custom,
    conventional first line).
    """
    result = subprocess.run(
        ["git", "reflog", "-1", "--format=%gs"],
        capture_output=True,
        text=True,
    )
    action = (result.stdout or "").strip()
    if not action:
        return False
    return not action.startswith(("commit:", "commit (initial):", "commit (merge):"))


def quote_yaml_scalar(value: str) -> str:
    """Render a `covers:` item as a double-quoted YAML scalar.

    Quoting is required, not cosmetic: a conventional-commit subject contains
    ": ", which bare YAML would read as a mapping key.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def read_yaml_scalar(value: str) -> str:
    """Read back a `covers:` item, whichever way it was quoted.

    The hook writes double-quoted scalars; Prettier rewrites them to single
    quotes the first time it formats the fragment. Comparing rendered strings
    therefore stopped matching as soon as a hand-written fragment had been
    committed once, and the hook minted a duplicate on every later commit even
    though the fragment declared the subject (DOR-461 review, twice).
    """
    text = value.strip()
    for quote in ('"', "'"):
        if len(text) >= 2 and text.startswith(quote) and text.endswith(quote):
            body = text[1:-1]
            return body.replace('\\"', '"').replace("\\\\", "\\") if quote == '"' else body
    return text


def format_with_prettier(path: Path) -> None:
    """Run Prettier over a freshly minted fragment, in place.

    This hook fires AFTER the pre-commit formatter and amends its file straight
    into the commit, so nothing else ever formats a fragment — and the styles
    disagree: `quote_yaml_scalar` writes double-quoted `covers:` items while the
    repo's Prettier config (`singleQuote: true`) wants single. Every hook-minted
    fragment was therefore born unformatted, which was invisible until CI began
    checking formatting (DOR-485) and would otherwise red-light the next PR that
    used the hook.

    Deferring to Prettier rather than teaching this function Prettier's quoting
    heuristic is deliberate: the heuristic has cases (a subject containing an
    apostrophe keeps double quotes), and a near-miss reintroduces the same red.

    Best-effort by design. A missing `pnpm`/Prettier, or a Prettier failure, must
    never break someone's commit over whitespace: the fragment is still written
    and staged, and CI will say so.

    @param path: The fragment file to format in place.
    """
    try:
        # `pnpm exec`, never `npx`: npx resolves a different binary than pnpm
        # does in this workspace, and only `pnpm exec` matches the pre-commit
        # hook and the CI gate. Named by basename from its own directory so the
        # hook's cwd cannot matter.
        subprocess.run(
            ["pnpm", "exec", "prettier", "--write", path.name],
            capture_output=True,
            cwd=path.parent,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def render_fragment(section: str, entry: str, subject: str) -> str:
    """Render fragment contents: a `covers:` declaration, a seed marker, then
    the entry.

    The marker is what makes `--validate` refuse this fragment until a human
    or agent rewrites the entry below it — see `SEED_MARKER` above.
    """
    return (
        "---\n"
        f"{COVERS_FIELD}:\n"
        f"  - {quote_yaml_scalar(subject)}\n"
        "---\n"
        "\n"
        f"### {section}\n"
        "\n"
        f"{SEED_MARKER}\n"
        f"{entry}\n"
    )


def already_recorded(unreleased_dir: Path, entry: str, subject: str) -> bool:
    """Return True if a fragment already covers this commit.

    Second idempotency layer behind the reflog guard: catches replays the
    reflog cannot see (e.g. a fragment-less commit re-created verbatim in a
    fresh clone). Two keys are checked, either of which is enough:

    - the `covers:` declaration for this commit's subject — the durable key,
      unaffected by anyone rewriting the fragment's prose, or by the quote style
      Prettier settles on when it formats the file;
    - the exact entry line — the legacy key, which still catches fragments
      written before declarations existed.

    Matching by content (not filename) works even when the commit time — and
    therefore the fragment name — differs.
    """
    if not unreleased_dir.is_dir():
        return False
    entry_target = entry.strip()
    for frag in unreleased_dir.glob("*.md"):
        for line in frag.read_text(encoding="utf-8").split("\n"):
            stripped = line.strip()
            if stripped == entry_target:
                return True
            # Compare the subject itself, not a rendering of it: the quote style
            # of a committed fragment is Prettier's to choose, not ours.
            if stripped.startswith("- ") and read_yaml_scalar(stripped[2:]) == subject:
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

    # Replays (amend / cherry-pick / rebase pick) never mint a new fragment —
    # the original commit already had its populator run.
    if is_replayed_commit():
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
    subject = get_last_commit_subject()

    # Idempotency: skip if a fragment already covers this commit (amend/rebase).
    if already_recorded(unreleased_dir, entry, subject):
        return 0

    stamp = get_last_commit_timestamp().strftime("%y%m%d-%H%M%S")
    slug = slugify(description)
    fragment_path = resolve_fragment_path(unreleased_dir, stamp, slug)
    content = render_fragment(section, entry, subject)

    try:
        # Create lock file to prevent re-entry during amend
        lock_file.parent.mkdir(parents=True, exist_ok=True)
        lock_file.touch()

        unreleased_dir.mkdir(parents=True, exist_ok=True)
        fragment_path.write_text(content, encoding="utf-8")
        format_with_prettier(fragment_path)

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
