---
slug: canvas-markdown-editing
number: 263
created: 2026-06-25
status: ideation
---

# Editable Canvas Markdown via Blintz

**Slug:** canvas-markdown-editing
**Author:** Dorian Collier
**Date:** 2026-06-25

---

## 1) Intent & Assumptions

- **Task brief:** Make the DorkOS Canvas markdown surface user-editable. Today the
  canvas (`apps/client/src/layers/features/canvas/`) is agent-driven and read-only:
  markdown is pushed by the agent into a per-session store and rendered with
  `streamdown`. We want the user to be able to edit those markdown documents in
  place, using **Blintz** (our in-house React port of Milkdown's Crepe WYSIWYG
  editor, published to npm as `blintz`) as the editing surface. `streamdown` stays
  as the read/streaming renderer; Blintz mounts only when the user enters an
  explicit edit mode; edits autosave back through the existing per-session
  persistence.

- **Assumptions:**
  - Blintz is consumed from **npm** (`^0.1.0`); the client's React 19 satisfies
    Blintz's `>=18` peer. `yalc` is used only as a gitignored local co-dev overlay
    (copy-mode, which avoids the dual-React peer hazard that a `pnpm link` symlink
    would create).
  - The canvas content model is unchanged: the existing `UiCanvasContent`
    discriminated union, markdown variant `{ type: 'markdown', content: string, title? }`.
    An edit mutates `content` in place; no schema change.
  - v1 persistence stays **client-local**: the existing per-session
    Zustand + localStorage path (`setCanvasContent` -> `writeCanvasSession`).
    Edits do not flow to a file on disk or back to the agent in v1.
  - One user edits a given canvas at a time (no real-time collaboration).
  - Blintz dark mode follows the app theme automatically (its CSS keys off
    `:where(.dark, [data-theme="dark"])`, which DorkOS already toggles on
    `document.documentElement`), so theme wiring is near-zero.

- **Out of scope:**
  - The destination of edits beyond client-local (write-to-file or
    feed-back-to-agent). This is a deliberate, separate product fork, deferred.
  - Editing the non-markdown canvas variants (`url`, `json`).
  - Real-time collaborative editing / CRDT / multi-writer merge.
  - The "agent updated this document" notify-and-reconcile banner (a fast-follow
    on top of the v1 "protect the edit" behavior, not v1 itself).
  - Blintz plugin extensions (e.g. the `@blintz/comments` plugin seam).

## 2) Pre-reading Log

- `apps/client/src/layers/features/canvas/ui/CanvasMarkdownContent.tsx`: today a thin
  `<Streamdown shikiTheme={['github-light','github-dark']}>` wrapper inside
  `prose prose-sm dark:prose-invert ... p-6`. Pure display, no `onChange`.
- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx`: `CanvasBody` dispatches
  on `canvasContent.type` (`url` / `markdown` / `json`) and already threads an
  `onSetContent` (= `setCanvasContent`) callback down. `CanvasContent` is the
  right-panel contribution; `AgentCanvas` is the resizable pane / mobile Sheet.
- `apps/client/src/layers/features/canvas/ui/CanvasHeader.tsx`: title + content-type
  indicator row; rendered by `CanvasBody`, separate from the content component.
- `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts`: `setCanvasContent`
  writes Zustand state **and** persists per session via `writeCanvasSession(sessionId, ...)`.
  `loadCanvasForSession` rehydrates on session switch; `canvasSessionId` tracks the
  owning session.
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`: the agent's push path
  -> `store.setCanvasContent(command.content)`. This is the producer that can race a
  live editor.
- `apps/client/src/layers/shared/model/use-debounced-input.ts`: existing
  debounce-with-flush pattern to mirror for autosave.
- `packages/shared/src/schemas.ts` (`UiCanvasContentSchema`): the discriminated union;
  markdown payload key is `content`.
- Blintz (`/Users/doriancollier/Keep/144/blintz`, `packages/blintz`): public API is
  only `<MarkdownEditor value onChange placeholder className plugins>` (no read-only
  prop). `value` seeds on mount and **resets when it diverges from the last value the
  editor emitted**. Heavy dep tree (Milkdown/ProseMirror + CodeMirror + KaTeX). Theme
  keys off `.dark` / `[data-theme="dark"]`.
- Finsta (`/Users/doriancollier/Keep/144/finsta/finsta-code`): the reference consumer.
  `apps/web` depends on `blintz` **from npm** (`"blintz": "^0.1.0"`, real integrity in
  the lockfile); `yalc` is documented as a local co-dev overlay only, `.yalc/`
  gitignored. This corrects the original framing: Finsta does not depend via yalc.

## 3) Codebase Map

