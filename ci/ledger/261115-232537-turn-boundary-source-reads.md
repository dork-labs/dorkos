---
id: 261115-232537
title: Bound the turn-boundary source scan reads
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.test]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4493 keeps the turn-boundary import invariant inside its existing test and
reads its production sources in batches of at most 64. The recursive enumerator,
exclusions, >700 floor, required paths, exact allowed importers, both guarded
specifiers and type-only import treatment are unchanged. The original already
read each eligible file once; this change does not remove reads.

The completed full verification at 31293137 reported this test at 5004 ms against
the unchanged 5000 ms default. The unchanged test passes in isolation here
(844 ms after building missing dependencies); this is not a deterministic
isolated failure or an aggregate CI performance claim. The real tree contains
2818 production TypeScript files, with the same two chain modules exempted from
reading. Both before and after therefore read 2816 files.

The changed test passes on that tree. Separate exclusive temporary production
modules importing the resolver and its wrapper each make the actual guard fail
and name the extra importer (2819 enumerated sources each). Removing each module
restores the original tree and a passing test. No setup hoisting, skipped case,
quarantine, timeout, retry, shard, worker cap, required check or quality floor
changes. The existing single test retains its default budget.

This is test I/O hygiene. Revert or revise if bounded reads miss an importer,
change type-only semantics, stop failing on either real production mutation, or
create a reproducible resource problem. Keep the full-tree guard and its budget
when investigating any further load-sensitive failure.
