---
number: 292
title: Canvas Edit-Protection and Cross-Session Safety
status: accepted
created: 2026-06-25
spec: canvas-markdown-editing
superseded-by: null
---

# 292. Canvas Edit-Protection and Cross-Session Safety

## Status

Accepted (extracted from spec: canvas-markdown-editing)

## Context

Once the canvas is editable, the same per-session canvas content has two writers: the
agent (which pushes content through the UI-action dispatcher) and the editor (which
autosaves on change). An agent push landing mid-edit could clobber the user's work.
Separately, autosave plus flush-on-unmount can race a session switch: the unmount flush
fires after `loadCanvasForSession` has already swapped `canvasSessionId`, which would land
the old draft in the new session's canvas.

## Decision

Adopt two guards. (1) **Protect the edit:** a transient `canvasEditing` store flag gates
the agent write path only: the dispatcher skips applying markdown `content` from
`open_canvas` / `update_canvas` while editing, so the editor is the sole writer of that
canvas entry. The editor autosave calls `setCanvasContent` directly and is unaffected.
(2) **Session-ownership guard:** capture the owning `canvasSessionId` when edit mode
begins and skip any persist, including the unmount flush, when the store's current session
no longer matches; exit edit mode on a session change so the editor remounts fresh.

## Consequences

### Positive

- User edits are never silently clobbered by an agent push (last-write-wins-user).
- A draft can never leak into a different session's canvas.
- Clean writer separation: while editing, only the editor writes the canvas content.

### Negative

- Adds transient editing state to the canvas store and a guard branch in the dispatcher.
- "Protect the edit" silently withholds agent updates during an edit; surfacing that
  (a notify-and-reconcile banner) is deferred to a fast-follow.
