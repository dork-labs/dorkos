---
number: 312
title: Timestamp identifiers for new ADRs and specs (freeze legacy numbers)
status: draft
created: 2026-07-03
spec: merge-conflict-prevention
superseded-by: null
---

# 312. Timestamp identifiers for new ADRs and specs (freeze legacy numbers)

## Status

Draft (auto-extracted from spec: merge-conflict-prevention)

## Context

The collision root cause is a single shared mutable `nextNumber` counter in the manifests,
allocated at author-time on divergent branches: two branches read the same value and both
allocate it, producing an add/add file collision (`0294-<slug>.md` on both sides) and a
manifest conflict on merge. This is branch-level, not a runtime race, so locking cannot fix it.
The `merge-behavior.test.ts` harness confirmed both failure modes, and confirmed that distinct
timestamp-id filenames never collide.

The same harness refuted a stronger claim from the original draft: reshaping the manifest to an
object keyed by id does NOT guarantee clean merges — two entries added in the same key region
still conflict. Object-keying is a large breaking change to `spec-manifest-ops.ts` and a hard
cutover for concurrent agents, for only a marginal frequency win.

## Decision

New ADRs and specs get a UTC `YYMMDD-HHMMSS` id stamped from the creating process's own clock
(`.claude/scripts/id.ts`), read from no shared state, so allocation can never collide. Filenames
become `<id>-<slug>.md`. The `nextNumber` counter is removed from both manifests. The manifest
KEEPS its array shape; new entries carry a timestamp `id` (no `number`), and the ~260 existing
numbered entries are frozen and keep their `number`. Because legacy ids start with `0` and
timestamp ids with `2`, a plain string sort lists legacy first, then timestamp, preserving
chronological order in mixed listings. Generating the manifest from per-file frontmatter (to
remove the last shared-file merge surface entirely) is the deferred hard follow-up.

## Consequences

### Positive

- Identifier allocation is coordination-free: number/counter collisions and add/add file
  collisions are eliminated (both proven in the harness).
- Minimal blast radius: the manifest array shape and `spec-manifest-ops` command surface are
  preserved; only counter logic is removed and id allocation added.
- Chronological sort is preserved with no renumbering churn and no broken cross-references.

### Negative

- Two id formats coexist (legacy numeric + timestamp); the new handle is longer.
- The manifest array still content-conflicts when two branches add entries at the same position
  (a trivial keep-both, no data loss); the hard fix (frontmatter-generated manifest) is deferred.
