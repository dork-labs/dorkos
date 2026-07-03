---
slug: merge-conflict-prevention
id: 260703-193514
created: 2026-07-03
status: specified
linearIssue: DOR-184
---

# Prevent Multi-Agent Merge Conflicts in Shared Registries and Identifiers

**Status:** Draft
**Author:** Dorian
**Date:** 2026-07-03

## Overview

Eliminate the recurring merge-conflict class that multi-agent concurrency creates in DorkOS.
The conflicts cluster entirely in a small set of shared registry / generated files and in
counter-allocated identifiers. The fix is to **prevent** those conflicts structurally (so two
branches producing unrelated artifacts auto-merge with git's default driver) rather than to
**resolve** them at merge time with a custom driver, because merge drivers and `merge=union` do
not run on GitHub's server-side merge and require a per-clone bootstrap that fails silently.

## Background / Problem Statement

Three incident logs (`.temp/conflict-incidents/`, 2026-06-27/28) show the pattern. Every conflict
is a shared registry / generated file or a doc both sides added independently; there are
near-zero application-source conflicts:

- `decisions/manifest.json` and `specs/manifest.json`: two branches each read their own
  `nextNumber`, both allocate the same value, both write `+1`. On merge this yields a content
  conflict on `nextNumber` **and** an add/add collision on the numbered markdown (documented:
  two different `0294-*.md`).
- `CHANGELOG.md` `[Unreleased]`: multi-section (`### Added / ### Changed / ### Removed`); every
  branch appends via the post-commit populator, so concurrent appends conflict.
- `pnpm-lock.yaml`: touched by every dependency change; even git's auto-merge is untrustworthy.

Root cause (from ideation RCA): a single **shared mutable `nextNumber` counter allocated at
author-time on divergent branches**. This is branch-level, not a runtime race, so advisory
locking cannot fix it. The dense-sequential property is the only thing that forces the counter;
the numeric handle itself is fine.

## Goals

- New ADRs/specs never collide on identifier allocation, regardless of branch or timing.
- `decisions/manifest.json` and `specs/manifest.json` auto-merge with git's DEFAULT driver when
  two branches add different entries.
- `CHANGELOG.md` `[Unreleased]` auto-merges on GitHub for concurrent appends.
- No renumbering of the ~260 existing numbered artifacts; no per-clone git bootstrap required for
  the primary fix.
- `/flow`'s daily use never breaks during migration.
- A permanent ephemeral-repo test harness proves the new scheme merges clean where the old one
  conflicts (a negative control).

## Non-Goals

- Application-source merge-conflict handling (not the problem).
- Renumbering or migrating the existing ~260 ADRs/specs (frozen permanently).
- A mandatory custom merge driver or a server-side merge service.
- Changing EXECUTE-stage worktree policy (`executing-specs` Phase 0 is unchanged).
- Deep `pnpm-lock.yaml` redesign.

## Technical Dependencies

- **git** built-in behavior only: committed `.gitattributes`, default text driver, optional
  `union` carve-outs. No new runtime dependency for the primary fix.
- **Node** `--experimental-strip-types` (existing precedent: `.claude/scripts/spec-manifest-ops.ts`).
- **Vitest** + `node:child_process` + `node:fs` `mkdtemp` for the ephemeral-repo harness.
- **Python 3** (existing `.claude/git-hooks/changelog-populator.py`).
- **Optional, not required:** `mergiraf` (tree-sitter JSON merge driver) as a documented local dev nicety.

## Detailed Design

### 1. Identifier scheme (timestamp ids)

- New ADRs and specs receive an id of the form `YYMMDD-HHMMSS` (UTC), second precision (e.g.
  `260703-081234`). The creating process stamps its own current time, so no shared state is read
  or written and two branches can never allocate the same id.
- Filenames: ADRs become `decisions/<id>-<slug>.md` (was `NNNN-<slug>.md`); specs already live in
  `specs/<slug>/` directories, so only the manifest/frontmatter id changes.
- The ~260 existing 4-digit numbered artifacts are **frozen** and keep their numbers. Because
  legacy ids start with `0` and timestamp ids start with `2` (year 26+), a lexicographic sort
  lists all legacy artifacts first (in order) then all new ones (in order).
- Backstop: `adr-drift-check` gains awareness of both id formats and flags any duplicate id (the
  near-impossible same-second case, or a hand-authored clash).

### 2. Manifest structure (id-keyed, no counter)

`decisions/manifest.json` and `specs/manifest.json` change from `{ nextNumber, [array] }` to an
**object keyed by id**, dropping `nextNumber` entirely:

```jsonc
// before
{ "version": 1, "nextNumber": 311, "decisions": [ { "number": 310, "slug": "…", … } ] }
// after
{ "version": 2, "decisions": { "260703-081234": { "id": "260703-081234", "slug": "…", … } } }
```

Two branches adding different keys are non-overlapping object members and auto-merge with the
default driver. Legacy numeric ids are carried as string keys (`"0310"`) so nothing is lost.
**Considered but deferred:** generating the manifest from per-file frontmatter (regenerate,
never merge). Rejected for v1 because it ripples to every manifest consumer; recorded as a future
simplification (see ADR).

### 3. Allocation ownership (host-side)

`.claude/scripts/spec-manifest-ops.ts` becomes the single host-side allocator: it stamps the
timestamp id and writes the id-keyed entry (the `add` command stops reading/incrementing
`nextNumber`). ADR creation (`/adr:create`, `/adr:from-spec`) uses the same id helper. A small
shared `id.ts` produces and validates ids and injects a clock for deterministic unit tests.

### 4. CHANGELOG per-section sentinel anchors

Each `[Unreleased]` subsection ends with a fixed anchor comment:

```markdown
## [Unreleased]

### Added

- …existing entries…
<!-- FLOW:ADD-ABOVE Added -->

### Changed

- …
<!-- FLOW:ADD-ABOVE Changed -->

### Removed

- …
<!-- FLOW:ADD-ABOVE Removed -->
```

`changelog-populator.py` inserts each new bullet immediately ABOVE the matching section's anchor.
Because every branch inserts at the same stable anchor as a pure insertion, the default driver
merges concurrent appends without conflict and it works on GitHub's server-side merge. A dedup
pass removes exact-duplicate bullets (the populator's known cherry-pick/rebase duplication). NOT
`union` (unsafe for this multi-section block; scikit-learn #21516).

### 5. Plugin delegation (marketplace, via PR)

The `/flow` plugin must stay harness-neutral (other installers may keep sequential numbers), so
the plugin stops describing the counter mechanic and delegates to host tooling, mirroring the
pattern `executing-specs` already uses for status updates:

- `plugins/flow/skills/specifying-work/SKILL.md` steps 7-8: replace "numbered from
  `decisions/manifest.json` `nextNumber`, increment it" with "allocate an id via the host's
  manifest-maintenance command/script; otherwise fall back to editing the entry directly."
- `plugins/flow/templates/docs/adr.md`: `number: NNNN` -> `id:`; drop the increment comment;
  filename pattern `<id>-<slug>.md`.

These land as a PR in `dork-labs/marketplace`, coordinated with the in-flight extraction
(spec #266 / DOR-133), and dogfooded by dorkos via `--plugin-dir`.

### 6. Optional local driver + lockfile

- `mergiraf` documented as an OPTIONAL local nicety (a `setup-git` script + `.gitattributes`
  entries) that additionally auto-resolves local `git merge`/`rebase` on the manifests. Not
  required; prevention is sufficient.
- `pnpm-lock.yaml`: keep the proven recipe (`pnpm install` then `pnpm install --frozen-lockfile`;
  never commit a blind auto-merge). Documented, no driver.

### Code structure & file organization

- **Host (dorkos):** `.claude/scripts/spec-manifest-ops.ts`, new `.claude/scripts/id.ts`,
  `.claude/scripts/adr-drift-check.mjs`, `decisions/manifest.json` + `specs/manifest.json`
  (reshape), `decisions/*` new-file naming, `.claude/commands/adr/{create,from-spec}.md`,
  `.claude/skills/writing-adrs` + `managing-specs`, `.claude/git-hooks/changelog-populator.py`,
  `CHANGELOG.md` (anchors), `.gitattributes` (new), and the Vitest harness under
  `.claude/scripts/__tests__/` (or an appropriate test location).
- **Plugin (marketplace):** `plugins/flow/skills/specifying-work/SKILL.md`,
  `plugins/flow/templates/docs/adr.md`.

## User Experience

Agents and developers create ADRs/specs via `/adr:create`, `/adr:from-spec`, and the `/flow`
SPECIFY stage; the changelog is written by the post-commit hook. After this change: creating an
artifact stamps a timestamp id with no shared read, so two concurrent branches merge cleanly with
no manual resolution. The only visible difference is the id format (`260703-081234` rather than
`0300`) in filenames, frontmatter, and cross-references. On the near-impossible same-second
collision, `adr-drift-check` surfaces it on SessionStart rather than letting it merge silently.

## Testing Strategy

- **Unit:** `id.ts` (format, validity, uniqueness with an injected clock); id-keyed manifest
  read/write; changelog anchor insertion (correct section, above anchor); dedup pass.
- **Integration (the harness):** a Vitest suite that per case does `mkdtemp` -> `git init` ->
  base commit -> two divergent branches each adding a different ADR/spec/changelog entry ->
  `git merge` with the default driver -> assert valid JSON, both entries present, no duplicates,
  zero conflict markers. Include a **negative control**: the same scenario under the OLD
  `nextNumber`/array scheme DOES conflict, proving the fix is causal.
- **E2E:** `/adr:create` on two branches, merge, assert clean.
- **Mocking:** none for git (real ephemeral repos); the clock is injected for deterministic ids.
  Each test carries a purpose comment; the negative control guarantees the suite can fail.

## Performance Considerations

Negligible. Object-keyed lookups are O(1) vs array scans. The harness is git-op heavy, so keep it
a focused suite (a handful of cases), not a broad matrix.

## Security Considerations

None material. No new external calls or secrets. `.gitattributes` is committed; the optional
driver is opt-in and local.

## Documentation

- New `contributing/` guide: the timestamp-id convention, the changelog sentinel, and the
  optional `mergiraf` setup.
- `AGENTS.md` Artifacts section: state the id convention for new ADRs/specs.
- `writing-adrs` and `managing-specs`: reflect id allocation + id-keyed manifest.
- Plugin README / skill note: the harness-neutral delegation.

## Implementation Phases

- **Phase 1 — host core, behind the harness:** `id.ts` + id-keyed manifest read/write in
  `spec-manifest-ops.ts` + ADR path; the ephemeral-repo harness incl. the negative control.
- **Phase 2 — host surfaces:** reshape both manifests to id-keyed (additive; legacy frozen);
  ADR/spec templates + `/adr:create` + `/adr:from-spec` + `writing-adrs` + `managing-specs`;
  `.gitattributes`.
- **Phase 3 — changelog:** per-section sentinels + `changelog-populator.py` insert-above-anchor +
  dedup pass.
- **Phase 4 — plugin (PR to marketplace):** `specifying-work` steps 7-8 + `adr.md` delegate to
  host tooling; coordinate with DOR-133; dogfood via `--plugin-dir`.
- **Phase 5 — docs + optional driver:** the guide, `AGENTS.md`, and the optional `mergiraf` doc.

## Open Questions

All resolved during IDEATE/SPECIFY (recorded for audit):

- ~~Timestamp granularity?~~ **(RESOLVED)** Seconds, `YYMMDD-HHMMSS`. **Rationale:** collision-proof
  in practice, still human-readable; drift-check backstops the same-second edge.
- ~~Committed id-keyed manifest vs generate-from-frontmatter?~~ **(RESOLVED)** Keep a committed
  id-keyed manifest for v1. **Rationale:** less refactoring, existing tooling reads it, and it
  auto-merges with the default driver; generation recorded as a deferred simplification.
- ~~Exact changelog sentinel format?~~ **(RESOLVED)** One `<!-- FLOW:ADD-ABOVE <Section> -->`
  anchor at the bottom of each `[Unreleased]` subsection; populator inserts above it.
- ~~Optional local JSON merge driver?~~ **(RESOLVED)** Document `mergiraf` as optional/local only;
  not required. **Rationale:** prevention is the sufficient primary fix; a driver never runs on
  GitHub merges.
- ~~`pnpm-lock.yaml`?~~ **(RESOLVED)** Keep the `pnpm install` + `--frozen-lockfile` recipe.
- ~~Mixed-id-space UX?~~ **(RESOLVED)** `/adr:list` + drift-check handle both formats; legacy sorts
  before timestamp ids; prose cross-references stay valid because legacy ids are frozen.
- ~~Migration sequencing?~~ **(RESOLVED)** The 5 phases above; additive with legacy frozen, so
  `/flow`'s daily use never breaks; plugin change coordinated with DOR-133.

## Related ADRs

Seeded by this spec (draft): `0311` (prevent structurally, not merge drivers), `0312` (timestamp
ids + id-keyed manifests, freeze legacy), `0313` (per-section changelog sentinels), `0314` (flow
plugin delegates id allocation to host). This spec establishes the go-forward ADR/spec id
convention; existing ADRs are unaffected.

## References

- Linear: DOR-184. Spec: merge-conflict-prevention.
- `research/20260703_multi_agent_merge_conflict_prevention.md` (~30 citations).
- `.temp/conflict-incidents/` (3 incident logs).
- Key external: gitattributes docs (union pitfalls), scikit-learn #21516, GitLab changelog
  placeholders, Sophia Willows JSON sentinel, TypeDoc #2188, mergiraf, npm-merge-driver.
- Coordination: spec #266 / DOR-133 (flow-plugin-extraction).