- **Primary components/modules:**
  - `features/canvas/ui/CanvasMarkdownContent.tsx` - gains a view/edit toggle; renders
    `streamdown` in view mode, lazy-loads the Blintz editor in edit mode.
  - `features/canvas/ui/CanvasMarkdownEditor.tsx` (new) - the Blintz wrapper: seeds a
    local draft once, autosaves via debounce, flushes on unmount.
  - `features/canvas/ui/AgentCanvas.tsx` (`CanvasBody`) - threads an `onContentChange`
    (persist) callback into the markdown branch.
- **Shared dependencies:** `useAppStore` canvas slice (`setCanvasContent`,
  `canvasSessionId`, `writeCanvasSession`); `Button` from `shared/ui`; `lucide-react`
  icons; the `.dark` theme class on `document.documentElement`; `streamdown` (kept).
- **Data flow:** agent UI command -> `ui-action-dispatcher` -> `setCanvasContent` ->
  Zustand + per-session localStorage -> `CanvasBody` -> `CanvasMarkdownContent`. New
  reverse path: Blintz `onChange` -> debounced, session-guarded persist ->
  `onContentChange({ ...content, content: markdown })` -> same `setCanvasContent`.
- **Feature flags/config:** none. New dependency `blintz` added to `apps/client`.
- **Potential blast radius:**
  - `apps/client` bundle (mitigated: Blintz lazy-loads only on entering edit mode).
  - The other client surfaces that render this component (Electron desktop, Obsidian
    plugin via `DirectTransport`) - needs a smoke check, especially Obsidian which has
    its own CodeMirror/ProseMirror in the host (low risk: this is the DorkOS client
    bundle, not Obsidian's editor).
  - Pre-existing soft peer warning: Blintz's CodeMirror 6.x is newer than the
    `obsidian` package's pinned peer range. Warning only, compatible within 6.x.

## 5) Research

- **Potential solutions:**
  1. **Replace streamdown with Blintz outright.** Cons: Blintz has no read-only mode,
     so static/agent content would render in an editable surface; heavy bundle always
     loaded; a live agent push fights the editor. Rejected.
  2. **streamdown for view + Blintz behind an explicit edit toggle (chosen).** Pros:
     keeps the fast streaming renderer as default; Blintz weight deferred via lazy
     import; clean separation between agent-owned (view) and user-owned (edit) states.
     Cons: two render paths to keep visually coherent; an edit affordance to design.
  3. **Build a lighter bespoke editor.** Rejected: Blintz is ours, purpose-built for
     exactly this, and round-trips clean markdown. Reinventing it is waste.
- **Save model:** autosave on change (debounced, ~400-500ms) with flush-on-unmount,
  mirroring `use-debounced-input`. Matches the "onChange wired to persistence" intent
  and Notion-style expectations Blintz sets.
- **Agent-vs-edit race:** while editing, the editor seeds its draft once and ignores
  store updates to `content`; agent pushes to the same canvas are not reflected into
  the open editor, and the user's save wins (last-write-wins-user). A **session
  ownership guard** is required: capture the owning `canvasSessionId` when edit mode
  begins, and on any persist (including the unmount flush) skip the write if the
  store's current session no longer matches - otherwise a session switch can leak a
  draft into a different session's canvas. On session change, exit edit mode so the
  editor remounts fresh for the new session.
- **Dependency mechanics:** depend on `blintz` from npm; reserve `yalc` for local
  co-dev (`yalc link blintz` from a built local checkout, `.yalc/` + `yalc.lock`
  gitignored, `pnpm install` after, mindful that Turbo's cache can mask live edits).
- **Recommendation:** Solution 2 with autosave, the session ownership guard, lazy
  Blintz, and `streamdown` retained. Ship "protect the edit" for the agent race; defer
  the notify-and-reconcile banner.

## 6) Decisions

| #   | Decision                           | Choice                                                                                                                                               | Rationale                                                                                                                                                                            |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Canvas markdown role               | Editable surface (Blintz), `streamdown` retained for view/streaming                                                                                  | User wants in-canvas editing; `streamdown` is the better streaming/read renderer and is already shared with chat.                                                                    |
| 2   | View vs edit                       | Explicit edit toggle; `streamdown` is the default view                                                                                               | Blintz has no read-only mode and reseeds on value divergence, so it cannot safely be the always-on renderer for agent-pushed content.                                                |
| 3   | Save model                         | Autosave on change (debounced) + flush on unmount                                                                                                    | Matches "onChange wired to persistence" and Notion-style expectations; reuses the `use-debounced-input` pattern.                                                                     |
| 4   | Agent push while user is editing   | Protect the edit (agent push ignored while editing; user save wins)                                                                                  | Never drop user keystrokes; simplest correct v1. Notify-and-reconcile banner is a deferred fast-follow.                                                                              |
| 5   | Cross-session safety               | Session ownership guard on every persist; exit edit mode on session change                                                                           | Prevents the unmount-flush from leaking a draft into a different session's canvas during a session switch.                                                                           |
| 6   | Bundle strategy                    | Lazy-load the Blintz editor only on entering edit mode                                                                                               | Blintz is heavy (Milkdown + ProseMirror + CodeMirror + KaTeX); keep it out of the view path and main bundle.                                                                         |
| 7   | Dependency source                  | `blintz` from npm (`^0.1.0`); `yalc` for local co-dev only                                                                                           | Reproducible/CI-safe like Finsta; React 19 satisfies the `>=18` peer; yalc copy-mode avoids dual-React.                                                                              |
| 8   | Persistence destination (v1)       | Client-local only (existing per-session Zustand + localStorage)                                                                                      | Smallest honest v1; where edits ultimately go (file / agent) is a separate, deferred product fork.                                                                                   |
| 9   | Tracker                            | Keep untracked for now                                                                                                                               | User opted to defer Linear issue creation; IDEATE skips tracker projection silently.                                                                                                 |
| 10  | App vs. library seam               | Standing test: a capability any Blintz consumer would want goes in Blintz; anything specific to DorkOS's agent/canvas/session model stays in DorkOS. | Keeps Blintz a clean general-purpose library and the DorkOS glue thin; we own Blintz and intend to strengthen it.                                                                    |
| 11  | Blintz read-only / `editable` mode | Recommended library addition (confirm in SPECIFY); not required by v1.                                                                               | The clearest library gap this project surfaced (it is why Blintz cannot serve the view path today); unlocks unifying view+edit on Blintz and benefits other consumers (e.g. Finsta). |

---

## 7) App vs. library boundary (DorkOS vs. Blintz)

**Seam test:** would another Blintz consumer (Finsta, or any app) want this
capability? If yes, it belongs in **Blintz** and the library gets stronger for
everyone. If it only makes sense given DorkOS's agent-driven, per-session canvas,
it stays in **DorkOS**. Blintz is ours, so a gap our use reveals is an invitation
to improve the library, not only to work around it in the app.

**Push down into Blintz (general editor capabilities):**

- **Read-only / `editable` prop** (prime candidate). Blintz exposes only
  `value`/`onChange` today; Milkdown supports non-editable via
  `editorViewOptionsCtx`. A `readOnly`/`editable` prop is a general feature and the
  single reason Blintz cannot currently serve the canvas view path. Not required by
  v1, but it unlocks unifying view+edit on one engine and benefits any consumer
  (e.g. Finsta displaying an experiment `body`).
- **Autofocus / imperative ready hook.** Focusing the editor when edit mode opens
  is a generic editor nicety; expose `autofocus` or `onReady(ctx)` rather than the
  app reaching into the DOM.
- **`onBlur` event.** Enables flush-on-blur cleanly (the `use-debounced-input`
  pattern wants it) without the app wiring DOM listeners around Blintz.
- **Markdown round-trip fidelity.** Any input that does not round-trip cleanly is a
  Blintz bug to fix at the library, where every consumer benefits, not to patch in
  the canvas.

**Keep in DorkOS (canvas/agent/session-specific glue):**

- The view/edit toggle chrome, its placement, and a11y.
- Autosave debounce + flush-on-unmount orchestration (consumes Blintz
  `onChange`/`onBlur`).
- The session-ownership guard and cross-session correctness (DorkOS's per-session
  canvas persistence model).
- The "protect the edit" agent-vs-edit policy (DorkOS's agent-push model).
- `UiCanvasContent` / `setCanvasContent` / localStorage wiring, and the
  streamdown-vs-Blintz routing.

**Cross-repo workflow implication.** Blintz-side work lives in a separate repo
(`dork-labs/blintz`) with its own build/publish. Co-evolution flow: prototype the
Blintz change, validate it against DorkOS via a `yalc` overlay (unpublished), then
publish a new Blintz version and bump the DorkOS dep. This is the concrete reason
decision #7 keeps `yalc` in the toolkit. SPECIFY/DECOMPOSE should split any
Blintz-side tasks (separate PRs, separate repo) from the DorkOS canvas tasks.

**Open fork for SPECIFY:** keep `streamdown` for the view path (v1 default:
streaming-friendly, shared with chat, Blintz stays lazy), or invest in Blintz
read-only and unify view+edit on Blintz (pixel-identical view and edit, at the cost
of bundle weight and streaming ergonomics). Recommendation: v1 keeps `streamdown`
for view and we add `editable` to Blintz in parallel as a library improvement,
preserving the option to unify later without betting v1 on it.

---

**Recommended next step:** Move to **SPECIFY** (`/flow:specify`). The direction, scope,
and the hard correctness constraints (session ownership guard, protect-the-edit,
seed-once) are settled. The specification should pin the component contracts
(`CanvasMarkdownEditor` props, the toggle's placement and a11y, debounce timing,
the exact guard logic), resolve the §7 open fork (streamdown-for-view vs.
Blintz-for-both), scope any Blintz-side library tasks separately from the DorkOS
canvas tasks, and define the test matrix and the npm-vs-yalc dev-workflow note.
