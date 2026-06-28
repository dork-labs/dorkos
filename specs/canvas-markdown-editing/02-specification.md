---
slug: canvas-markdown-editing
number: 263
created: 2026-06-25
status: specified
---

# Editable Canvas Markdown via Blintz

**Status:** Draft <!-- Draft | Under Review | Approved | Implemented -->
**Author:** Dorian Collier
**Date:** 2026-06-25

## Overview

Make the DorkOS Canvas markdown surface user-editable by **unifying both view and
edit on Blintz** (our React port of Milkdown's Crepe WYSIWYG editor, published to
npm as `blintz`). Today the canvas markdown variant is rendered read-only by
`streamdown`; this work replaces that single renderer with one Blintz instance that
is read-only in view mode and editable in edit mode, toggled by an explicit control.
Edits autosave back through the existing per-session canvas persistence. View and
edit become pixel-identical because they are the same engine.

This requires a first-class **read-only / `editable` mode in Blintz** (a library
change in the separate `dork-labs/blintz` repo) as a hard prerequisite, since Blintz
exposes no read-only mode today. Per the §7 app-vs-library boundary in the ideation,
editor capabilities belong in Blintz where every consumer benefits; canvas/agent/
session glue stays in DorkOS.

## Background / Problem Statement

The canvas (`apps/client/src/layers/features/canvas/`) is an agent-driven right-panel
on `/session`. Agents push content via discrete UI commands (`open_canvas` /
`update_canvas`, emitted by the MCP UI tools and dispatched client-side through
`executeUiCommand` -> `setCanvasContent`). Content is a `UiCanvasContent` discriminated
union; the markdown variant is `{ type: 'markdown', content: string, title? }`,
persisted per-session in Zustand + localStorage (`writeCanvasSession`).

The markdown surface is display-only: `CanvasMarkdownContent` renders
`<Streamdown>{content.content}</Streamdown>`. Users cannot edit a document the agent
produced. We want in-canvas editing with clean markdown round-tripping, which is
exactly what Blintz provides.

Canvas content arrives as **discrete whole documents**, never token-streamed
(verified: `update_canvas` "replaces the current canvas content"; there is no
incremental/delta canvas path). So `streamdown`'s incremental-render advantage is not
exercised on the canvas, and replacing it with a Blintz instance that re-seeds on the
occasional whole-document swap is acceptable.

## Goals

- A user can edit a markdown document shown in the canvas, with Blintz's full WYSIWYG
  UX (slash menu, block handle, selection toolbar, tables, code, math).
- View and edit render through the **same** Blintz engine (consistent typography and
  layout; no renderer mismatch).
- Edits **autosave** (debounced) back through the existing per-session persistence;
  no new persistence layer in v1.
