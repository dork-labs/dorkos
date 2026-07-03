---
feature: Prevent multi-agent merge conflicts in shared registries and identifiers
slug: merge-conflict-prevention
spec: 271
linearIssue: DOR-184
status: In Review
lastUpdated: 2026-07-03
---

# Implementation: merge-conflict-prevention (#271, DOR-184)

**Stage:** VERIFY -> parked at the human-review gate (autonomous run; operator away).
**Worktree:** `.claude/worktrees/spec-merge-conflict-prevention` on branch
`worktree-spec-merge-conflict-prevention`, based on `origin/main` (`c0b4a4cf`).
**PRs (both DRAFT, not merged):**

- dorkos: this branch — host-side timestamp ids.
- `dork-labs/marketplace#3` — flow plugin delegates id-allocation (harness-neutral).

## What shipped (host, dorkos)

Timestamp ids (`YYMMDD-HHMMSS`) replace the shared `nextNumber` counter for new ADRs/specs;
the ~260 legacy numbered artifacts are frozen. This removes the severe collisions (counter
conflict + add/add numbered-file collision), both proven in the harness. The manifest keeps its
array shape (drop `nextNumber`); entries carry `id` (new) or `number` (legacy).

- `.claude/scripts/id.ts` — generateId / allocateId / isTimestampId / isLegacyId / parseIdDate + CLI (11 tests)
- `.claude/scripts/__tests__/merge-behavior.test.ts` — ephemeral-repo experiment (9 tests)
- `.claude/scripts/spec-manifest-ops.ts` — id allocation, `entryKey`, no `nextNumber`
- `.claude/scripts/adr-drift-check.mjs` — both id forms + duplicate-id backstop
- `/adr:create`, `/adr:from-spec`, `decisions/TEMPLATE.md`, `writing-adrs`, `managing-specs` -> ids
- fixed stale `nextNumber` refs (`/adr:curate`, `/system:review`, `specs/archive/README.md`)
- `AGENTS.md` Artifacts documents the convention
- both manifests: `nextNumber` removed
- 31 script tests green; `adr-drift-check` clean on the real tree.

## Evidence-driven revisions (assumption trail for the review gate)

1. The CHANGELOG sentinel anchor (original ADR-0313) is DISPROVEN by the harness — both
   branches insert above the same anchor line, so it conflicts exactly like today. Deferred to
   one-file-per-entry; ADR-0313 rewritten.
2. Object-keyed manifest only partially helps (same-region adds still conflict) and the reshape
   is a big breaking change to `spec-manifest-ops.ts` + a hard cutover for concurrent agents.
   Kept the array and dropped `nextNumber`; ADR-0312 updated. Hard fix (generate manifest from
   frontmatter) deferred.
3. No `.gitattributes`: `union` does not run on GitHub server-side merges, and an active
   `mergiraf` line would silently fall back on clones without it. Documented as opt-in instead.

## Deferred follow-ups (to file as tickets)

- Generate the spec/ADR manifests from per-file frontmatter (removes the last shared-file merge
  surface — the residual same-region manifest conflict).
- Changelog one-file-per-entry (`changelog.d/`) + release collation (replaces the disproven
  sentinel; also removes the multi-line paragraph-tangling risk).
- (marketplace) 4 pre-existing red config tests on `main` — PR #2 renamed `config.json` ->
  `config.example.json` without updating `config-schema.test.ts` / `stage-projection.test.ts`.

## Gates

Human-review gate: parked here with two draft PRs. No self-merge. The three assumptions above
are what the reviewer should sanity-check.
