# Tasks — Editable Canvas Markdown via Blintz

**Spec:** `specs/canvas-markdown-editing/02-specification.md` · **Slug:** `canvas-markdown-editing` · **Mode:** full · **Tracked:** no (Linear projection skipped)

This is a **two-repo** effort with a hard cross-repo dependency:

- **Phase 1 (Blintz library)** lands in `dork-labs/blintz` (local: `/Users/doriancollier/Keep/144/blintz`). It is a **prerequisite** for Phase 2.
- **Phase 2 (DorkOS canvas)** lands in the worktree `~/.dork/workspaces/dorkos/canvas-blintz-editor` (branch `canvas-blintz-editor`).
- The dev bridge between them is **`yalc`** (`npx yalc`), not an npm publish. The npm publish of Blintz is a human-gated release step (left for review).

Key finding that shrank Phase 1: Blintz **already** honors `view.editable` in every feature except **block-edit** (toolbar, placeholder, table, list-item, image-block, code-block, latex all self-gate). So read-only = set the `editorViewOptionsCtx.editable` master switch + gate the one un-guarded feature.

## Phase 1 — Blintz read-only mode (`dork-labs/blintz`)

### Task 1.1: Add `editable` prop + master switch + block-edit gating

Add `editable?: boolean` (default `true`) to `MarkdownEditorProps`, thread through `MarkdownEditor` -> `useBlintzEditor`. Set `ctx.update(editorViewOptionsCtx, ...)` master switch. Register `blockEditFeature` only when editable. Size: medium.

### Task 1.2: Test the read-only logic (node-env)

Infra-appropriate test (Blintz vitest is node-env, no jsdom). Guard the `editable` contract without adding a DOM harness. Deps: 1.1. Size: small.

### Task 1.3: Bump to 0.2.0, document, build + `yalc publish`

Version bump, README `editable` section, `vite build`, `npx yalc publish`. **No `npm publish`.** Deps: 1.1, 1.2. Size: small.

## Phase 2 — DorkOS unified canvas (worktree)

### Task 2.0: yalc-link Blintz 0.2.0 into the worktree

`npx yalc add blintz` + `pnpm install`; verify `editable` in the linked `.d.ts`. Deps: 1.3. Size: small.

### Task 2.1: Create `BlintzCanvas.tsx` lazy controlled wrapper

Owns the `blintz` import + `blintz/styles.css`; props `{ value, editable, onChange?, className? }`. Deps: 2.0. Parallel: 2.2. Size: small.

### Task 2.2: Add `canvasEditing` transient store flag

`canvasEditing` + `setCanvasEditing` on `CanvasSlice` (not persisted; reset on session load) and on the dispatcher's `DispatcherStore`. Parallel: 2.1. Size: small.

### Task 2.3: Dispatcher "protect the edit" guard

`open_canvas`/`update_canvas` skip the content write when `store.canvasEditing` (panel-reveal still runs). Deps: 2.2. Size: small.

### Task 2.4: Rework `CanvasMarkdownContent`

Toggle (Pencil/Check), draft seed-once, debounced (~500ms) autosave + flush-on-exit/unmount, session-ownership guard, exit-edit-on-session-change, remount-on-toggle (`key`), lazy `BlintzCanvas` in `Suspense`. Remove streamdown. Deps: 2.1, 2.2. Size: large.

### Task 2.5: Thread `onContentChange` through `AgentCanvas`

Pass `onSetContent` into the markdown branch as `onContentChange`. Deps: 2.4. Size: small.

### Task 2.6: Tests

New `CanvasMarkdownContent.test.tsx` (mock `BlintzCanvas`, fake timers, session guard, debounce coalescing); extend dispatcher test (protect-the-edit); store-flag test; fix `CanvasContent.test.tsx` + `AgentCanvas.test.tsx` to mock `BlintzCanvas`. Deps: 2.3, 2.4, 2.5. Size: large.

### Task 2.7: Docs

Canvas view/edit model TSDoc + blintz/yalc co-dev note. Deps: 2.4. Size: small.

## Phase 3 — Verify

### Task 3.1: Verify Blintz

`typecheck` + `test` + `build`; confirm `editable` in `dist`. Deps: 1.3. Size: small.

### Task 3.2: Verify DorkOS

`typecheck` + `lint` + `test --run` (canvas + shared/lib) + client `build`. Deps: 2.6, 2.7, 3.1. Size: medium.

### Task 3.3: (Best-effort) browser smoke

Dev server + /session: render read-only, Edit, autosave, Done, protect-the-edit. Manual REVIEW item if automation is too flaky. Deps: 3.2. Size: medium.

## Critical path

`1.1 -> 1.2 -> 1.3 -> 2.0 -> 2.1 -> 2.4 -> 2.5 -> 2.6 -> 3.2`
(2.2 parallels 2.1; 2.3 after 2.2; 2.7 after 2.4; 3.1 after 1.3 and gates 3.2.)

No tasks reach the `xl` sub-issue-promotion threshold; all stay checklist-level. Untracked, so no tracker sub-issues regardless.

## Calibration / assumptions (execution-stage, logged not asked)

- **No `npm publish`, no `git push`, no PR** during autonomous execution: these are outward-facing/irreversible (calibration floor). Blintz reaches DorkOS via `yalc`; work lands as local commits ready for the always-on human REVIEW gate.
- **Blintz tests** stay node-env; a full jsdom render harness is out of scope (logged as follow-up) rather than added under autonomy.
- **Block-edit** is gated by **registration** (construction-time), not a runtime `view.editable` check, because the block handle shows via `BlockProvider`'s own hover listeners; this matches the v1 remount-on-toggle model. Reactive editable is future Blintz polish.
