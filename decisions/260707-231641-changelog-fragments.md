---
id: 260707-231641
title: Changelog fragments — one file per change, compiled at release
status: accepted
created: 2026-07-07
spec: null
superseded-by: null
---

# 260707-231641. Changelog fragments — one file per change, compiled at release

## Status

Accepted (implemented in PR `chore/changelog-fragments`)

## Context

`CHANGELOG.md`'s single `[Unreleased]` section was edited by nearly every branch — 255 commits
touched the file in one three-month window — so almost every merge across DorkOS's parallel agent
worktrees collided there. A `post-commit` hook (`changelog-populator.py`) re-appended an entry from
each commit subject, which is precisely the conflict engine: two branches insert into the same
multi-section block at the same anchor, and git's default text driver (the one GitHub's server-side
merge also uses) conflicts. Three incident logs in `.temp/conflict-incidents/` and research
`20260703_multi_agent_merge_conflict_prevention.md` document the pattern. The file had also grown to
1,633 lines (with `docs/changelog.mdx` mirroring it at 1,502), bloating every diff and every agent's
context.

Research `20260703` initially chose a **sentinel-anchor** changelog pattern (its Decided-direction
item 3): append each entry above a fixed placeholder line. Its own empirical merge harness
(`.claude/scripts/__tests__/merge-behavior.test.ts`) then **disproved** that a sentinel prevents
same-section concurrent inserts — both branches still insert at the same line and conflict. The same
harness proved that distinct per-entry files never add/add-conflict, matching the coordination-free
timestamp-id scheme already adopted for ADRs and specs (ADR-0312).

## Decision

**Unreleased changelog entries live as one fragment file per change under `changelog/unreleased/`,
never in `CHANGELOG.md`.** A fragment is named `<YYMMDD-HHMMSS>-<slug>.md` (timestamp id from
`.claude/scripts/id.ts` + a short slug) and holds one or more Keep a Changelog `### Category`
sections with bullets. The `post-commit` hook writes a fragment per conventional commit instead of
editing `CHANGELOG.md`, deduping by entry line so amends/rebases never double an entry.

**Only `/system:release` writes `CHANGELOG.md`.** At release it compiles every fragment (sorted by
filename, merged per category) into a new `## [X.Y.Z]` section, deletes the fragments, and enforces
a **10-version cap**: older sections move byte-for-byte (with their link-reference definitions) into
`changelog/archive/`, and `docs/changelog.mdx` mirrors the 10 newest with an archive page for the
rest. This migration archived 40 of the 50 existing versions and moved the ~120 in-flight
`[Unreleased]` entries into a single `pre-fragment-backlog` fragment.

This **supersedes the sentinel-anchor direction** (item 3) of research `20260703`: fragments
_eliminate_ the conflict class rather than reduce it, and they also fix the file-length and
AI-context problems the sentinel left untouched.

## Consequences

### Positive

- Parallel worktrees never conflict on changelog entries — distinct filenames are the only hard
  guarantee git's default driver honors (verified in `merge-behavior.test.ts`), and it works on
  GitHub's merge button, unlike merge drivers.
- `CHANGELOG.md` shrank from 1,633 to ~330 lines; released history is preserved in
  `changelog/archive/` and `docs/changelog-archive.mdx`.
- The post-commit hook's amend/rebase re-fires are now safe (dedup by entry line), and it can no
  longer dirty `CHANGELOG.md` in a sibling worktree.

### Negative

- One more moving part: a `changelog/unreleased/` directory and a compile step at release. Fragments
  must be curated before a PR (the hook's raw subject line is rarely release-quality prose).
- The compiled `## [X.Y.Z]` section only exists after release, so there is no single file to skim
  for "what's unreleased" — you read the fragments directory instead.
- A release commit now also deletes fragments and may rewrite the archive, making it larger than a
  pure version bump.

## Alternatives considered

- **`merge=union` / a custom JSON or changelog merge driver.** Rejected: driver config lives in
  `.git/config`, is never cloned, and fails silently when absent; and neither `union` nor custom
  drivers run on GitHub's server-side merge, which is our actual merge path. `union` also interleaves
  and mis-files entries in a multi-section block (scikit-learn #21516).
- **Changesets.** Rejected: its per-package versioning model mismatches DorkOS's single-`VERSION`
  product, and it would add a heavier toolchain than one markdown file per change needs.
- **Generate the changelog from commits only (drop the curated entry entirely).** Rejected: raw
  commit subjects collapse changelog quality (developer-focused, not user-focused). Commit-derived
  generation is retained only as the `/changelog:backfill` fallback for changes that shipped without
  a fragment.
- **Sentinel-anchor block in `CHANGELOG.md`** (the prior research direction). Rejected: empirically
  does not prevent same-section concurrent-insert conflicts, and does nothing for file length.