- Editing is **protected**: while the user edits, agent pushes to that canvas are
  ignored (the user's save wins), and a draft can never leak into another session.
- Blintz gains a **proper, reusable read-only mode** that any consumer can use.
- Blintz is consumed from **npm**; `yalc` is the local co-dev overlay for the
  in-flight Blintz change.

## Non-Goals

- Editing the non-markdown canvas variants (`url`, `json`).
- Persisting edits anywhere beyond the existing client-local per-session store
  (write-to-file or feed-back-to-agent is a deliberately deferred product fork).
- Real-time collaborative editing / CRDT / multi-writer merge.
- The "agent updated this document" notify-and-reconcile banner (a fast-follow on top
  of "protect the edit").
- Token-level streaming of canvas content (it does not exist and is not added).
- Removing `streamdown` from the chat message path (out of scope; `streamdown` stays
  a dependency, only the canvas markdown path stops using it).

## Technical Dependencies

- **`blintz`** (npm), the version that first ships the `editable` prop (target
  `^0.2.0`; coordinate the exact version at publish). React 19 satisfies its `>=18`
  peer. Public API used: `<MarkdownEditor value editable onChange className />`,
  `import 'blintz/styles.css'`.
- **`yalc`** for local co-dev only: `yalc link blintz` from a built local checkout
  overlays the npm copy while the `editable` change is unpublished; `.yalc/` and
  `yalc.lock` gitignored; `pnpm install` after linking; Turbo cache can mask live
  edits (force a rebuild). `package.json` stays on the npm version. yalc's copy-mode
  (not a `pnpm link` symlink) avoids resolving two copies of React against Blintz's
  peer dep.
- **Blintz internals touched (separate repo):** `@milkdown/kit/core`
  `editorViewOptionsCtx` (set `editable`) in `useBlintzEditor.ts`; the feature views
  (toolbar, block-edit, link-tooltip, etc.) must consult editable state to suppress
  editing chrome.
- Existing DorkOS deps only otherwise: Zustand store, `lucide-react`, `shared/ui`
  `Button`, the `.dark` theme class (Blintz dark mode auto-follows it).

## Detailed Design

### Architecture changes

- The canvas markdown variant is rendered by **one Blintz instance** in two modes:
  - **View (default):** `editable={false}`, `value` tracks the live store content so
    agent `update_canvas` pushes refresh the view.
  - **Edit:** `editable={true}`, `value` is a local **draft seeded once** on entering
    edit; `onChange` autosaves. Agent pushes do not reach the editor.
- `streamdown` is removed from `CanvasMarkdownContent`. The dependency remains for
  chat.

### Blintz library change (prerequisite work stream — `dork-labs/blintz`)

Add a first-class **read-only mode**. This is more than `contentEditable=false`; a
good read-only mode must also suppress the editing chrome.

- **Prop:** add `editable?: boolean` to `MarkdownEditorProps` (default `true`, so
  existing consumers are unaffected). Thread through `MarkdownEditor` ->
  `useBlintzEditor`.
- **Engine:** in the `Editor.make().config(...)` block, set
  `ctx.set(editorViewOptionsCtx, { editable: () => editable })` so ProseMirror
  disables direct editing when `false`.
- **Chrome gating (the substantive part):** when not editable, the interactive
  feature views must not appear or act — the slash `/` command menu and the `+`/`::`
  block handle (block-edit), the selection toolbar, drag-to-reorder handles (list,
  table), and the link-tooltip's edit affordances. Each feature reads the editor's
  editable state and no-ops its view/plugin when read-only. (Placeholder text is also
  suppressed in read-only.)
- **Toggle model for v1:** the prop is read at editor construction. DorkOS remounts
  the Blintz instance on a view<->edit toggle (see below), so a **reactive** editable
  refresh (toggling without remount) is **not required for v1**; it is recorded as an
  optional Blintz polish item. `autofocus` and `onBlur` are likewise optional
  follow-ups, not blockers.
- **Tests (Blintz repo):** read-only renders the document, emits no `onChange`,
  rejects keyboard input, and shows none of the editing chrome; `editable` default
  stays `true` (regression guard for existing consumers like Finsta).
- **Release:** publish a new minor; bump the DorkOS dep from the published version.
  During development, validate via `yalc` before publish.

### DorkOS canvas changes

**Code structure & file organization:**

- `apps/client/src/layers/features/canvas/ui/BlintzCanvas.tsx` (new) — a thin,
  **lazy-loaded** controlled wrapper that owns the `blintz` import and
  `import 'blintz/styles.css'`. Props: `{ value: string; editable: boolean;
onChange?: (markdown: string) => void; className?: string }`. Renders
  `<MarkdownEditor value editable onChange className />` and nothing else. Isolating
  the heavy import here keeps `blintz` out of the main bundle and out of the `url`/
  `json` canvas paths, and gives tests a single module to mock.
- `apps/client/src/layers/features/canvas/ui/CanvasMarkdownContent.tsx` (reworked) —
  owns mode, the toggle, value routing, autosave, and the guards. Renders
  `BlintzCanvas` via `React.lazy` + `Suspense` (lightweight fallback while the Blintz
  chunk loads on first markdown render). Removes the `streamdown` import.
- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx` (`CanvasBody`) — pass an
  `onContentChange` (persist) callback into the markdown branch (thread the existing
  `onSetContent`).
- `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts` — add transient
  editing state: `canvasEditing: boolean` + `setCanvasEditing(editing: boolean)`. Not
  persisted (it is live UI state for the active canvas only).
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` — the "protect the edit"
  guard (below). Extend `DispatcherStore` with `canvasEditing` + `setCanvasEditing`.

**Component contract — `CanvasMarkdownContent`:**

```
interface CanvasMarkdownContentProps {
  content: Extract<UiCanvasContent, { type: 'markdown' }>;
  /** Persist an edited markdown document back to canvas state. */
  onContentChange: (content: UiCanvasContent) => void;
}
```

Behavior:

- Local state: `isEditing: boolean`, `draft: string`.
- `canvasSessionId` read from the store (selector); `owningSessionRef` captured at the
  moment edit mode is entered.
- **Enter edit:** `owningSessionRef.current = store.getState().canvasSessionId`;
  `setDraft(content.content)`; `setIsEditing(true)`; `store.setCanvasEditing(true)`.
- **Exit edit (toggle off, or unmount):** flush any pending debounced save (guarded),
  `setIsEditing(false)`, `store.setCanvasEditing(false)`.
- **Value routing into `BlintzCanvas`:**
  - view: `editable={false}`, `value={content.content}` (live).
  - edit: `editable={true}`, `value={draft}`, `onChange={handleChange}`.
- **Remount on mode change:** key the lazy `BlintzCanvas` by mode
  (`key={isEditing ? 'edit' : 'view'}`) so editable is fixed at construction (matches
  the v1 Blintz toggle model). Re-seeding is a no-op visually because the value is
  equal across the switch (saved draft == store content).

**Autosave (debounced) + flush:**

- `handleChange(markdown)`: `setDraft(markdown)`; schedule a debounced persist
  (`~500ms`, matching `use-debounced-input`'s default). Clear the timer null after it
  fires so the unmount flush does not double-write.
- **Flush on exit/unmount:** if a debounced write is pending, persist immediately.
- **Persist is session-guarded** (see below).

**Session-ownership guard (cross-session safety):**

- `handlePersist(markdown)`: if `store.getState().canvasSessionId !==
owningSessionRef.current`, **skip** the write. This covers the debounced timer and
  the unmount flush. Without it, a session switch mid-edit could land the old draft in
  the new session's canvas (the unmount flush fires after `loadCanvasForSession` has
  already swapped `canvasSessionId`).
- Otherwise: `onContentChange({ ...content, content: markdown })` ->
  `setCanvasContent` (which persists per session).
- **Exit edit on session change:** an effect watching `canvasSessionId` exits edit
  mode when it differs from `owningSessionRef.current`, so the editor remounts fresh
  for the new session rather than showing a stale draft.

**"Protect the edit" (agent-vs-edit) — store + dispatcher:**

- The agent write path and the editor autosave are different writers. To guarantee the
  user's edit wins, the **dispatcher** (agent path only) consults `canvasEditing`:
  in `open_canvas` and `update_canvas`, if `store.canvasEditing` is `true`, **skip
  applying the markdown `content`** (the agent push is ignored while editing). The
  editor autosave calls `setCanvasContent` directly (not via the dispatcher), so it is
  unaffected. For `open_canvas`, the panel-reveal side effects still run; only the
  content replacement is skipped.
- This is a clean separation: while editing, the editor is the sole writer of that
  canvas entry's content.

**Edit toggle UX (placement + a11y):**

- A single ghost icon `Button` from `shared/ui`, placed top-right of the markdown
  pane (a `sticky` control inside `CanvasMarkdownContent`, not the shared
  `CanvasHeader`, keeping edit state local to the markdown component).
- View: a `Pencil` (lucide) labeled `aria-label="Edit document"`. Edit: a `Check`
  labeled `aria-label="Finish editing"`. `focus-visible` ring per the components rule.

### Data model changes

- No change to `UiCanvasContentSchema` (markdown variant unchanged). Editing mutates
  `content` in place.
- Store gains transient `canvasEditing` (not persisted; absent from
  `writeCanvasSession`).

### API changes

- None server-side. The MCP UI tools and `UiCommand` schema are unchanged.

## User Experience

- An agent shows a markdown document in the canvas (as today). It renders through
  Blintz in **read-only** mode: identical look to the eventual edit view, no editing
  chrome.
- The user clicks the **Edit** (pencil) control. The pane becomes editable in place;
  the user gets the full Blintz writing UX. Changes **autosave** continuously; there
  is no explicit Save button.
- The user clicks **Done** (check) to return to read-only. Their edits are already
  persisted (and flushed on exit).
- **Error / exit paths:**
  - If the agent pushes new canvas content while editing, the edit is **protected**:
    the push is ignored and the user keeps editing. (A future banner may surface that
    an update was withheld.)
  - If the user switches sessions while editing, edit mode exits, nothing leaks into
    the new session, and the new session's canvas loads normally.
  - While the Blintz chunk loads on first markdown render, a lightweight loading
    placeholder shows.

## Testing Strategy

Vitest + React Testing Library + jsdom, co-located in `canvas/__tests__/`. Mock the
`BlintzCanvas` module (and/or `blintz`) the same way existing canvas tests mock
`streamdown` and `streamdown/styles.css`, so jsdom never loads the real editor.

- **Unit / component (`CanvasMarkdownContent`):**
  - Renders read-only by default; the mocked editor receives `editable={false}` and
    the live `content.content`.
  - Clicking Edit sets `editable={true}`, seeds the draft from current content, and
    sets `canvasEditing` true in the store.
  - `onChange` from the mocked editor triggers a debounced persist that calls
    `onContentChange` with `{ ...content, content: <new> }` (use fake timers; assert
    one write after the delay, not per keystroke).
  - Flush-on-exit persists the latest draft when leaving edit mode.
  - **Session guard:** when `canvasSessionId` changes to a different value than the
    one captured at edit-start, a pending persist is skipped (no write to the new
    session) and edit mode exits.
  - Toggling Done returns to read-only.
- **Dispatcher (`ui-action-dispatcher`):** with `canvasEditing === true`,
  `update_canvas` and `open_canvas` do **not** call `setCanvasContent` with markdown;
  with `canvasEditing === false`, they do (extend the existing dispatcher tests).
- **Store (`app-store-canvas`):** `setCanvasEditing` flips the flag and it is not
  written to `writeCanvasSession`.
- **Blintz repo (separate):** read-only renders content, emits no `onChange`, blocks
  input, hides all editing chrome; `editable` defaults to `true`.
- **Mocking strategy:** `vi.mock('./BlintzCanvas', ...)` returning a stub that renders
  `value` and exposes a button to fire `onChange`, mirroring the existing
  `vi.mock('streamdown', ...)` pattern. Fake timers for debounce.

Each test carries a purpose comment; cover the failure-revealing edges (the session
guard, the debounce coalescing, the protect-the-edit dispatcher skip).

## Performance Considerations

- Blintz is heavy (Milkdown + ProseMirror + CodeMirror + KaTeX). `BlintzCanvas` is
  `React.lazy`, so the chunk loads only when a **markdown** canvas first renders, and
  never for `url`/`json` canvases or the main bundle. The canvas feature is already
  route-code-split.
- Re-seeding cost is bounded: canvas content changes only on discrete `update_canvas`
  commands (not per token), and autosave is debounced, so document re-parses are
  infrequent.
- Remount-on-toggle re-parses the doc once per view<->edit switch; negligible for a
  user-initiated mode change.

## Security Considerations

- Blintz sanitizes via `dompurify` internally; rendering agent-provided markdown
  through it is at least as safe as the current `streamdown` path.
- Edits persist only to the same-origin per-session localStorage that already backs
  the canvas; no new sink, no network egress added.

## Documentation

- `contributing/` note (canvas or design-system guide): the canvas markdown surface
  is now Blintz (view + edit), and the `blintz` npm + `yalc` co-dev workflow.
- Update the canvas feature's module TSDoc to describe the view/edit model.
- Blintz repo: document the new `editable` prop in its README.

## Implementation Phases

- **Phase 1 — Blintz read-only mode (prerequisite, `dork-labs/blintz`):** add
  `editable` prop, gate the editing chrome, tests, publish. Validate against DorkOS via
  `yalc`.
- **Phase 2 — DorkOS unified canvas (core):** `BlintzCanvas` lazy wrapper;
  `CanvasMarkdownContent` rework (toggle, draft, autosave, session guard);
  `canvasEditing` store flag; dispatcher protect-the-edit guard; remove `streamdown`
  from the canvas markdown path; tests. Bump `blintz` to the published version.
- **Phase 3 — polish / deferred (optional):** reactive `editable` (toggle without
  remount), `autofocus` on edit, `onBlur` flush, the notify-and-reconcile banner, and
  the persistence-destination fork (file / feed-back-to-agent).

## Open Questions

- ~~**View path: streamdown vs Blintz-for-both?**~~ **(RESOLVED)** — Answer: unify
  view+edit on Blintz. Rationale: pixel-identical view/edit, leans into strengthening
  Blintz, and canvas content is not token-streamed so streamdown's advantage is unused
  here. Makes Blintz `editable` a v1 blocker.
- ~~**Agent push while editing?**~~ **(RESOLVED)** — Answer: protect the edit (agent
  push ignored while editing; user save wins), enforced by the `canvasEditing`
  dispatcher guard. Rationale: never drop user keystrokes; simplest correct v1.
- ~~**Reactive editable vs remount-on-toggle?**~~ **(RESOLVED)** — Answer:
  remount-on-toggle for v1, so the Blintz change need not support reactive editable.
  Rationale: smaller Blintz change; mode switches are deliberate and infrequent.
  Reactive editable is recorded as optional Blintz polish.
- ~~**Debounce interval?**~~ **(RESOLVED)** — Answer: ~500ms, matching
  `use-debounced-input`'s default. Rationale: consistency with the existing pattern.
- **Blintz version coordination** — the exact published `blintz` version that first
  carries `editable` is set at Phase 1 publish; Phase 2 bumps to it. Until then, `yalc`
  overlays the local build.

## Related ADRs

- ADR-0290 — Unify the canvas markdown surface on Blintz (retire `streamdown` from the
  canvas path). _(draft, this spec)_
- ADR-0291 — Editor capabilities live in Blintz: add a first-class read-only
  (`editable`) mode (the DorkOS-vs-Blintz library boundary). _(draft, this spec)_
- ADR-0292 — Canvas edit-protection and cross-session safety (editing flag + dispatcher
  guard + session-ownership persist guard). _(draft, this spec)_

## References

- Ideation: `specs/canvas-markdown-editing/01-ideation.md` (esp. §6 Decisions, §7
  app-vs-library boundary).
- Canvas: `apps/client/src/layers/features/canvas/ui/{CanvasMarkdownContent,AgentCanvas,CanvasHeader}.tsx`,
  `apps/client/src/layers/features/canvas/model/use-canvas-persistence.ts`.
- Store: `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts`,
  `app-store-helpers.ts`.
- Dispatcher: `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`; UI command
  schema `packages/shared/src/schemas.ts` (`UiCanvasContentSchema`, `UiCommand`).
- Blintz: `dork-labs/blintz` (`packages/blintz/src/{MarkdownEditor.tsx,useBlintzEditor.ts}`),
  npm `blintz`. Reference consumer: Finsta `apps/web` (`<MarkdownEditor>`, npm + yalc
  co-dev).
- Prior canvas specs: `canvas-persistence-and-toggle`, `deprecate-session-canvas-slot`,
  `chat-markdown-rendering`.
