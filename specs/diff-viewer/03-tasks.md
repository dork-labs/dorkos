# Diff Viewer — Task Breakdown

**Spec:** `specs/diff-viewer/02-specification.md` · **Tracker:** DOR-212 ·
**Mode:** full · **Generated:** 2026-07-11

Two chunks. **Chunk A (Phase 1)** is the complete text-diff review experience —
end-to-end shippable and verifiable on its own. **Chunk B (Phase 2)** adds image
diff modes on top of Chunk A's binary-safe baseline store.

Every task carries the repo's standing constraints: **FSD layers**
(`shared ← entities ← features ← widgets`), **barrel imports only**, **TSDoc on
exports**, **no `os.homedir()`** (server), **SDK imports confined** to their
adapter dir, **Prettier/Tailwind auto-format** (never hand-sort), and
**boundary-escape rejection is mandatory-tested** on every new file/path route.

---

## Phase 1 — Chunk A: Text diff (end-to-end)

Sequence the server + shared + transport seam first (headless-testable), then the
client viewer + auto-open. A reviewer may split the PR at that seam.

### Task 1.1 — Shared contract: `diff` variant, `open_diff`, DTOs

`packages/shared`. Add the `diff` canvas variant to `UiCanvasContentSchema` +
`contentType` enum; add the `open_diff` `control_ui` action (3-place — schema +
`ui-tool-contract.ts` description line); add the diff DTOs (baseline query/
response, advance request, pending query/response); add `diffMediaKindForPath`
to the viewer registry. Zod round-trip tests. **Size:** M · **Deps:** none ·
**Parallel:** 1.2, 1.6

### Task 1.2 — Per-session baseline store (`services/diff/`)

`edit-baseline.ts` (first-touch-wins capture, get, advance, listPending,
clearSession; `Buffer`-based so it's binary-safe for Chunk B) + `git-baseline.ts`
(`git show HEAD:<path>` via `execFile`, no shell). Unit tests with a temp git
fixture. **Size:** M · **Deps:** none · **Parallel:** 1.1, 1.6

### Task 1.3 — Capture wiring (claude-code pre-tool + teardown)

Call `captureFromDisk` from the claude-code PreToolUse/`canUseTool` seam for
edit-family tools BEFORE the edit applies; `clearSession` on session teardown.
SDK import stays confined to `claude-code/`. **Size:** M · **Deps:** 1.2

### Task 1.4 — `routes/diff.ts` (baseline / advance / pending)

Thin, boundary-safe handlers reusing `routes/files.ts` path guards. Baseline
resolution ladder: snapshot → reconstruct(Edit/MultiEdit) → HEAD → empty; 413
oversize, 415 binary; `advance` (finish-review); `pending` (nice-to-have).
**Real** symlink/`..` escape tests. Reverting is NOT here (client reuses
`PUT /api/files/content`). **Size:** L · **Deps:** 1.1, 1.2

### Task 1.5 — Transport methods

`readDiffBaseline` + `advanceDiffBaseline` on both `HttpTransport` (HTTP) and
`DirectTransport` (in-process → **text diff works under Obsidian**). Reverting
keeps using the shipped `writeFile`. **Size:** M · **Deps:** 1.1, 1.4 ·
**Parallel:** 1.6

### Task 1.6 — Config: `workbench.autoOpenDiff`

New boolean config field (default true) + semver migration (per
`adding-config-fields`), docs + tests. **Size:** S · **Deps:** none ·
**Parallel:** 1.1, 1.2, 1.5

### Task 1.7 — Text diff viewer + review model

New `features/diff-review/`: `CanvasDiffContent` (`@codemirror/merge`
`unifiedMergeView`, lazy-loaded, per-hunk gutter intercepted), `use-diff-review`
(load baseline/current; reject = revert-on-disk via `writeFile` w/ expectedHash,
409-safe; accept = dismiss; accept-all/reject-all; markReviewed → advance),
`lib/hunks` (reverted-content builder). Canvas dispatch + store `sourceKey`/
`sourceLabel`/fallback-label for `diff`; `open_diff` dispatcher case (origin-aware
reveal). RTL tests incl. the 409 no-clobber path. **Size:** L · **Deps:** 1.1, 1.5

### Task 1.8 — Auto-open on agent edit

`use-auto-open-diff`: tap `subscribeSessionEvent`, gate on
`attachedSessionId` + edit-family `toolName`, parse `file_path`, dispatch
`open_diff` at origin `'agent'` (view-only tab, coalesced by the store). Gated by
`workbench.autoOpenDiff`; wired once in `main.tsx` beside `subscribeUiCommand`.
Tests: attached-only, non-edit ignored, coalescing, flag-off, tab preference
untouched. **Size:** M · **Deps:** 1.6, 1.7

---

## Phase 2 — Chunk B: Image diff modes

Depends only on Chunk A's (binary-safe) baseline store.

### Task 2.1 — Baseline byte endpoint

`GET /api/diff/baseline/raw` — serve baseline image bytes from the snapshot with
the exact `GET /api/files/raw` security posture (allowlist, nosniff, SVG CSP);
`gitShowHead` bytes fallback, else 404. Real boundary-escape tests. **Size:** S ·
**Deps:** 1.2, 1.4

### Task 2.2 — `diffBaselineMediaUrl` transport

Web-only URL builder; `null` under DirectTransport (image diff is web-only,
mirroring the shipped `mediaUrl` gap). **Size:** S · **Deps:** 2.1

### Task 2.3 — `CanvasImageDiffContent`

2-up / swipe / onion-skin over two `<img>` layers (baseline vs current), plain
CSS + `motion`; whole-file accept/reject; calm web-only message under
DirectTransport. RTL tests for all three modes + reject-writes-baseline. **Size:**
M · **Deps:** 1.7, 2.2

---

## Critical path & parallelism

- **Chunk A critical path:** 1.2 → 1.4 → 1.5 → 1.7 → 1.8 (with 1.1 feeding 1.4/1.7
  and 1.3 riding on 1.2). 1.1, 1.2, 1.6 start in parallel.
- **Chunk B** (2.1 → 2.2 → 2.3) starts once 1.2/1.4 land; 2.3 also needs 1.7.
- **Suggested PRs:** PR 1 = tasks 1.1–1.8 (text diff, end-to-end). PR 2 = tasks
  2.1–2.3 (image diff). PR 1 may be split at the server/client seam (1.1–1.6 then
  1.7–1.8) if a reviewer prefers.

**Next stage:** EXECUTE (`/flow:execute specs/diff-viewer/02-specification.md`).
