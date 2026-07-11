---
slug: diff-viewer
id: 260711-142048
created: 2026-07-11
status: specified
linearIssue: DOR-212
parent: right-panel-workbench
---

# Diff Viewer — Ideation (anchor)

**This feature was ideated inside the Right-Panel Workbench, not here.** DOR-212
was carved out during workbench ideation as a deliberate fast-follow, sequenced
after the workbench v1 shipped and verified. This file is a pointer, not a
re-ideation — the design context already exists upstream.

## Where it came from

- **Parent ideation:** [`specs/right-panel-workbench/01-ideation.md`](../right-panel-workbench/01-ideation.md)
  - §4 Research → "Not-thinking-of opportunities": _"first-class diff viewer"_ and
    _"'agent touched this' provenance badges in the explorer"_.
  - §4 Research → "Emerging agent-cockpit patterns": _"diff-centric review with
    per-hunk accept as table stakes"_ (the pattern now standard in Claude Code's
    VS Code extension, Cursor, and Copilot Edits).
  - **Decision round 2, item 1:** _"Diff viewer → fast-follow, confirmed. Tracked
    as DOR-212 in the Right-Panel Workbench project (Backlog); sequenced after
    workbench v1 ships and is verified working."_
- **Parent spec Non-Goals** ([`02-specification.md`](../right-panel-workbench/02-specification.md)):
  _"Diff viewer with per-hunk accept — fast-follow DOR-212, after v1 ships and verifies."_
- **v1 shipped and verified** ([`04-implementation.md`](../right-panel-workbench/04-implementation.md)):
  all six workbench chunks merged (#137–#145). The platform this builds on —
  multi-document canvas store, viewer registry, `GET /api/files/*` endpoints,
  CodeMirror 6 file viewer, `control_ui` 3-place recipe — is live on `main`.

## What DOR-212 adds

A first-class **diff review surface**: when the agent edits a file, a diff
document auto-opens in the canvas showing what changed, with **per-hunk
accept / reject**. Reject reverts a hunk back to disk through the existing
boundary-safe write path; accept dismisses it from review. Includes **image
diff modes** (2-up / swipe / onion-skin, GitHub-style) for changed images.

The open decisions this feature must resolve (diff base, accept/reject
semantics, auto-open coalescing, rendering choice, transport parity) are **not**
punted to a clarification round — they are resolved directly in
[`02-specification.md`](./02-specification.md) with the reasoning and the
assumption trail. Proceed straight to SPECIFY → DECOMPOSE.

**Next step:** the specification is already written — see
[`02-specification.md`](./02-specification.md).
