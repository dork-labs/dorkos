---
slug: diff-viewer
id: 260711-142048
created: 2026-07-11
status: specified
linearIssue: DOR-212
parent: right-panel-workbench
---

# Diff Viewer — Per-Hunk Review Surface — Specification (v1)

**Status:** Draft
**Author:** Dorian + Claude (spec-diff agent; fast-follow to Right-Panel Workbench)
**Date:** 2026-07-11
**Tracker:** DOR-212 · project "Right-Panel Workbench" · fast-follows the shipped workbench (DOR-211)

## Overview

When an agent edits a file, DorkOS auto-opens a **diff document** in the canvas
that shows exactly what changed and lets the operator **accept or reject each
hunk**. Reject reverts that hunk back to disk through the existing boundary-safe,
optimistic-concurrency write path; accept dismisses it from the review. Changed
images get GitHub-style diff modes (2-up, swipe, onion-skin). This is the review
pattern that is now table stakes in Claude Code's VS Code extension, Cursor, and
Copilot Edits — brought inside the DorkOS cockpit and built on the workbench's
already-shipped multi-document canvas, viewer registry, and file endpoints.

## Background / Problem Statement

DorkOS is mission control for coding agents, and the operator's core job is to
**review agent work before trusting it**. Today the workbench can _view_ a file
(CodeMirror viewer, image viewer) and the operator can read the tool-call cards
in chat, but there is no surface that answers the one question review demands:
_"show me only what the agent changed, and let me approve or undo it change by
change."_ Reading a whole file to find the three lines the agent touched is the
context switch the workbench exists to kill. Kai (10 agents across 5 projects)
needs to skim-and-approve at a glance; Priya reads diffs, not whole files,
before adopting output. Every other serious agent cockpit ships per-hunk review;
its absence is conspicuous. DOR-212 closes that gap.

The workbench v1 shipped and verified (`04-implementation.md`, PRs #137–#145), so
the prerequisite platform is live: the multi-document canvas store
(`openDocuments[] + activeDocumentId`, per-doc edit-protection), the CodeMirror 6
file viewer, the mime→viewer registry, the `GET /api/files/*` endpoints, and the
`control_ui` 3-place recipe. This spec extends them; it invents no new delivery
mechanism.

## Goals

- **Auto-open on edit**: when the attached session's agent edits a file, a diff
  document opens/refreshes in the canvas without stealing the user's tab
  preference and without spawning a tab per edit (coalesce to one diff doc/file).
- **Per-hunk review**: accept or reject each hunk independently, plus accept-all /
  reject-all, with the on-disk file as the authority.
- **Correct diff base**: the diff shows _the agent's changes this session_, not
  a conflation of agent edits with the operator's own pre-existing uncommitted
  work, and it works in non-git working directories.
- **Reject writes safely**: reverting a hunk goes through the existing
  boundary-validated, atomic, optimistic-concurrency write path; a file that
  changed since the diff was computed surfaces a conflict, never a blind clobber.
- **Image diff**: 2-up / swipe / onion-skin modes for changed images.
- **Transport parity**: text diff (view + accept/reject) works under
  DirectTransport (Obsidian); image diff modes are web-only (documented).

## Non-Goals

- **Git SCM UI** (stage/unstage, commit, branch, `git diff` of the whole tree).
  The diff base is the agent's session edits, not the git index (git HEAD is
  offered only as a secondary, user-toggled compare mode — §Detailed Design).
- **Three-way / merge-conflict resolution**, blame, or history navigation.
- **Word-level intra-line diff highlighting** beyond what `@codemirror/merge`
  gives for free — no custom token differ in v1.
- **Diffing binary non-image files** (PDFs, 3D models, archives). Only text and
  images get a diff surface; other changed types keep their plain viewer.
- **Reviewing edits made by a _different_ session** or edits the operator made by
  hand outside the agent. The review surface is scoped to the attached session's
  agent edits.
- **Cross-session or persistent review queues / approvals workflow.** Baselines
  are per-session and in-memory (lost on server restart → graceful fallback).
