---
id: 260708-185518
title: Multi-document canvas model — openDocuments[] + activeDocumentId replaces the single content slot
status: draft
created: 2026-07-08
spec: right-panel-workbench
superseded-by: null
---

# 260708-185518. Multi-document canvas model — openDocuments[] + activeDocumentId replaces the single content slot

## Status

Draft (auto-extracted from spec: right-panel-workbench)

## Context

The canvas today holds a single content slot. The workbench spec adds a tabbed multi-document experience — file viewers, browser tabs, and agent-opened documents living side by side — on top of the shipped 7-variant canvas content union. Retrofitting single→multi later would touch every viewer, `use-canvas-persistence.ts`, and every `control_ui` command that opens or updates canvas content, so the multi-doc shape is decided up front, before any workbench viewer chunk ships against the single-slot model (spec D11).

## Decision

Replace the single-slot canvas store with `openDocuments: CanvasDocument[]` + `activeDocumentId`, where `CanvasDocument = { id, content: UiCanvasContent, openedAt, sourceLabel }`. Agent commands (`open_canvas`, `open_file`, `browser_navigate`) append-and-activate — deduping by `sourcePath`/URL to re-activate an already-open document rather than opening a duplicate — while `update_canvas` mutates the active document. The store evicts LRU-style at a cap (starting at 12 open documents). Edit-protection (`canvasEditing`) becomes per-document instead of a single global flag. `CanvasHeader` renders a tab strip with close buttons, and `use-canvas-persistence.ts` serializes the full document array per session.

## Consequences

### Positive

- Every viewer chunk (files, images, 3D, CSV, browser, markdown) is built against the final multi-doc shape from day one, avoiding a later migration that would touch every existing consumer plus persistence and `control_ui`.
- Per-document edit-protection lets one document be safely edited while others stay agent-writable, instead of a single global lock blocking the entire panel.

### Negative

- More state to reason about than a single slot — dedup-by-source, LRU eviction, and per-document edit-protection all need dedicated test coverage before any viewer chunk ships.
- The tab strip adds a new interaction surface (close, multi-doc navigation) to the right panel that a single-slot canvas never needed.
