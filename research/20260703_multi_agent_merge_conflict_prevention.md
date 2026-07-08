---
title: 'Preventing Multi-Agent Merge Conflicts in Shared Registries (ADR/spec manifests, CHANGELOG)'
date: 2026-07-03
type: external-best-practices
status: active
tags:
  [
    git,
    merge-conflicts,
    gitattributes,
    merge-driver,
    union-merge,
    adr-numbering,
    spec-manifest,
    changelog,
    multi-agent,
    id-allocation,
    flow-plugin,
  ]
sources_count: 30
searches_performed: 'web survey of git merge drivers + union pitfalls + JSON merge tools + testing patterns; source-level read of the /flow plugin and dorkos manifest tooling'
related:
  - '.temp/conflict-incidents/ (3 incident logs, 2026-06-27/28)'
  - 'specs/flow-plugin-extraction/ (#266, DOR-133)'
---

# Preventing Multi-Agent Merge Conflicts in Shared Registries

## Problem

DorkOS runs many AI coding agents concurrently. Recurring merge conflicts cluster in a
small set of shared files, documented across three incident logs in
`.temp/conflict-incidents/`:

- `decisions/manifest.json` and `specs/manifest.json`: JSON registries, each with a
  monotonic `nextNumber` counter plus an array of entries. Two branches independently
  allocate the same next number, producing both a `nextNumber` scalar conflict and an
  add/add collision on the numbered markdown file (e.g. two different `0294-*.md`).
- `CHANGELOG.md`: the `[Unreleased]` block, appended by nearly every branch (a
  post-commit hook re-adds entries), multi-section (`### Added / ### Changed / ### Removed`).
- `pnpm-lock.yaml`: touched by every dependency change; even git's auto-merge is untrustworthy.

Nearly zero application-source conflicts. The friction is entirely in shared registry /
generated files and in counter-allocated identifiers.

## Key findings

### 1. The collision is branch-level, not a filesystem race

The `0294` double-allocation happened because two _branches_ each read their own copy of
`nextNumber: 294` and both chose 294. They were not two processes racing on one file at the
same instant. Consequence: advisory file locking (`flock`) on the manifest does NOT fix this
(it only serializes same-instant, same-machine access). Only a coordination-free ID scheme,
or merge-time allocation on `main`, actually removes branch-level collisions.

### 2. Custom merge drivers and `merge=union` do NOT run on GitHub's merge button

Two hard constraints make merge-time resolution the wrong primary layer for us:

- The `[merge "name"]` driver command lives in `.git/config`, which is never committed or
  cloned. Every checkout and every agent machine needs a bootstrap step (setup script,
  `prepare`/`postinstall`, or `git config include.path`), and its absence fails _silently_
  (git falls back to the default text driver with no warning).
- GitHub (and Bitbucket) server-side merges do not execute custom drivers or `union`.
  DorkOS merges PRs through GitHub, so a driver-based fix would do nothing on the real merge
  path. Drivers only fire on local `git merge` / `rebase` / `cherry-pick`.

Therefore: **prefer structural prevention over merge-time resolution.**

### 3. `union` is unsafe for our multi-section changelog

The gitattributes manpage describes union as leaving added lines "in random order" with no
deduplication. It is safe only for a flat, one-entry-per-line list under a single stable
anchor. Our `[Unreleased]` is multi-section with multi-line entries, which is exactly the
structure that interleaves and mis-files entries (scikit-learn issue #21516 hit this and
reverted). RuboCop uses `merge=union` successfully but only because their changelog is a flat
list, and they still cannot use the GitHub merge button when it conflicts.

Better, GitHub-compatible alternative: the **sentinel-anchor** pattern (GitLab reported ~90%
fewer changelog conflicts). Append every entry _above_ a fixed placeholder line so the default
driver sees non-overlapping insertions. For our multi-section block this means one anchor per
section.

### 4. ID collision is best solved by removing the shared counter

Sequential ADR/spec numbers buy: a short stable cross-reference handle (the dominant reason;
the codebase references "ADR-0231" etc. in thousands of places), rough chronological order,
and directory sort order. None of these require _dense-sequential_ integers; that property is
the only thing that forces a shared counter. Options:

- **Time-based IDs** (`YYMMDD-HHMMSS`): zero coordination, collision-proof in practice,
  lexicographically sortable (chronological), and because legacy IDs are 4 digits starting
  with `0` while new ones start with `2`, legacy sorts cleanly before new. Migration is
  going-forward-only (never renumber existing artifacts). Tradeoff: longer, less pretty handle.
  TypeDoc (#2188) reached the analogous conclusion for its JSON IDs: stabilize IDs, do not keep
  a central counter. **[CHOSEN 2026-07-03: timestamp IDs, going forward.]**
- **Merge-time sequential**: keep dense numbers, assign on merge to `main` via CI. Preserves the
  pretty handle at the cost of the number not existing until merge, plus a post-merge assigner.
- **Slug as primary key**: object-key the manifest by slug so different slugs never conflict.
  Simplest merge story; loses the numeric handle and chronological listing.

### 5. Object-keyed (or generated) manifests merge cleanly with the default driver

An array + counter is the worst shape for merging. Object-keyed-by-id entries mean two branches
adding different entries are different keys and auto-merge with the default driver (no custom
driver needed). Alternative (npm-merge-driver philosophy): do not commit the manifest at all,
generate it from per-file frontmatter, and regenerate instead of merging.

### 6. Existing JSON merge drivers (if we ever want a local belt-and-suspenders)

- `mergiraf` (Rust, tree-sitter, actively maintained): syntax-aware, supports JSON; clean on
  independent key additions. Best-maintained general option.
- `jsonmerge` (Python, avian2): configurable strategies incl. `arrayMergeById`.
- `npm-merge-driver` (archived): regenerate-lockfile pattern; the right model for generated files.
- `git-json-merge`: unmaintained (2023).
- `sf-git-merge-driver` (Salesforce XML): good reference for the "install subcommand writes both
  `.git/config` and gitattributes" UX and a real test suite.

### 7. Testing pattern: ephemeral repos, never the real repo

Consensus: a test that per-case does `mkdtemp` -> `git init` -> write base -> two divergent
branches -> merge -> assert (valid JSON, both entries present, no duplicates, no conflict
markers, recomputed derived fields). Hermetic, fast, parallelizable. A persistent dedicated
test repo leaks state; testing in the real repo pollutes history and risks real conflicts.
Git's own suite uses ephemeral scratch repos (Sharness). Drive it from Vitest via
`child_process` for a permanent regression guard.

## DorkOS-specific analysis (flow plugin vs host split)

`/flow`'s canonical source is now the marketplace plugin
(`dork-labs/marketplace/plugins/flow/`, mid-extraction under spec #266 / DOR-133); dorkos is a
consumer. The conflict-relevant pieces split:

- **Plugin-side (marketplace, harness-neutral):** `skills/specifying-work/SKILL.md` steps 7-8
  describe allocating the next ADR/spec number from `manifest.json` `nextNumber`. This wording
  changes to the new ID scheme.
- **Host-side (dorkos):** `.claude/scripts/spec-manifest-ops.ts` (the actual allocator, keyed on
  `nextNumber`), `adr-drift-check.mjs` (keep as backstop), the ADR templates + `/adr:create` +
  `/adr:from-spec`, `writing-adrs` / `managing-specs`, the changelog sentinel, and any
  `.gitattributes`. The manifests themselves (`decisions/manifest.json`, `specs/manifest.json`)
  restructure from array+counter to id-keyed.

The changelog is written by `.claude/git-hooks/changelog-populator.py` (post-commit), not by
flow skills; the sentinel change is host-side.

## Decided direction (2026-07-03)

1. **Timestamp IDs going forward** (`YYMMDD-HHMMSS`), existing numbered artifacts frozen.
2. **Manifests id-keyed, no `nextNumber` counter** (merge clean with the default driver).
3. ~~**CHANGELOG sentinel-anchor per section**~~ — **superseded 2026-07-07 by ADR `260707-231641` (changelog fragments):** the sentinel does not prevent same-section concurrent-insert conflicts (this file's own harness disproves it), so we eliminate the shared `[Unreleased]` block entirely in favor of one fragment file per change under `changelog/unreleased/`.
4. **Prevention over merge drivers** (a custom JSON driver is at most an optional local extra).
5. **Validate with an ephemeral-repo Vitest harness** before rollout.
6. Formalize via `/flow:ideate`; plugin-side changes coordinate with DOR-133.

## Open questions for the spec

- Timestamp granularity: seconds (recommended, collision-proof) vs minutes (shorter, tiny burst
  risk caught by drift-check). Add a random/counter disambiguator, or rely on drift-check?
- Keep the committed manifest (id-keyed) or drop it and generate from frontmatter?
- Exact changelog sentinel format for a 3-section `[Unreleased]` block; update the populator hook.
- Do we still register a local JSON merge driver as belt-and-suspenders for local merges/rebases,
  or rely purely on prevention?
- `pnpm-lock.yaml`: keep the documented `pnpm install` + `--frozen-lockfile` recipe, or adopt a
  regenerate-on-merge driver locally?
- Migration/coexistence UX: how `/adr:list`, drift-check, and cross-references present a mixed
  numeric + timestamp ID space.

## Sources

Git docs: gitattributes, git-merge-file. Practitioner writeups: Greg Micek, Julian Burr,
Monzool, Graphite, Nicolas Charpentier (charpeni/merge-drivers-cli), Brandon Pugh
(`include.path`). Union evidence: RuboCop PR #3594, scikit-learn #21516, keep-a-changelog #56,
GitLab changelog-placeholders blog, Sophia Willows (JSON sentinel). Server-side-merge
limitation: isaacs/github #560, community discussion #9288, GitLab #17325. JSON/lockfile
drivers: git-json-merge, npm-merge-driver, jsonmerge (avian2), rmedaer/git-merge-drivers,
mergiraf, weave, sf-git-merge-driver. ID anti-pattern: TypeDoc #2188. Testing: Sharness.
