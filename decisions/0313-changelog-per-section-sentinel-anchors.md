---
number: 313
title: Per-section sentinel anchors for the CHANGELOG Unreleased block
status: draft
created: 2026-07-03
spec: merge-conflict-prevention
superseded-by: null
---

# 313. Per-section sentinel anchors for the CHANGELOG Unreleased block

## Status

Draft (auto-extracted from spec: merge-conflict-prevention)

## Context

`CHANGELOG.md` `[Unreleased]` is multi-section (`### Added / ### Changed / ### Removed`) and every
branch appends to it via the post-commit populator, so concurrent appends conflict. `merge=union`
is unsafe for a multi-section block (it interleaves and mis-files entries; scikit-learn #21516) and
does not run on GitHub's server-side merge anyway.

## Decision

Place a fixed anchor comment (`<!-- FLOW:ADD-ABOVE <Section> -->`) at the bottom of each
`[Unreleased]` subsection. `changelog-populator.py` inserts each new bullet immediately above the
matching section's anchor, so every branch's insert is a non-overlapping insertion at a stable
line and the default driver merges concurrent appends cleanly, including on GitHub. A dedup pass
removes exact-duplicate bullets from the populator's known cherry-pick/rebase duplication.

## Consequences

### Positive

- Concurrent changelog appends auto-merge with the default driver and on GitHub's merge button.
- No per-clone configuration; entries stay within their correct section.

### Negative

- Requires a populator-hook change plus a dedup pass.
- The anchor comments are visible in the changelog source (benign, but present).
