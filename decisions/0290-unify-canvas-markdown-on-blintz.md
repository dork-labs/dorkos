---
number: 290
title: Unify the Canvas Markdown Surface on Blintz
status: accepted
created: 2026-06-25
spec: canvas-markdown-editing
superseded-by: null
---

# 290. Unify the Canvas Markdown Surface on Blintz

## Status

Accepted (extracted from spec: canvas-markdown-editing)

## Context

The DorkOS canvas markdown variant was rendered read-only by `streamdown`, and users
could not edit a document the agent produced. Canvas content arrives as discrete whole
documents via `open_canvas` / `update_canvas` UI commands, never as a token stream, so
`streamdown`'s incremental-rendering advantage is not exercised on the canvas. We want
in-canvas editing with clean markdown round-tripping, which Blintz (our React port of
Milkdown's Crepe) provides.

## Decision

Render the canvas markdown variant with a single Blintz instance in two modes:
read-only in view and editable in edit, toggled by an explicit control. Remove
`streamdown` from the canvas markdown path (it remains the renderer for chat messages).
View and edit become the same engine, so they are pixel-identical.

## Consequences

### Positive

- View and edit render identically (no renderer mismatch); one engine to reason about.
- Clean markdown round-tripping on save; leans into Blintz as an owned, first-party library.
- Edits persist back to the source file, so the agent and the user share one source of
  truth (the original silent split-brain is gone). The persistence design (file ownership,
  optimistic concurrency, frontmatter handling) is its own decision: see ADR-0293.

### Negative

- Blintz is heavy (Milkdown + ProseMirror + CodeMirror + KaTeX); it loads when a markdown
  canvas appears (mitigated by lazy-loading the Blintz wrapper, never on `url`/`json`).
- Requires a first-class read-only mode in Blintz (see ADR-0291) as a prerequisite.
- A brief document re-parse occurs on the occasional whole-document swap and on the
  view<->edit remount; negligible for these infrequent, user- or command-driven events.
