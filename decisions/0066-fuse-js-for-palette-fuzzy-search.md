---
number: 66
title: Use Fuse.js for Command Palette Fuzzy Search
status: draft
created: 2026-03-03
spec: command-palette-10x
superseded-by: null
---

# 66. Use Fuse.js for Command Palette Fuzzy Search

## Status

Draft (auto-extracted from spec: command-palette-10x)

## Context

The global command palette needs fuzzy search with character-level match highlighting. Three options were evaluated: cmdk's built-in filter (no match indices, no highlighting possible), uFuzzy (4kb, precise matching, no typo-tolerance), and Fuse.js (24kb, typo-tolerant, `includeMatches` returns `[start, end]` index pairs). The palette searches agent names, CWD paths, command names, and feature labels — a mix of precise terms and user-typed queries where typo-tolerance provides value.

## Decision

Use Fuse.js with `includeMatches: true` and `shouldFilter={false}` on cmdk. Fuse.js manages all filtering, scoring, and sorting externally. Match indices are rendered as React nodes via a `HighlightedText` component (no raw HTML injection). The threshold is set to 0.3 (tight matching).

## Consequences

### Positive

- Typo-tolerant matching catches "autth" for "Auth Service" — more forgiving for users
- `includeMatches` returns index pairs for character-level highlighting without unsafe HTML APIs
- Well-maintained library with TypeScript support and extensive documentation
- cmdk still handles keyboard navigation, selection, and accessibility via `shouldFilter={false}`

### Negative

- 24kb bundle addition (vs. 4kb for uFuzzy or 0kb for cmdk built-in)
- Typo-tolerance may occasionally surface low-relevance results (mitigated by threshold: 0.3)
- External filtering means cmdk's `filter` prop is bypassed — custom result management required