- Split-pane side-by-side as the _default_ (the panel is narrow; unified is the
  default, side-by-side is an opt-in toggle on wide viewports).

## Technical Dependencies

- **`@codemirror/merge`** (MIT) — CodeMirror 6's official merge/diff addon.
  Provides `unifiedMergeView` (inline, with a per-chunk accept/reject gutter
  built in) and `MergeView` (side-by-side). Reuses the app's existing CodeMirror
  6 stack (`@codemirror/state`/`view`/`language`/`language-data`,
  `@uiw/react-codemirror`) — same theme, same language `Compartment` as the
  shipped `CodeMirrorEditor`. This is the decisive reason to use it over any
  standalone differ: zero new editor runtime, one visual language.
- Already shipped and reused: the multi-document canvas store
  (`app-store-canvas.ts`), `PUT /api/files/content` (optimistic-concurrency,
  atomic, boundary-confined), `GET /api/files/raw` (media bytes), `GET
/api/files/content` (text + SHA-256), `boundary.ts`, the `control_ui` +
  `subscribeSessionEvent` client stream taps, the viewer registry.
- **No new heavy client dep for image diff**: swipe/onion-skin/2-up are plain
  CSS/`motion` over two `<img>` layers.

## Detailed Design

### The three questions this feature turns on

#### 1. What is the diff base?

Agent edits land **directly on disk** — by the time DorkOS observes an edit
(over the session SSE `tool_call` stream, which carries `toolName` and the tool
`input`), the bytes are already written. Three candidate bases were considered:

