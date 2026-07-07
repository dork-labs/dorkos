# Changelog fragments

Unreleased changelog entries live here as **one file per change**, not as a shared
`[Unreleased]` block in `CHANGELOG.md`. This is the same coordination-free idea behind
timestamp-id ADRs (ADR-0312): give every change its own uniquely-named file so parallel
branches never touch the same lines.

## Why

DorkOS runs many coding agents in parallel worktrees. A single `[Unreleased]` section in
`CHANGELOG.md` was edited by nearly every branch (255 commits touched it in one three-month
window), so almost every merge collided there — and a `post-commit` hook re-appended entries,
compounding it. Distinct per-change files can never add/add-conflict (verified empirically in
`.claude/scripts/__tests__/merge-behavior.test.ts`). As a bonus, `CHANGELOG.md` stops growing
without bound: only the release process writes it, and old versions are archived out.

See `decisions/260707-231641-changelog-fragments.md` for the full decision record.

## Layout

```
changelog/
├── README.md              # this file
├── unreleased/            # one fragment per change (compiled + deleted at release)
│   └── <id>-<slug>.md
└── archive/               # released version sections aged out of CHANGELOG.md
    └── CHANGELOG-vA-to-vB.md
```

## Fragment filename

```
<YYMMDD-HHMMSS>-<kebab-slug>.md
```

- **`<YYMMDD-HHMMSS>`** — a UTC timestamp id (`.claude/scripts/id.ts`). It orders fragments
  chronologically and, because two branches stamp their own clocks, keeps filenames unique
  without any shared counter.
- **`<kebab-slug>`** — a short (2–6 word) human-readable description, lowercase with hyphens.

Example: `260707-231643-fragment-based-changelog.md`.

## Fragment body

No frontmatter. One or more [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) category
headings — `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`,
`### Security` — each followed by markdown bullets. One fragment may carry more than one
category. Write bullets per the `writing-changelogs` skill: imperative, user-focused, with
references like `(DOR-123)` or `(#42)` where they exist.

```markdown
### Added

- Get a Telegram message when your agent finishes a turn (DOR-123)

### Fixed

- Stop dropping the final token of a streamed reply (#42)
```

## How fragments get created

- **Automatically.** The `post-commit` hook (`.claude/git-hooks/changelog-populator.py`,
  installed via `.claude/scripts/install-git-hooks.sh`) derives a fragment from your
  conventional-commit subject: `feat:` → `### Added`, `fix:` → `### Fixed`,
  `refactor:`/`docs:`/etc. → `### Changed`. `chore:`/`Merge`/`Revert` are skipped. The
  fragment is written and staged into the same commit; it dedupes so an amend or rebase
  never doubles an entry.
- **By hand.** For anything the hook can't phrase well — or a change that spans multiple
  categories — write the fragment yourself. Curate the hook's fragment before opening a PR:
  rewrite it for a user, split or merge categories, add a reference. A good curated fragment
  is worth more than a raw commit-subject line.

**A PR with user-facing changes should include a fragment.** Never edit `CHANGELOG.md`'s
`[Unreleased]` section — it no longer holds entries.

## What happens at release

`/system:release` compiles every fragment in `unreleased/` into the new version section:

1. Collect all fragments, sorted by filename (chronological).
2. For each category in standard order (Added, Changed, Deprecated, Removed, Fixed,
   Security), merge every bullet from every fragment under a single heading.
3. Write that as `## [X.Y.Z] - YYYY-MM-DD` at the top of `CHANGELOG.md`.
4. Delete the compiled fragment files in the release commit.
5. Keep the 10 most recent versions in `CHANGELOG.md`; move any older section (with its
   link-reference) into a file under `archive/`.

Only the release process writes `CHANGELOG.md`.
