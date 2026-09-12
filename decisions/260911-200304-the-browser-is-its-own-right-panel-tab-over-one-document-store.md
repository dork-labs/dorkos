---
id: 260911-200304
title: The Browser is its own right-panel tab — two views over one document store
status: proposed
created: 2026-09-11
spec: room-canvas
superseded-by: null
amends: null
---

# 260911-200304. The Browser is its own right-panel tab — two views over one document store

## Status

Proposed (extracted from spec `room-canvas`).

## Context

The operator's direction was "a Canvas tab and a Browser tab in rooms, the same way we have them in
agent sessions". Sessions have no Browser tab: the browser is a `browser` (or `url`) document inside
the Canvas tab's document strip, dispatched to `CanvasBrowserContent` by `AgentCanvas.tsx:55-63`. So
making the two surfaces the same means adding the tab to **both**, not copying a split that does not
exist.

The right panel's tabs are `RightPanelContribution` registrations (`init-extensions.ts:145-303`) with
a `visibleWhen` predicate and a priority, and ADR `260822-083229` already anticipated room surfaces
arriving this way. The Terminal tab sets the precedent for a tab that hides itself where the host
cannot support it (`transport?.supportsTerminal === true`, `:292-302`), which is the shape the
Obsidian shell needs here: DirectTransport has no serve route and no preview listener.

## Decision

We will register a **Browser** right-panel contribution at priority 22 — between Canvas (20) and
Terminal (25) — visible on `/session` **and** on room routes, and hidden under a transport that
cannot serve or proxy a page.

It is **two views over one document store**, not a second store. The Browser view shows exactly the
documents `CanvasBrowserContent` renders — content type `url` or `browser` — and the Canvas view
shows the other twelve. Each view keeps its own active document id. Dedupe, the LRU, per-tab history
and the DevTools bridge are untouched, and there is no migration and no second persistence path.

Defining the Browser view **by the renderer** rather than by a list is deliberate: it means there is
one definition of "is this a page", so the tab split cannot drift from the viewer dispatch.
`mcp_app` therefore stays in Canvas without being an exception — it has its own viewer and its own
`mcp:<server>:<uri>` identity, and it is an app rather than a page.

Reveal follows what a command produces: `browser_navigate`, an `open_canvas`/`update_canvas` carrying
`url`/`browser` content, and an `open_file` whose resolved viewer is the browser reveal Browser;
everything else reveals Canvas.

## Consequences

### Positive

- "Canvas and Browser, the same way sessions have them" becomes true on both surfaces rather than on
  neither.
- A page and a document no longer compete for one tab strip, which is the complaint that started
  this.
- One store means one dedupe rule, one LRU, one edit-protection rule and one thing to make
  server-owned later.
- The Obsidian shell is honest by construction: the tab is absent rather than present and broken.

### Negative

- Every place that asserts the tab strip has to change, and those assertions are literal strings in
  more than one e2e spec (`responsive/touch-reach.spec.ts` and `workbench/dev-server-preview.spec.ts`
  drive the browser through the Canvas tab). A miss here goes red only in the merge queue.
- `pulse/right-panel-tab-strip.spec.ts` is worse than a count: it is built on a **measured premise**
  in both directions — six tabs do not fit a 45% panel at one window width, and the same split fits
  all six at a wider one. A seventh tab changes the arithmetic under both halves, so that spec's
  premise is re-measured rather than renumbered, or it passes vacuously.
- Seven tabs is a fuller strip on a phone, and the strip already scrolls to keep the selection
  visible — one more tab makes that mechanism load-bearing rather than a nicety.
- Two active-document ids is a small amount of state that did not exist, and the "which view does
  this document belong to" question now has to be answered on every render.
- The published workbench guide is written throughout as though the browser lives inside the canvas,
  so three of its sections change rather than one.

## Alternatives rejected

- **Leave the browser as a document type inside Canvas and register only Canvas on room routes.** It
  satisfies neither half of the direction, and it leaves a page and a diff fighting for one strip.
- **A second document store for browser documents.** It duplicates the dedupe, the LRU and the
  persistence path, and doubles the work of making the canvas server-owned.
- **Define the Browser view by an explicit type list.** A list is a second place to edit when a
  content type is added; the renderer is the definition that already exists.
- **Show the Browser tab under DirectTransport with an explanatory empty state.** A tab that can only
  say "not here" is worse than no tab, and the Terminal already settled the question.
- **Auto-selecting Canvas or Browser on a room route.** The panel picks the first contextual tab by
  priority and Room (8) sorts ahead of both, which is the right answer: a tab that selects itself
  because another member acted is the pixel version of a turn that triggers itself. A document
  arriving while the panel is elsewhere lights an unread dot and moves nothing.