| Base                                                                                  | Verdict                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **git working tree vs HEAD**                                                          | ❌ as the primary base. Conflates the agent's edits with the operator's own pre-existing uncommitted changes (the operator would be asked to "reject" their own work), and dies entirely in a non-git cwd. Right for a _secondary_ "compare against last commit" mode, wrong as the default. |
| **Reconstruct pre-edit content from the tool stream**                                 | ❌ as the primary. `Edit`/`MultiEdit` inputs carry `old_string`/`new_string` (reversible), but `Write` carries only the _new_ full content — a Write-first file has no recoverable pre-image from the stream. Also brittle across interleaved user edits. Kept only as a fallback (below).   |
| **Server-captured pre-edit snapshot, keyed `(sessionId, absPath)`, first-touch-wins** | ✅ **primary.** Precise (isolates _this session's agent edits_), git-independent (works in non-git cwds), and stable across multiple sequential edits.                                                                                                                                       |

**Decision — the diff base is a per-session pre-edit snapshot, captured
server-side at the runtime's pre-tool boundary.** The moment an edit-family tool
(`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) is _about to run_ against a path
that has no snapshot yet in this session, the server reads the current on-disk
bytes and stores them as that file's **baseline**. Every later edit to the same
file keeps the same baseline. The diff is then **`baseline` → `current disk`**.

- **Capture point (primary):** the claude-code adapter's PreToolUse hook /
  `canUseTool` gate — it fires _before_ the SDK applies the edit and can read the
  file synchronously. (See `services/runtimes/claude-code/` hook wiring;
  HookStartedEvent etc. already flow.) This is the correct, precise capture.
- **Fallback A (runtime without a synchronous pre-tool hook, or a snapshot
  missed because the server restarted mid-session):** reconstruct the baseline
  from the tool input when the first observed edit is an `Edit`/`MultiEdit`
  (reverse-apply `new_string`→`old_string` against current disk). A `Write`-first
  file with no snapshot falls through to Fallback B.
- **Fallback B:** if the file is git-tracked, use `git show HEAD:<path>` as the
  baseline; otherwise the baseline is empty (the whole file reads as added).
- **Secondary user mode (not the default):** a "Compare against: **Session start**
  (default) | **Last commit (HEAD)**" toggle in the diff header lets the operator
  deliberately diff against git HEAD. This is the _only_ place git enters, and it
  is explicit.

Snapshots are **binary-safe from day one** (stored as `Buffer`, not just UTF-8
text) so the image-diff chunk needs no capture changes — only a byte-serving
endpoint and a renderer.

Baselines live in an in-memory, per-session map (a new `services/diff/` domain
service). They are **not persisted** across server restart (a restarted session
falls back to Fallback B / empty, which is honest and safe). Baselines for a
session are dropped when the session's stream closes / is evicted.

#### 2. What does accept / reject a hunk DO?

The edits are already on disk, so the semantics are inverted from a staging model:

- **Reject a hunk** = **revert it on disk.** Produce the full-file content with
  that hunk's "after" lines replaced by its "before" (baseline) lines, and write
  it through **`PUT /api/files/content`** with `expectedHash` = the hash of the
  disk content the diff was computed against. On **200**, the reverted region now
  matches baseline and the hunk disappears from the recomputed diff (baseline is
  unchanged). On **409** (file changed on disk since the diff was computed — a new
  agent edit, or a hand edit), surface a non-destructive "This file changed —
  refresh the diff" banner and recompute against the new disk state; **never**
  blind-write. `@codemirror/merge`'s per-chunk `rejectChunk` is intercepted to
  drive this write rather than mutating an editor doc in place.
- **Accept a hunk** = **dismiss it from review** (no disk write — the agent's
  change stays). Accepted hunks are marked resolved in client-side review state
  and visually settle.
- **Accept all** = mark every hunk resolved. **Reject all** = write the full
  `baseline` back to disk (one optimistic-concurrency write), reverting every
  agent change to the file.
- **Finish review / baseline advance:** when the operator dismisses the diff or
  hits "Mark reviewed" (also implied by accept-all), the server **advances the
  baseline to current disk** (`POST /api/diff/baseline/advance`) so subsequent
  agent edits diff from the reviewed state, and the pending-review flag clears.

**Composition with the editor's edit-protection.** The diff document is a
distinct canvas variant (`diff`), _not_ an editable `file` document, so it holds
no per-doc `editing` flag of its own and never fights the file editor's
protection. If the same path is _also_ open in a `file` editor and being edited,
both write through `PUT /content` with optimistic concurrency — a concurrent
editor save simply yields the diff's 409-refresh path (and vice-versa). Disk
stays authoritative; no new locking is introduced.

#### 3. Auto-open behavior

The client already fans out gated session events via
`streamManager.subscribeSessionEvent` (the same seam that powers `ui_command`
dispatch and the extension event bridge). A new **`useAutoOpenDiff`** subscriber
(in the diff feature) watches for completed `tool_call` events whose `toolName`
is an edit-family tool **on the attached session** (`streamManager` already
carries `attachedSessionId` — gate exactly as `ui_command` does so a background
agent can't pop a diff over the foreground session), parses `file_path` from the
tool `input`, and dispatches a local **`open_diff`** for that path.

- **Origin-aware, no focus theft of the tab preference.** The dispatch runs at
  origin `'agent'`, so it reveals the canvas via the **view-only** tab setter
  (`setActiveRightPanelTabView`) — never overwriting the operator's per-agent
  right-panel tab preference (DOR-227), identical to how agent `open_file` and
  `control_ui` already behave.
- **Coalesce to one diff doc per file.** The `diff` variant's dedup key is
  `diff:<sourcePath>` in the canvas store's `sourceKey` — repeated edits to the
  same file **re-activate and refresh** the existing diff document instead of
  spawning tabs (the store's append-and-activate + dedup already does this; we
  add the `diff` case to `sourceKey`/`sourceLabel`). The diff renderer refetches
  `baseline`+`current` on refresh, so the hunks update live as the agent keeps
  editing.
- **Opt-out.** A config flag `workbench.autoOpenDiff` (default `true`) gates the
  subscriber; the agent can still surface a diff deliberately via the `open_diff`
  `control_ui` action regardless.

#### Rendering

- **Text:** `@codemirror/merge` `unifiedMergeView` is the **default** (inline —
  right for the narrow panel and mobile), fed `original = baseline`,
  `doc = current disk`. Its built-in per-chunk accept/reject gutter is the
  interaction surface; the callbacks are intercepted (§Q2) to drive disk writes /
  dismissals rather than in-editor mutation. A **"Side-by-side" toggle**
  (`MergeView`) is offered on wide viewports only. Language highlighting reuses
  the existing `CodeMirrorEditor` language `Compartment` + `@codemirror/language-data`
  detection; theme reuses the app's CodeMirror theme. The whole `@codemirror/merge`
  chunk is `React.lazy`-loaded exactly like `CodeMirrorEditor`/`BlintzCanvas`, so
  the main bundle is unaffected.
- **Image:** a `diff-image` renderer with three modes over two `<img>` layers
  (baseline vs current bytes):
  - **2-up** — side by side (stacks vertically on narrow panels).
  - **Swipe** — a draggable divider clips the top layer (CSS `clip-path`/inset).
  - **Onion-skin** — an opacity slider cross-fades baseline↔current.
    Accept/reject for an image is whole-file (accept = keep new image; reject =
    write baseline bytes back to disk). Baseline bytes come from the snapshot store
    via a new byte endpoint; current bytes come from the shipped `GET /api/files/raw`.

### Architecture changes

**New shared canvas variant `diff`** in `UiCanvasContentSchema`:

```ts
{ type: 'diff', sourcePath: string, mediaKind?: 'text' | 'image', title?: string }
```

`mediaKind` is an optional hint (resolved from the extension via the viewer
registry when absent); the renderer picks the text vs image diff surface. No
bytes travel in the command — the renderer loads baseline + current itself,
mirroring the `file` variant. Add `diff` to the `contentType` enum,
`applyUiCommandToState`, and the store's `sourceKey`/`sourceLabel`
(`diff:<sourcePath>`, label = `baseName(sourcePath)`).

**New `control_ui` action `open_diff`** via the **3-place recipe** (workbench D9
precedent): `UiCommandSchema` (`{ action: 'open_diff', sourcePath: string }`),
`ui-tool-contract.ts` (`CONTROL_UI_DESCRIPTION` + `CONTROL_UI_INPUT` — reuse the
existing `sourcePath` input field), and `applyUiCommandToState`. The dispatcher's
`open_diff` case appends-and-activates a `diff` document (dedup by path) and
reveals the canvas at the given origin. Codex parity is automatic via the shared
contract (no separate Codex schema).

**New server domain `services/diff/`:**

- `edit-baseline.ts` — the per-session baseline store: `capture(sessionId,
absPath)` (first-touch-wins, reads disk bytes as `Buffer`), `get(sessionId,
absPath)`, `advance(sessionId, absPath)` (baseline := current disk),
  `clearSession(sessionId)`. In-memory `Map<sessionId, Map<absPath, Baseline>>`;
  `Baseline = { bytes: Buffer, capturedAt, capturedFrom: 'pre-tool' | 'reconstructed' | 'head' }`.
- Capture wiring: the claude-code runtime adapter calls `capture(...)` from its
  PreToolUse hook for edit-family tools (fallbacks A/B handled inside the store's
  resolve path when no pre-tool snapshot exists).
- `git-baseline.ts` — thin `git show HEAD:<path>` helper (Fallback B + the
  secondary HEAD compare mode), mirroring `services/core/git-status.ts`'s
  `execFile`+timeout idiom and reusing `validateBoundary`.

**New routes (`apps/server/src/routes/diff.ts`), all boundary-validated against
the session cwd exactly like `routes/files.ts`:**

- `GET /api/diff/baseline?cwd=&path=&sessionId=&mode=session|head`
  → `{ baseline: string, baselineHash, current: string, currentHash, capturedFrom }`
  for text (415 for binary — the image path uses the raw endpoints instead).
  Resolves via: session snapshot → reconstruct → HEAD → empty (per §Q1). `mode=head`
  forces the git-HEAD compare.
- `GET /api/diff/baseline/raw?cwd=&path=&sessionId=` → **baseline image bytes**
  from the snapshot (same `MEDIA_CONTENT_TYPES` allowlist, `nosniff`,
  SVG-script-neutering CSP as `GET /api/files/raw`). Current bytes reuse
  `GET /api/files/raw`.
- `POST /api/diff/baseline/advance` → `{ cwd, path, sessionId }` — baseline :=
  current disk (finish-review).
- `GET /api/diff/pending?sessionId=&cwd=` → `{ files: string[] }` — paths with a
  live baseline that differs from disk. Powers explorer "agent touched this"
  badges + a review count. **Nice-to-have within the chunk; cut to a DOR
  follow-up if it risks scope.**

Reverting reuses the **existing** `PUT /api/files/content` (no new write route).

**Transport methods** (both `HttpTransport` and `DirectTransport`):

- `readDiffBaseline(cwd, path, sessionId, mode?)` → the text baseline DTO.
  DirectTransport implements in-process (baseline captured in-process; git via
  child_process) → **text diff works under Obsidian**.
- `diffBaselineMediaUrl(cwd, path, sessionId)` → baseline image URL or `null`
  under DirectTransport (mirrors `mediaUrl`) → **image diff is web-only**.
- `advanceDiffBaseline(cwd, path, sessionId)`.
- Reverting reuses the shipped `writeFile`.

**Config**: new field `workbench.autoOpenDiff: boolean` (default `true`) on
`config-schema.ts`'s `workbench` block, with a semver-keyed migration
(`config-manager.ts`, per the `adding-config-fields` skill) that backfills the
key onto the existing `workbench` object. Update `contributing/configuration.md`.

### Code structure & file organization

- **Server:** `apps/server/src/services/diff/` (`edit-baseline.ts`,
  `git-baseline.ts`, `index.ts`, `__tests__/`); `apps/server/src/routes/diff.ts`;
  a capture call added in `services/runtimes/claude-code/` PreToolUse wiring;
  `clearSession` hooked into the session's stream teardown.
- **Shared:** `packages/shared/src/schemas.ts` (`diff` canvas variant, `open_diff`
  UiCommand action, diff DTOs), `packages/shared/src/transport.ts` (new methods +
  their DTO types).
- **Client (FSD):** new feature `apps/client/src/layers/features/diff-review/`
  (`ui/CanvasDiffContent.tsx` [text, `@codemirror/merge`],
  `ui/CanvasImageDiffContent.tsx` [image modes], `model/use-auto-open-diff.ts`,
  `model/use-diff-review.ts` [load baseline/current, accept/reject/advance
  orchestration], `lib/hunks.ts` [reject → reverted-content builder],
  `index.ts`). The `diff` canvas variants are rendered from
  `layers/features/canvas/ui/` (canvas dispatches to the diff feature's
  components — feature→feature **UI composition is allowed**; the diff feature's
  model must not import canvas internals). `useAutoOpenDiff` is wired once at the
  app shell (`main.tsx`), beside the existing `subscribeUiCommand` wiring.

### API changes

New: `GET /api/diff/baseline`, `GET /api/diff/baseline/raw`,
`POST /api/diff/baseline/advance`, `GET /api/diff/pending`. Reused unchanged:
`PUT /api/files/content` (revert writes), `GET /api/files/raw` (current image
bytes), `GET /api/files/content` (current text). New `control_ui` action
`open_diff`.

### Data model changes

- Canvas store: add the `diff` variant to `sourceKey`/`sourceLabel`/
  `CONTENT_TYPE_FALLBACK_LABELS` and the `contentType` enum. No new store slice —
  diff documents ride the existing `openDocuments[]` model.
- New in-memory server map (`services/diff/edit-baseline.ts`). No DB/schema
  change (baselines are ephemeral; files are on disk).
- New config field `workbench.autoOpenDiff` (+ migration).

## User Experience

- **Auto-open:** the agent edits `src/App.tsx`; the canvas reveals a **diff**
  document titled `App.tsx` showing the changed lines inline, without changing
  which right-panel tab the operator had pinned. The agent edits it again — the
  same diff doc refreshes; no new tab.
- **Per-hunk review:** each changed hunk has an **accept ✓ / reject ✗** control in
  the gutter. Reject undoes that hunk on disk (the lines snap back); accept
  settles it. A header shows "3 changes · 1 reviewed" and offers **Accept all**,
  **Reject all**, and **Mark reviewed**. Toggling **Side-by-side** (wide screens)
  shows before/after columns.
- **Conflict:** if the file changes underneath the diff (another agent edit, a
  hand edit), a calm banner — "This file changed. Refresh to see the latest." —
  replaces silent data loss; refreshing recomputes the hunks.
- **Image diff:** a changed PNG opens with a mode switch — **2-up**, **Swipe**
  (drag the divider), **Onion-skin** (opacity slider). Accept keeps the new
  image; reject restores the previous one on disk.
- **Non-git cwd:** everything above still works — the base is the session
  snapshot, not git. If the operator _wants_ git, the header's "Compare against:
  Session start / Last commit" toggle switches to a HEAD diff.
- **Obsidian:** text diff + accept/reject work in-process; the image-diff modes
  are unavailable (byte serving has no in-process URL), consistent with the
  shipped image viewer.

## Testing Strategy

- **Unit (shared):** Zod round-trips for the `diff` canvas variant, the
  `open_diff` UiCommand action, and every diff DTO; `sourceKey`/`sourceLabel`
  produce `diff:<path>` and coalesce (dedup) a second `diff` open for the same
  path; viewer-registry resolves text vs image `mediaKind`.
- **Unit (server):** `edit-baseline` — first-touch-wins capture, second capture
  is a no-op, `advance` sets baseline=current, `clearSession` drops it;
  `GET /api/diff/baseline` resolution ladder (snapshot → reconstruct[Edit] →
  HEAD → empty) each with a purpose comment; **boundary-escape rejection**
  (`..`, symlinked parent) on every diff route (mandatory — mirror the workbench
  chunk-A tests that caught the symlink hole); `baseline/raw` media allowlist
  (415 for non-media) + token/path confinement; `advance` boundary; binary → 415
  on the text baseline route. Reconstruction reverse-apply for `Edit`/`MultiEdit`;
  `Write`-first with no snapshot falls to HEAD/empty (asserted).
- **Client (RTL + mock Transport):** `useAutoOpenDiff` opens a `diff` doc on a
  completed edit-family `tool_call` for the attached session and **ignores**
  events for other sessions and non-edit tools; a second edit **coalesces** (no
  second tab); reject-hunk calls `writeFile` with the reverted content + expected
  hash and, on a mocked **409**, shows the conflict banner and does **not**
  clobber; accept-hunk writes nothing; accept-all / reject-all; `advance` on
  finish; origin `'agent'` uses the **view-only** tab setter (asserts the user's
  tab preference is untouched). Image modes: 2-up/swipe/onion-skin render both
  layers; image reject writes baseline bytes. Terminal-style transport gating:
  image diff hidden/unavailable under a DirectTransport mock.
- **Integration/E2E (Playwright):** drive a test-mode session that edits a
  fixture file → assert the diff auto-opens → reject a hunk → assert the file on
  disk reverted for that hunk only → accept the rest → mark reviewed. Verify the
  right-panel tab the user pinned is unchanged after the agent-driven open.
- **Mocking:** `FakeAgentRuntime` to emit edit tool-calls; mock Transport for the
  client; fixture files under the e2e temp cwd.

## Performance Considerations

- Baseline capture reads the file once per session per file (first touch);
  bounded by the number of distinct files the agent edits. Store is a plain
  in-memory map, cleared on session teardown — no unbounded growth.
- The `@codemirror/merge` chunk and the image-diff renderer are `React.lazy`
  code-split (matching `CodeMirrorEditor`/`BlintzCanvas`), so the diff surface
  costs the main bundle nothing until first use.
- Text baseline route is size-capped identically to `GET /api/files/content`
  (`FILE_LIMITS.MAX_TEXT_FILE_BYTES` → 413); a huge file degrades to "too large
  to diff here" rather than shipping megabytes.
- Diff recompute on live agent edits is debounced in the renderer (reuse the
  autosave-style debounce constant) so a burst of edits coalesces into one
  refetch.

## Security Considerations

- **Every** new diff route reuses `validateBoundary` (double-validated against
  the session cwd) and the `resolveWithinCwd`/`assertAncestorWithin` guards from
  `routes/files.ts` — no path logic is reinvented; `..`/symlink escape and
  null-byte rejection are **mandatory-tested** (the workbench review caught a real
  symlink-parent hole here — do not regress it).
- `GET /api/diff/baseline/raw` inherits the `GET /api/files/raw` posture exactly:
  the narrow `MEDIA_CONTENT_TYPES` allowlist (415 otherwise, never an
  arbitrary-file reader), `X-Content-Type-Options: nosniff`, `Content-Disposition:
inline`, and the SVG script-neutering CSP sandbox.
- Reject writes go **only** through `PUT /api/files/content` — atomic, existing-
  file-only (never creates), optimistic-concurrency (409 on drift). The diff
  surface never invents a write path.
- Baselines are per-session and never expose another session's captured bytes
  (keyed by `sessionId`; the route requires the session's own cwd + id).
- `git-baseline` runs `git show HEAD:<path>` via `execFile` (no shell) with a
  timeout, cwd-confined — no injection surface, no SSRF.

## Documentation

- User docs (Fumadocs `docs/`): extend "The Workbench" with a "Reviewing changes"
  section — auto-open, accept/reject a hunk, image diff modes; state plainly that
  image diff is web-only (demo-claim gate — never claim Obsidian parity for it).
  Follow `writing-for-humans`.
- `contributing/`: extend the workbench architecture guide with the diff-base
  model (session snapshot vs git HEAD), the accept/reject→disk semantics, and the
  baseline-capture seam. Changelog fragment per chunk.
- ADRs: seed **"Diff base: per-session pre-edit snapshot over git working tree"**
  (the load-bearing decision) — see §Related ADRs.

## Implementation Phases

Two chunks (see `03-tasks.md`). Chunk A is the full text-diff experience,
end-to-end shippable and verifiable on its own; Chunk B adds image diff on top of
A's binary-safe baseline store.

- **Chunk A — Text diff, end-to-end** (server `services/diff/` + capture wiring +
  routes + shared `diff` variant + `open_diff` + transport + `CanvasDiffContent`
  - accept/reject/advance + `useAutoOpenDiff` + config). Ships a working per-hunk
    review surface for text files. Internally sequence server+shared+transport
    first (headless-testable seam), then the client viewer — a reviewer may split
    the PR there if preferred.
- **Chunk B — Image diff modes** (baseline byte endpoint + `diffBaselineMediaUrl`
  transport + `CanvasImageDiffContent` with 2-up/swipe/onion-skin). Depends only
  on A's baseline store (already binary-safe).

## Open Questions

- ~~**Q1 — Diff base.**~~ **RESOLVED** (§Detailed Design Q1): per-session pre-edit
  snapshot captured at the pre-tool boundary; git HEAD is a fallback + a secondary
  user-toggled mode, never the default.
- ~~**Q2 — Accept/reject semantics.**~~ **RESOLVED** (§Q2): reject = revert-on-disk
  via `PUT /content` (optimistic, 409-safe); accept = dismiss; explicit baseline
  advance on finish.
- **Q3 — Does every production runtime expose a synchronous pre-tool hook usable
  for capture?** claude-code (default) does. Codex/opencode are asserted to fall
  back to reconstruction/HEAD. **Default:** ship claude-code capture; other
  runtimes use the fallback ladder. Confirm the codex/opencode pre-tool seam
  during Chunk A; if a runtime can capture cleanly, wire it — non-blocking.
  (OVERRIDABLE — see assumption trail.)

## Assumption trail

Every assumption made while writing this spec, for the orchestrator to
sanity-check. Items marked **OVERRIDABLE** are senior-default calls on a genuine
fork; the rest are low-risk.

1. **Diff base = per-session pre-edit snapshot, not git working-tree/HEAD.**
   (OVERRIDABLE.) The task framed this as the central fork. Chosen for precision
   (isolates the agent's edits) and non-git-cwd support. If Dorian prefers the
   zero-bookkeeping "diff vs HEAD" model despite conflating user edits, the whole
   `services/diff/edit-baseline.ts` capture layer collapses to the `git-baseline`
   helper — a smaller build. **Sanity-check this first.**
2. **Baselines are in-memory and ephemeral** (lost on server restart → fallback
   to HEAD/empty). No EventLog persistence in v1. (OVERRIDABLE if durable review
   across restarts is required — but that is a heavier build and out of the
   fast-follow's spirit.)
3. **Capture happens at the claude-code PreToolUse hook**; other runtimes use the
   reconstruction→HEAD→empty ladder (Q3). Assumes the claude-code adapter already
   exposes a synchronous pre-tool seam that can read the file before the edit
   applies — consistent with the shipped hook lifecycle, but **verify the exact
   seam** at Chunk A start. (OVERRIDABLE on wiring detail, not on the model.)
4. **The diff is a distinct `diff` canvas variant, not a mode of the `file`
   variant.** Keeps edit-protection uncomplicated (diff docs hold no `editing`
   flag) and lets a file be open as both an editor and a diff simultaneously.
5. **Accept = dismiss (no write); baseline advances only on explicit
   finish/accept-all.** An alternative "accept = advance baseline immediately per
   hunk" was rejected as chattier and harder to undo. (Low risk.)
6. **`@codemirror/merge` unifiedMergeView is the renderer**, its per-chunk gutter
   intercepted to drive disk writes. Evaluated as the clear winner over a
   standalone differ because it reuses the shipped CM6 stack/theme/language setup.
7. **Auto-open uses the existing `subscribeSessionEvent` tap** and gates on
   `attachedSessionId` exactly like `ui_command`; no new server event is added.
   Assumes `tool_call` events reliably carry a parseable `input.file_path` for
   edit-family tools (confirmed: `ToolCallEventSchema.input` is the JSON tool
   input string).
8. **Image diff is web-only** (byte serving returns `null` under DirectTransport),
   consistent with the shipped image viewer. Text diff has full transport parity.
9. **`open_diff` control_ui action is added** for agent-deliberate diffs, even
   though the headline path is DorkOS-observed auto-open. Cheap, symmetric with
   `open_file`; if scope pressure hits, the auto-open subscriber alone satisfies
   the ticket and `open_diff` can drop to a follow-up. (Low risk.)
10. **`GET /api/diff/pending` (explorer provenance badges) is a nice-to-have**
    inside Chunk A, cut to a DOR follow-up if it risks the chunk — matching how
    the workbench spec treated its own provenance badges.

## Related ADRs

- **`260711-142049`** "Diff base: per-session pre-edit snapshot over
  git working tree" (`decisions/260711-142049-diff-base-session-snapshot-over-git-working-tree.md`,
  proposed) — the load-bearing architectural decision (why not git; capture
  point; fallback ladder; ephemerality).
- `260708-185518` multi-document canvas model (the store this extends).
- `0290`–`0293` (canvas editing, edit-protection, editor-owns-document/host-owns-
  file) — the `PUT /content` optimistic-concurrency contract reject writes reuse.
- `260708-111459` two-tier generative UI (no new delivery mechanism; control on
  `control_ui`).

## References

- Ideation anchor: `specs/diff-viewer/01-ideation.md`
- Parent: `specs/right-panel-workbench/` (`01-ideation.md` §4 + Decision round 2;
  `02-specification.md` Non-Goals; `04-implementation.md`)
- DOR-212 (this), DOR-211 (workbench umbrella)
- Shipped platform: `app-store-canvas.ts`, `routes/files.ts`, `ui-tool-contract.ts`,
  `ui-action-dispatcher.ts`, `viewer-registry.ts`, `stream-manager.ts`
  (`subscribeSessionEvent`), `use-canvas-file-save.ts`
- External: `@codemirror/merge` (unifiedMergeView / MergeView, per-chunk
  accept/reject), GitHub image-diff modes (2-up / swipe / onion-skin)
