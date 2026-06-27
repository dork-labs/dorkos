---
number: 291
title: 'Editor Capabilities Live in Blintz: a First-Class Read-Only Mode'
status: accepted
created: 2026-06-25
spec: canvas-markdown-editing
superseded-by: null
---

# 291. Editor Capabilities Live in Blintz: a First-Class Read-Only Mode

## Status

Accepted (extracted from spec: canvas-markdown-editing)

## Context

Blintz exposes only `value` / `onChange` and has no read-only mode. Unifying the canvas
view and edit on a single Blintz instance (ADR-0290) needs read-only. Blintz is our
project, so the seam test applies: a capability any Blintz consumer would want belongs in
Blintz, where every consumer benefits, not worked around in the DorkOS app. A proper
read-only mode is more than `contentEditable=false`: the editing chrome must also be
suppressed.

## Decision

Add a first-class `editable?: boolean` prop to Blintz (default `true`, so existing
consumers are unaffected), wired through `useBlintzEditor` to Milkdown's
`editorViewOptionsCtx`. When not editable, the interactive feature views are
suppressed: the slash `/` menu and the `+`/`::` block handle, the selection toolbar,
drag-to-reorder handles, the link-tooltip edit affordances, and the placeholder.
Consume Blintz from npm; use `yalc` only for local co-dev of the in-flight change.
App-specific glue (the view/edit toggle, autosave, the agent/session guards) stays in
DorkOS. For v1 the prop is read at construction (DorkOS remounts on toggle); a reactive
editable refresh is optional Blintz polish.

## Consequences

### Positive

- Strengthens Blintz for every consumer (e.g. Finsta can render an experiment body read-only).
- Establishes a clean DorkOS-vs-Blintz boundary; the app's glue stays thin.
- A correct read-only mode (chrome gated, not just `contentEditable`) raises the library's quality bar.

### Negative

- Introduces a cross-repo work stream: a separate `dork-labs/blintz` PR, a publish, and a
  DorkOS dependency bump, coordinated via `yalc` until published.
- Gating the chrome touches multiple Blintz feature views, so the change is larger than a
  single ProseMirror option.
