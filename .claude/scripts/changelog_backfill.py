#!/usr/bin/env python3
"""
changelog_backfill.py - Analyze commits and generate missing changelog fragments

Compares commits since the last tag against the fragments already in
`changelog/unreleased/` and identifies changes that have no fragment yet.
Transforms commit messages into user-friendly entries, and (with --apply) writes
one fragment file per missing change. It NEVER edits CHANGELOG.md — only the
release process compiles fragments into CHANGELOG.md (see `changelog/README.md`).

How coverage is decided (DOR-387)
---------------------------------
Coverage is a **declared fact**, not a guess. A fragment may open with YAML
frontmatter carrying a `covers:` list of commit references:

    ---
    covers:
      - "feat(chat): friendly sign-in errors with a working fix path (DOR-438)"
      - 72deb73
      - "#426"
    ---

    ### Fixed

    - Sign-in problems now say what went wrong and how to fix it

Each item is classified by shape: `#123` is a pull request, 7-40 hex characters
is a commit SHA (short or full), anything else is a literal commit subject line.
A commit is covered when some fragment claims it. `--pr N` (passed by CI, which
knows the PR number) additionally lets a `#N` claim cover every commit in range.

Word-overlap matching — the old, probabilistic path — survives only as a
fallback, for fragments that declare nothing *and* for fragments whose every
declaration matched no commit in range (a stale declaration behaves exactly like
no declaration, so a rebase or a reworded subject can never turn a passing gate
red). Declarations only ever add coverage.

Usage:
    python3 .claude/scripts/changelog_backfill.py [options]

Options:
    --since TAG     Compare against a specific tag OR commit (default: last tag).
                    A commit SHA works too, so CI can scope to a PR's merge-base.
    --pr N          The pull request being checked. Lets a fragment claiming
                    "#N" cover every commit in range. Omitted locally, where
                    there is no PR — so a local run is the stricter one.
    --dry-run       Show what would be added without writing files
    --json          Output as JSON for programmatic consumption
    --apply         Write fragment files for the missing entries
    --check         Exit non-zero if any user-facing commit lacks a fragment.
                    Writes nothing — the PR-time gate and a local pre-flight both
                    use this to catch a missing fragment before it reaches main.
    --validate      Only check that fragments are well formed; no coverage check.
                    A separate question from coverage, with a separate audience:
                    CI runs this even for a skip-changelog PR.
    --changed-only  Enforce validity only for fragments changed since --since,
                    reporting the rest without failing. CI passes this so a PR is
                    never red for a stray file it did not touch. A bare local run
                    omits it and validates everything on disk, which is the
                    stricter and better local signal — so a local red on a file
                    you did not write is expected, and is not what CI will say.
    --verbose       Show detailed analysis

Output (JSON mode):
    {
        "success": true,
        "since_tag": "v0.8.0",
        "pr": 426,
        "commits_analyzed": 5,
        "existing_entries": 3,
        "missing_entries": [
            {"section": "Added", "entry": "- Entry text", "commit": "abc1234", "sha": "abc...",
             "original": "feat: ...", "claim": "\\"feat: ...\\"", "suggested_fragment": "…md"}
        ],
        "already_covered": ["abc1234", "def5678"],
        "coverage": [{"commit": "abc1234", "by": "declared", "fragment": "…md", "claim": "…"}],
        "unresolved_claims": [{"fragment": "…md", "claim": "abc1234"}]
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


@dataclass
class Fragment:
    """A parsed fragment from `changelog/unreleased/`.

    `claims` holds the raw `covers:` items (empty for a fragment with no
    frontmatter); `bullets` holds the entry lines from the fragment body, which
    feed the legacy word-overlap fallback. `problems` is non-empty when the file
    is malformed, in which case it contributes neither claims nor bullets.
    """
    name: str
    claims: list[str]
    bullets: list[str]
    problems: list[str]


@dataclass
class Resolution:
    """The outcome of matching every fragment declaration against a commit range.

    - `claimed` maps a full commit SHA to the `(fragment, claim)` that claims it.
    - `fallback_bullets` are the entry lines still eligible for word overlap.
    - `unresolved` lists declarations that matched no commit in range.
    - `blanket` records each PR-level claim and the commits it swept up, so a
      blanket pass can be reported instead of being silently believed.
    """
    claimed: dict[str, tuple[str, str]]
    fallback_bullets: list[str]
    unresolved: list[dict[str, str]]
    blanket: list[dict]


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

# Frontmatter field a fragment uses to declare which commits it covers.
COVERS_FIELD = "covers"

# Token inside the HTML comment marker `changelog-populator.py` writes into
# every seeded fragment's body, directly above the raw entry it derived from
# the commit subject. Its presence means nobody has read that entry yet — a
# commit subject is developer shorthand, not prose written for a user — so a
# fragment carrying it fails validation rather than being free to compile into
# CHANGELOG.md untouched (a technical subject reached PR #1409 verbatim before
# only a human reviewer's attention caught it; nothing structural did). Kept in
# sync with `.claude/git-hooks/changelog-populator.py`, which writes it — the
# two scripts are deliberately standalone (a git hook must not depend on an
# import path).
SEED_MARKER_TOKEN = "dorkos-changelog:seeded"

# The full comment `render_fragment` below writes into a freshly generated
# fragment's body, above its entry. `--apply` writes the same kind of
# unreviewed, commit-subject-derived prose the hook does, so it carries the
# same marker for the same reason. Text kept identical to the hook's copy —
# both explain the fix (rewrite or delete) and point at the same doc anchor.
SEED_MARKER = (
    f"<!-- {SEED_MARKER_TOKEN} — rewrite this bullet for a human, then delete "
    "this comment. If the change needs no changelog entry, delete the whole "
    "fragment instead. See changelog/README.md#seeded-fragments. -->"
)

# The six Keep a Changelog (https://keepachangelog.com/en/1.0.0/) categories
# release.md step 6.4 tells whoever is compiling a release to merge, plus one
# established exception this repo already relies on: "Note for people
# upgrading" is not a Keep a Changelog category, but it has shipped verbatim in
# CHANGELOG.md three times (PRs #621, #493, #606; still there in the v0.57.0
# notes) and is documented as allowed in changelog/README.md.
#
# Compiling a release is a person or an agent following release.md's
# instructions, not an automated script, so a heading outside this set is not
# GUARANTEED to be dropped — a careful compiler can carry one forward by hand,
# which is exactly what happened to the fragment that prompted DOR-1635 (its
# `### Docs` bullet survived, folded into the neighboring Security entry by
# whoever ran that release). What nothing catches is the MISTAKE: step 6.4
# names six headings by name, so anything outside this set is invisible to
# that instruction and depends entirely on whoever is compiling noticing it
# anyway (DOR-1635, third sighting of the same trap in one program — the other
# two, `### Improved` and a near-miss `### Docs`, were not caught by a careful
# compiler).
VALID_CATEGORIES = {"Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"}
ALLOWED_HEADINGS = VALID_CATEGORIES | {"Note for people upgrading"}

# A fragment's category heading, e.g. `### Added`. Captures the heading text so
# it can be checked against `ALLOWED_HEADINGS`.
HEADING_RE = re.compile(r"^###\s+(.+?)\s*$")

# Shapes a `covers:` item can take. Anything matching neither is a commit
# subject line — a conventional-commit subject always contains ": ", so it can
# never be mistaken for a bare SHA or a "#123" pull-request reference.
SHA_CLAIM_RE = re.compile(r"^[0-9a-f]{7,40}$")
PR_CLAIM_RE = re.compile(r"^#(\d+)$")

# A conventional-commit subject, used only to recognise a claim line that leaked
# into a fragment's body (see `find_fragment_problems`). Two deliberate
# narrowings keep a legitimate changelog bullet from being mistaken for a claim,
# because that false red is repo-wide (the malformed check spans every fragment,
# not just the PR's own) and the remediation it prints would be wrong:
#   1. The commit types are enumerated rather than matched as `\w+`, so a bullet
#      quoting a UI string — `- "Sort: nothing after it"` — is not a subject.
#   2. The match is case-SENSITIVE. Eight of the eleven types are ordinary
#      English words that open a quoted label, so ignoring case would flag
#      `- "Fix: sign in again"` and `- "Test: connection failed"`. Conventional
#      types are lowercase by convention and the populator hook writes them
#      lowercase, so case sensitivity costs nothing.
CONVENTIONAL_SUBJECT_RE = re.compile(
    r"^(feat|fix|refactor|perf|docs|style|test|build|ci|chore|revert)"
    r"(\([^)]*\))?!?:\s+\S"
)

# GitHub appends " (#123)" to the subject of a squash-merged commit, so the
# subject a fragment declared pre-merge no longer matches it byte for byte.
# Stripped from both sides before comparing.
TRAILING_PR_REF_RE = re.compile(r"\s*\(#\d+\)\s*$")


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


def get_changed_fragment_names(since: str) -> set[str]:
    """Fragment filenames touched between `since` and HEAD.

    Used to scope *validity* enforcement to the fragments a PR actually wrote, so
    a stray malformed fragment on main can never red-light an innocent branch.
    Compares committed state only, which is why the bare local run does not use it
    (an uncommitted fragment would look untouched).

    Raises on a git failure rather than guessing: silently widening the scope
    would blame the wrong author, and silently narrowing it would wave a defect
    through.

    The pathspec is root-anchored (`:/`) on purpose. A bare `changelog/unreleased/`
    resolves relative to the current directory, while `read_fragments` locates the
    same directory from `get_vault_root()` — so running from a package directory,
    which is routine in this monorepo, would report zero changed fragments and
    demote the caller's own broken fragment to an untouched stray. That is this
    mode failing open, which is precisely what the paragraph above refuses.
    """
    result = subprocess.run(
        ["git", "diff", "--name-only", f"{since}..HEAD", "--", ":/changelog/unreleased/"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"could not list changed fragments for {since}..HEAD: "
            f"{result.stderr.strip() or 'git diff failed'}"
        )
    return {
        Path(line).name
        for line in result.stdout.strip().split("\n")
        if line.strip().endswith(".md")
    }


def annotate_malformed(fragments: list, changed: Optional[set]) -> list[dict]:
    """Flatten fragment problems, marking which ones this run is responsible for.

    `changed is None` means every fragment is in scope (the local run's stricter
    default). Otherwise only the fragments in `changed` are enforced; the rest are
    reported without failing.
    """
    return [
        {
            "fragment": fragment.name,
            "problem": problem,
            "in_scope": changed is None or fragment.name in changed,
        }
        for fragment in fragments
        for problem in fragment.problems
    ]


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


def unquote_yaml_scalar(raw: str) -> str:
    """Strip the quoting from a YAML scalar, honouring the two quoted forms.

    Fragment `covers:` items are quoted because a commit subject contains ": "
    (which YAML would read as a mapping) and a "#123" pull-request reference
    starts with YAML's comment character. Unquoted items are returned as-is, so
    a bare SHA needs no ceremony.
    """
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def quote_yaml_scalar(value: str) -> str:
    """Render a `covers:` item as a double-quoted YAML scalar."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def split_frontmatter(text: str) -> tuple[list[str], list[str]]:
    """Split a fragment into (frontmatter_lines, body_lines).

    Frontmatter is optional: a fragment whose first meaningful line is not `---`
    has none, and every line is body. A leading BOM and leading blank lines are
    tolerated, because they are invisible in an editor and would otherwise
    silently demote a real declaration to body text.

    An unterminated `---` block yields no frontmatter, so a stray delimiter can
    never swallow a fragment's bullets. `find_fragment_problems` then catches the
    orphaned claim lines: they must never reach the word-overlap pool, where a raw
    commit subject would act as a wildcard.
    """
    lines = text.lstrip("﻿").split("\n")
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    if first is None or lines[first].strip() != "---":
        return [], lines
    for i in range(first + 1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            return lines[first + 1:i], lines[i + 1:]
    return [], lines


def find_fragment_problems(body: list[str]) -> list[str]:
    """Report claim-shaped content stranded in a fragment's body, or a body
    nobody has rewritten yet.

    A malformed declaration must never be quieter than no declaration. When the
    frontmatter delimiters are wrong (an unterminated `---`, a `covers:` key with
    no block at all), the claim lines fall through to the body, and a raw commit
    subject sitting there as a bullet matches almost any similar commit under word
    overlap. That is a false green, and Prettier happily reformats the mistake
    into something that looks intentional. So: refuse to guess, and say what to
    fix.

    The same refusal covers a fragment `changelog-populator.py` seeded and
    nobody has touched since: its entry is the commit subject reshaped just
    enough to look like a bullet, never prose written for a user. The hook
    marks its own output with a `SEED_MARKER_TOKEN` HTML comment for exactly
    this reason, so this function does not need to guess whether a bullet was
    rewritten — it only needs to notice the marker is still there.
    """
    problems: list[str] = []
    for raw in body:
        line = raw.strip()
        if not line:
            continue
        if SEED_MARKER_TOKEN in line:
            problems.append(
                "this fragment was auto-seeded from the commit subject and its "
                "entry has not been rewritten. A commit subject is developer "
                "shorthand, not prose written for a user — rewrite the bullet "
                "for a human, then delete this comment line. If the change "
                "needs no changelog entry at all, delete the whole fragment "
                f"instead. The `{COVERS_FIELD}:` declaration is correct as-is; "
                "leave it alone. See changelog/README.md#seeded-fragments."
            )
            continue
        if line.lower().startswith(COVERS_FIELD + ":"):
            problems.append(
                f"`{COVERS_FIELD}:` appears in the body, not in a frontmatter block. "
                "The declaration must sit between a `---` line at the very top of "
                "the file and a closing `---` line."
            )
            continue
        heading = HEADING_RE.match(line)
        if heading and heading.group(1) not in ALLOWED_HEADINGS:
            problems.append(
                f"`### {heading.group(1)}` is not a heading release.md's compile "
                f"step knows to merge ({', '.join(sorted(ALLOWED_HEADINGS))}). "
                "Nothing automatically catches a bullet under any other heading — "
                "it depends on whoever compiles the release noticing it by hand, "
                "which is not a rule you can count on (see changelog/README.md)."
            )
            continue
        if not line.startswith("- "):
            continue
        item = line[2:].strip()
        unquoted = unquote_yaml_scalar(item)
        looks_like_claim = (
            SHA_CLAIM_RE.match(unquoted.lower())
            or PR_CLAIM_RE.match(unquoted)
            or (item != unquoted and CONVENTIONAL_SUBJECT_RE.match(unquoted))
        )
        if looks_like_claim:
            problems.append(
                f"the entry line `- {item}` is a `{COVERS_FIELD}:` item stranded in "
                "the body. Move it inside the frontmatter block, or delete it."
            )
    return problems


def parse_covers(frontmatter_lines: list[str]) -> list[str]:
    """Extract the `covers:` items from a fragment's frontmatter lines.

    Supports the block form (`covers:` followed by `- item` lines) and the inline
    form (`covers: [a, b]` / `covers: a`). Deliberately hand-rolled: this script
    is pure-stdlib so CI needs no install step, and PyYAML is not in the stdlib.
    """
    claims: list[str] = []
    i = 0
    while i < len(frontmatter_lines):
        line = frontmatter_lines[i]
        stripped = line.strip()
        i += 1
        if not stripped.startswith(COVERS_FIELD + ":"):
            continue
        inline = stripped[len(COVERS_FIELD) + 1:].strip()
        if inline:
            if inline.startswith("[") and inline.endswith("]"):
                inline = inline[1:-1]
                claims.extend(
                    unquote_yaml_scalar(part) for part in split_inline_items(inline)
                )
            else:
                claims.append(unquote_yaml_scalar(inline))
            continue
        # Block form: consume the following list items.
        while i < len(frontmatter_lines):
            item = frontmatter_lines[i].strip()
            if not item or item.startswith("#"):
                i += 1
                continue
            if not item.startswith("- "):
                break
            claims.append(unquote_yaml_scalar(item[2:]))
            i += 1
    return [c for c in claims if c]


def split_inline_items(inline: str) -> list[str]:
    """Split an inline YAML flow sequence's body on commas, respecting quotes."""
    items: list[str] = []
    current = ""
    quote = ""
    for char in inline:
        if quote:
            current += char
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
            current += char
            continue
        if char == ",":
            items.append(current)
            current = ""
            continue
        current += char
    items.append(current)
    return [item.strip() for item in items if item.strip()]


def read_fragments(unreleased_dir: Path) -> list[Fragment]:
    """Read every fragment in changelog/unreleased/ with its claims and bullets.

    A malformed fragment yields neither claims nor bullets: its stranded claim
    lines must not reach the word-overlap pool, where they would act as wildcards.
    """
    fragments: list[Fragment] = []
    if not unreleased_dir.is_dir():
        return fragments
    for frag in sorted(unreleased_dir.glob("*.md")):
        frontmatter, body = split_frontmatter(frag.read_text(encoding="utf-8"))
        problems = find_fragment_problems(body)
        bullets = (
            []
            if problems
            else [line.strip() for line in body if line.strip().startswith("- ")]
        )
        fragments.append(
            Fragment(
                name=frag.name,
                claims=[] if problems else parse_covers(frontmatter),
                bullets=bullets,
                problems=problems,
            )
        )
    return fragments


def classify_claim(claim: str) -> tuple[str, object]:
    """Classify a `covers:` item as ("pr", int) | ("sha", str) | ("subject", str)."""
    pr_match = PR_CLAIM_RE.match(claim)
    if pr_match:
        return "pr", int(pr_match.group(1))
    if SHA_CLAIM_RE.match(claim.lower()):
        return "sha", claim.lower()
    return "subject", claim


def normalize_subject(subject: str) -> str:
    """A commit subject with any trailing ` (#123)` removed, for comparison.

    GitHub's squash-merge appends the PR number to the subject, so a declaration
    written pre-merge would otherwise stop matching its own commit the moment it
    lands on main — which is exactly the release-time false red this change is
    meant to remove.
    """
    return TRAILING_PR_REF_RE.sub("", subject.strip()).strip()


def resolve_claims(
    fragments: list[Fragment],
    commits_raw: list[tuple[str, str]],
    pr_number: Optional[int] = None,
) -> Resolution:
    """Match every fragment's declarations against the commits in range.

    Specific claims (subject, SHA) are resolved first; a PR-level `#N` claim then
    sweeps up only what nothing else named. Coverage is the same set either way,
    but the ordering makes attribution honest, so the blanket report shows exactly
    which commits rode in on it and nothing else.

    A fragment keeps its word-overlap fallback unless at least one of its
    declarations resolved. That is what makes this change safe: a rebase (which
    rewrites every SHA) or a reworded commit subject leaves the declaration
    matching nothing, and the fragment degrades to exactly its old behaviour
    instead of turning the gate red.
    """
    claimed: dict[str, tuple[str, str]] = {}
    unresolved: list[dict[str, str]] = []
    blanket: list[dict] = []
    resolved_fragments: set[str] = set()
    pr_claims: list[tuple[Fragment, str, int]] = []

    for fragment in fragments:
        for claim in fragment.claims:
            kind, value = classify_claim(claim)
            if kind == "pr":
                # Deferred to the second pass, below.
                pr_claims.append((fragment, claim, value))
                continue
            if kind == "sha":
                # `git log --pretty=%H` yields full SHAs, so a short claim is
                # always the prefix, never the other way round.
                matched = [(sha, msg) for sha, msg in commits_raw if sha.startswith(value)]
            else:
                target = normalize_subject(value)
                matched = [
                    (sha, msg) for sha, msg in commits_raw if normalize_subject(msg) == target
                ]

            if not matched:
                unresolved.append({"fragment": fragment.name, "claim": claim})
                continue

            resolved_fragments.add(fragment.name)
            for sha, _msg in matched:
                claimed.setdefault(sha, (fragment.name, claim))

    for fragment, claim, value in pr_claims:
        if value != pr_number:
            unresolved.append({"fragment": fragment.name, "claim": claim})
            continue
        # The claim names this PR, so it is a deliberate declaration whether or
        # not anything is left for it to sweep.
        resolved_fragments.add(fragment.name)
        swept = [(sha, msg) for sha, msg in commits_raw if sha not in claimed]
        for sha, _msg in swept:
            claimed[sha] = (fragment.name, claim)
        blanket.append(
            {
                "fragment": fragment.name,
                "claim": claim,
                "commits": [{"sha": sha, "subject": msg} for sha, msg in swept],
            }
        )

    fallback_bullets: list[str] = []
    for fragment in fragments:
        if fragment.name not in resolved_fragments:
            fallback_bullets.extend(fragment.bullets)

    return Resolution(
        claimed=claimed,
        fallback_bullets=fallback_bullets,
        unresolved=unresolved,
        blanket=blanket,
    )


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


def suggested_fragment_name(commit: Commit) -> str:
    """The filename a new fragment for this commit would get."""
    return f"{get_commit_stamp(commit.sha)}-{slugify(commit.description)}.md"


def analyze_and_generate(
    since_tag: Optional[str] = None,
    verbose: bool = False,
    pr_number: Optional[int] = None,
    changed_only: bool = False,
) -> dict:
    """
    Analyze commits and generate missing changelog entries.

    Coverage is decided by fragment `covers:` declarations first (deterministic),
    then by word overlap against fragments that declared nothing — see the module
    docstring. Returns a dictionary with analysis results.
    """
    vault_root = get_vault_root()
    unreleased_dir = vault_root / "changelog" / "unreleased"

    # Get tag to compare against
    if since_tag is None:
        since_tag = get_last_tag()

    result = {
        "success": True,
        "since_tag": since_tag,
        "pr": pr_number,
        "commits_analyzed": 0,
        "existing_entries": 0,
        "missing_entries": [],
        "already_covered": [],
        "coverage": [],
        "unresolved_claims": [],
        "blanket_claims": [],
        "claims_on_skipped_commits": [],
        "malformed_fragments": [],
        "changed_only": False,
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

    # Read fragments, then resolve their declarations against the commits in range.
    # A malformed fragment contributes nothing and is reported separately: it must
    # never be quieter than a fragment with no declaration at all.
    fragments = read_fragments(unreleased_dir)
    changed = get_changed_fragment_names(since_tag) if changed_only and since_tag else None
    result["changed_only"] = changed is not None
    result["malformed_fragments"] = annotate_malformed(fragments, changed)
    resolution = resolve_claims(fragments, commits_raw, pr_number)
    claimed = resolution.claimed
    fallback_bullets = resolution.fallback_bullets
    result["existing_entries"] = sum(len(f.bullets) for f in fragments)
    result["unresolved_claims"] = resolution.unresolved

    user_facing_shas = {c.sha for c in parsed_commits}
    blanket_shas: set[str] = set()
    for entry in resolution.blanket:
        blanket_shas.update(c["sha"] for c in entry["commits"])
        covered = [c for c in entry["commits"] if c["sha"] in user_facing_shas]
        if covered:
            result["blanket_claims"].append({
                "fragment": entry["fragment"],
                "claim": entry["claim"],
                "commits": [
                    {"commit": c["sha"][:7], "subject": c["subject"]} for c in covered
                ],
            })

    # A claim that resolves against a chore/docs commit still costs its fragment
    # the word-overlap fallback, which otherwise reads as an inexplicable red.
    subjects = dict(commits_raw)
    result["claims_on_skipped_commits"] = [
        {
            "fragment": fragment,
            "claim": claim,
            "commit": sha[:7],
            "subject": subjects.get(sha, ""),
        }
        for sha, (fragment, claim) in claimed.items()
        if sha not in user_facing_shas and sha not in blanket_shas
    ]

    if verbose:
        declared = sum(1 for f in fragments if f.claims)
        print(
            f"Found {len(fragments)} fragment(s) in changelog/unreleased/ "
            f"({declared} with a `{COVERS_FIELD}:` declaration, "
            f"{result['existing_entries']} entry line(s))",
            file=sys.stderr,
        )

    # Find missing entries
    for commit in parsed_commits:
        claim = claimed.get(commit.sha)
        if claim is not None:
            fragment_name, claim_text = claim
            result["already_covered"].append(commit.short_sha)
            result["coverage"].append({
                "commit": commit.short_sha,
                "by": "declared",
                "fragment": fragment_name,
                "claim": claim_text,
            })
            if verbose:
                print(
                    f"  [claimed]  {commit.short_sha}: {fragment_name} covers {claim_text!r}",
                    file=sys.stderr,
                )
        elif is_covered_by_entries(commit, fallback_bullets):
            result["already_covered"].append(commit.short_sha)
            result["coverage"].append({
                "commit": commit.short_sha,
                "by": "word-overlap",
                "fragment": None,
                "claim": None,
            })
            if verbose:
                print(f"  [overlap]  {commit.short_sha}: {commit.description}", file=sys.stderr)
        else:
            section = PREFIX_SECTION_MAP[commit.prefix]
            entry = transform_to_user_friendly(commit)

            result["missing_entries"].append({
                "section": section,
                "entry": entry,
                "commit": commit.short_sha,
                "sha": commit.sha,
                "description": commit.description,
                "original": commit.message,
                "claim": quote_yaml_scalar(commit.message),
                "suggested_fragment": suggested_fragment_name(commit),
            })
            if verbose:
                print(f"  [MISSING]  {commit.short_sha}: {commit.description}", file=sys.stderr)

    return result


def render_fragment(section: str, entry: str, claims: list[str]) -> str:
    """Render fragment file contents: a `covers:` frontmatter block, a seed
    marker, then the entry.

    `--apply` writes the commit subject reshaped into a bullet, same as the
    post-commit hook does — nobody has read this entry yet either, so it
    fails `--validate` until the marker is gone. See `SEED_MARKER` above.
    """
    body = f"### {section}\n\n{SEED_MARKER}\n{entry}\n"
    if not claims:
        return body
    lines = ["---", f"{COVERS_FIELD}:"]
    lines.extend(f"  - {quote_yaml_scalar(claim)}" for claim in claims)
    lines.extend(["---", ""])
    return "\n".join(lines) + "\n" + body


def write_fragments(entries: list[dict], unreleased_dir: Path) -> int:
    """Write one fragment file per missing entry. Returns the number written.

    Each fragment declares the commit it covers by subject line, so the entry
    text stays free to be rewritten for a human without breaking the gate.
    """
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
        claims = [e["original"]] if e.get("original") else []
        (unreleased_dir / name).write_text(
            render_fragment(e["section"], e["entry"], claims), encoding="utf-8"
        )
        written += 1

    return written


def in_scope_malformed(result: dict) -> list[dict]:
    """Malformed fragments this run is responsible for failing on."""
    return [m for m in result["malformed_fragments"] if m["in_scope"]]


def out_of_scope_malformed(result: dict) -> list[dict]:
    """Malformed fragments on disk that this run only reports."""
    return [m for m in result["malformed_fragments"] if not m["in_scope"]]


def print_malformed_fragments(result: dict) -> None:
    """Report the malformed fragments this run enforces, to stderr."""
    # stdout is block-buffered when piped (as in CI); flush so the summary line
    # printed there does not surface after this report.
    sys.stdout.flush()
    malformed = in_scope_malformed(result)
    print(
        f"\nchangelog gate FAILED: {len(malformed)} malformed fragment(s) in "
        "changelog/unreleased/. A broken declaration is refused rather than "
        "guessed at: its\nclaim lines would otherwise sit in the fragment body, "
        "where a raw commit subject\nmatches almost any similar commit and quietly "
        "passes this check for good.\n",
        file=sys.stderr,
    )
    for item in malformed:
        print(f"  changelog/unreleased/{item['fragment']}", file=sys.stderr)
        print(f"      {item['problem']}", file=sys.stderr)
    print(
        "\n  A well-formed fragment starts on line 1 with `---`, then "
        f"`{COVERS_FIELD}:` and its\n"
        "  items, then a closing `---`, then the `### Category` body. See "
        "changelog/README.md.",
        file=sys.stderr,
    )


def print_stray_malformed(result: dict) -> None:
    """Name malformed fragments this run will not fail on, on stdout.

    A stray broken fragment is somebody else's defect: failing here would punish
    an author for a file they never touched, which is the shared-blast-radius
    problem this gate must not have. Staying silent is worse than failing though,
    so it is named on every passing run until someone fixes it.
    """
    strays = out_of_scope_malformed(result)
    if not strays:
        return
    print(
        f"NOTE: {len(strays)} malformed fragment(s) already on disk, not touched by "
        "this change:"
    )
    for item in strays:
        print(f"        changelog/unreleased/{item['fragment']}")
        print(f"            {item['problem']}")
    print(
        "      Not failing this run — you did not write them. Their `covers:` "
        "declarations are\n"
        "      ignored until fixed, so they claim nothing. Whoever added them "
        "should repair them."
    )


def print_gate_failure(result: dict) -> None:
    """Print the actionable failure report for `--check`, to stderr.

    Each uncovered commit gets the exact `covers:` line to paste and the exact
    path a new fragment would take; the new-fragment template is printed once, not
    once per commit. Diagnostics go to stderr so a `--json` consumer still gets
    clean JSON on stdout.
    """
    sys.stdout.flush()
    missing = result["missing_entries"]
    since = result["since_tag"] or "the base commit"
    print(
        f"\nchangelog gate FAILED: {len(missing)} user-facing commit(s) since "
        f"{since} are not covered by any fragment in changelog/unreleased/.\n",
        file=sys.stderr,
    )
    print(
        f"  Claim each commit below from a fragment's `{COVERS_FIELD}:` list, by "
        "pasting its\n  claim line verbatim. Or start a new fragment at the path "
        "shown.\n",
        file=sys.stderr,
    )

    for entry in missing:
        print(f"  [uncovered] {entry['commit']}  {entry['original']}", file=sys.stderr)
        print(f"      claim line:  - {entry['claim']}", file=sys.stderr)
        print(
            f"      or new file: changelog/unreleased/{entry['suggested_fragment']}",
            file=sys.stderr,
        )

    example = missing[0]
    print(
        f"\n  A new fragment looks like this (shown for {example['commit']}); "
        "rewrite the bullet\n  for a human afterwards, the declaration is what "
        "this check reads:\n",
        file=sys.stderr,
    )
    for line in render_fragment(
        example["section"], example["entry"], [example["original"]]
    ).rstrip("\n").split("\n"):
        print(f"      {line}" if line else "", file=sys.stderr)

    if result["claims_on_skipped_commits"]:
        print(
            f"\n  Careful: {len(result['claims_on_skipped_commits'])} declaration(s) "
            "resolved against a commit\n  this check ignores (chore/docs/ci). A "
            "fragment that claims one of those counts as\n  declared, so it no "
            "longer falls back to matching by wording — which can be why a\n  "
            "commit above looks uncovered:",
            file=sys.stderr,
        )
        for item in result["claims_on_skipped_commits"]:
            print(
                f"      {item['fragment']} claims {item['commit']}  {item['subject']}",
                file=sys.stderr,
            )

    if result["unresolved_claims"]:
        print(
            f"\n  Note: {len(result['unresolved_claims'])} `{COVERS_FIELD}:` "
            "declaration(s) matched no commit in this\n  range. That is normal for "
            "fragments from earlier PRs, but a typo'd SHA looks the\n  same — rerun "
            "with --verbose to list them.",
            file=sys.stderr,
        )

    print(
        f"\n  A `{COVERS_FIELD}:` declaration is the whole point: it decouples the "
        "gate from your\n"
        "  prose, so you can write the bullet for a human without breaking the "
        "check.\n"
        "  See changelog/README.md and the writing-changelogs skill. If the "
        "change is\n"
        "  deliberately not user-facing, label the PR 'skip-changelog' instead.",
        file=sys.stderr,
    )


def print_blanket_claims(result: dict) -> None:
    """Name every commit a PR-level `#N` claim swept up, on stdout.

    A blanket claim is a legitimate escape hatch, but an unbounded one: it asserts
    that commits with no changelog prose of their own need none. Silence would let
    a forgotten change ship behind a green check, so the passing summary always
    says which commits rode in on the blanket, and points at the honest tool for a
    whole-PR opt-out.
    """
    for item in result["blanket_claims"]:
        print(
            f"NOTE: a PR-level claim ({item['claim']} in {item['fragment']}) covers "
            f"{len(item['commits'])} user-facing\n"
            "      commit(s) that no fragment names individually:"
        )
        for commit in item["commits"]:
            print(f"        {commit['commit']}  {commit['subject']}")
    if result["blanket_claims"]:
        print(
            "      That asserts these changes need no changelog prose. If one of "
            "them does,\n"
            "      claim it individually. If the whole PR needs no changelog, the "
            "honest tool\n"
            "      is the `skip-changelog` label, not a blanket claim."
        )


def run_validate(args) -> int:
    """`--validate`: are the fragments well formed? Coverage is not consulted.

    Split out from `--check` on purpose. Validity and coverage answer different
    questions and belong to different people: a broken fragment is the defect of
    whoever wrote it, and must be caught even on a PR that owes no changelog entry
    at all (`skip-changelog`). Coverage is about this PR's commits and keeps its
    own bypass. Running them as one step forced a single scope on both, which is
    what let a broken fragment in through the skip door and then charged the next
    innocent PR for it.
    """
    vault_root = get_vault_root()
    fragments = read_fragments(vault_root / "changelog" / "unreleased")
    changed = (
        get_changed_fragment_names(args.since)
        if args.changed_only and args.since
        else None
    )
    result = {
        "success": True,
        "since_tag": args.since,
        "changed_only": changed is not None,
        "fragments_read": len(fragments),
        "fragments_in_scope": len(fragments) if changed is None else len(changed),
        "malformed_fragments": annotate_malformed(fragments, changed),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        scope = (
            f"{len(changed)} fragment(s) changed since {args.since}"
            if changed is not None
            else f"all {len(fragments)} fragment(s) in changelog/unreleased/"
        )
        print(f"changelog fragment validity: checked {scope}.")
        print_stray_malformed(result)

    if in_scope_malformed(result):
        print_malformed_fragments(result)
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Analyze commits and generate missing changelog fragments"
    )
    parser.add_argument(
        "--since",
        help="Compare against specific tag (default: last tag)"
    )
    parser.add_argument(
        "--pr",
        type=int,
        help="Pull request number, so a fragment claiming '#N' covers this PR's commits"
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
        "--validate",
        action="store_true",
        help="Only check that fragments are well formed; skip the coverage check "
             "entirely. CI runs this even for a skip-changelog PR, because a "
             "broken fragment is a defect whether or not the PR owes an entry."
    )
    parser.add_argument(
        "--changed-only",
        action="store_true",
        help="Enforce fragment validity only for fragments changed since --since, "
             "reporting the rest without failing. CI uses this so a PR is never "
             "red for a stray file it did not touch. Coverage is unaffected."
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed analysis"
    )

    args = parser.parse_args()

    if args.validate:
        return run_validate(args)

    # Run analysis
    result = analyze_and_generate(
        since_tag=args.since,
        verbose=args.verbose,
        pr_number=args.pr,
        changed_only=args.changed_only,
    )

    # Output
    if args.json:
        print(json.dumps(result, indent=2))
    elif args.check:
        # Gate mode keeps stdout to a summary line plus any blanket-claim
        # disclosure; the failure reports below own stderr.
        covered = len(result["already_covered"])
        total = covered + len(result["missing_entries"])
        print(
            f"changelog gate: {total} user-facing commit(s) since "
            f"{result['since_tag'] or 'the base commit'}, {covered} covered, "
            f"{len(result['missing_entries'])} uncovered."
        )
        print_blanket_claims(result)
        print_stray_malformed(result)
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

    if args.verbose and result['unresolved_claims']:
        print(
            f"\n{len(result['unresolved_claims'])} `{COVERS_FIELD}:` declaration(s) "
            "matched no commit in range (expected for fragments from earlier PRs):",
            file=sys.stderr,
        )
        for unresolved in result['unresolved_claims']:
            print(
                f"  {unresolved['fragment']}: {unresolved['claim']}",
                file=sys.stderr,
            )

    # Apply if requested
    if args.apply and result['missing_entries']:
        vault_root = get_vault_root()
        unreleased_dir = vault_root / "changelog" / "unreleased"
        written = write_fragments(result['missing_entries'], unreleased_dir)
        if not args.json:
            print(f"\nWrote {written} fragment(s) to changelog/unreleased/.")

    # Gate mode: fail on a malformed fragment or an uncovered user-facing commit.
    # A malformed fragment fails on its own, even when nothing is uncovered:
    # silently ignoring it is how it becomes a permanent wildcard. Only fragments
    # in scope can fail this run — see `print_stray_malformed` for the rest.
    failed = False
    if result['malformed_fragments']:
        if args.check and in_scope_malformed(result):
            print_malformed_fragments(result)
            failed = True
        elif not args.json and not args.check:
            print(
                f"\nWarning: {len(result['malformed_fragments'])} malformed "
                "fragment(s) ignored — run with --validate for details.",
                file=sys.stderr,
            )
    if args.check and result['missing_entries']:
        print_gate_failure(result)
        failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
