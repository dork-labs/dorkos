---
number: 313
title: Defer the CHANGELOG merge-conflict fix to one-file-per-entry (sentinel rejected)
status: draft
created: 2026-07-03
spec: merge-conflict-prevention
superseded-by: null
---

# 313. Defer the CHANGELOG merge-conflict fix to one-file-per-entry (sentinel rejected)

## Status

Draft (auto-extracted from spec: merge-conflict-prevention)

## Context

`CHANGELOG.md` `[Unreleased]` is appended by nearly every branch via the post-commit populator,
so concurrent appends conflict. The spec originally proposed a per-section sentinel anchor
(insert each entry above a fixed `<!-- FLOW:ADD-ABOVE -->` line). The `merge-behavior.test.ts`
harness DISPROVED it: two branches both insert immediately above the same anchor line, i.e. at
the same position, so the default driver conflicts exactly as it does today. The harness also
confirmed `merge=union` resolves concurrent appends locally but does not run on GitHub's
server-side merge (where DorkOS actually merges), and that only one-file-per-entry
(`changelog.d/`, each entry its own file, collated at release) never conflicts.

## Decision

Do NOT ship the sentinel anchor (it does not work) and do NOT rely on `merge=union` (it does not
run on GitHub). Defer the changelog fix to a properly scoped follow-up that moves to
one-file-per-entry: the populator writes each entry as `changelog.d/<id>.md`, and a release step
collates them into `CHANGELOG.md` and clears the directory. That reworks the populator and the
release flow, which is out of scope for the current autonomous run, so it is tracked separately.
The identifier fix (spec merge-conflict-prevention) ships independently and does not depend on the changelog change.

## Consequences

### Positive

- Honest: we do not ship a fix the evidence shows is ineffective.
- The eventual one-file-per-entry design removes the changelog conflict class entirely and also
  eliminates the multi-line paragraph-tangling risk, with no per-clone config and full GitHub
  compatibility.

### Negative

- The changelog remains a conflict source until the follow-up lands (unchanged from today).
- One-file-per-entry adds a release-time collation step to the changelog workflow.
