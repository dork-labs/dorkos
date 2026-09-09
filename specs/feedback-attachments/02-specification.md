# Feedback Attachments — Specification

> Status: validated. Successor to the deferred round-2 slices of
> `specs/feedback-pipeline` (design-decisions.md §4). Supersedes nothing in the
> shipped pipeline; adds the screenshot tiers it deferred.

## Problem

The feedback dialog ships two dead placeholders — "Add screenshot (coming
soon)" and "Point at element (coming soon)". The pipeline behind it (Neon +
Linear dual-write) is live as of 2026-09-09 (DOR-909). A bug report without a
picture makes triage slow; the placeholders promise a roadmap we now build.

## Decisions (frozen — do not re-litigate in implementation)

1. **Screenshots are stored by Linear, not by us.** The site calls Linear's
   `fileUpload` GraphQL mutation (filename, contentType, size) → receives
   `{ uploadUrl, assetUrl, headers[] }` → PUTs the raw bytes to `uploadUrl`
   with those exact headers + the content type → embeds
   `![Screenshot](assetUrl)` as an `**Attachments**` section in the issue
   description (markdown embed renders an inline preview; `attachmentCreate`
   card rendering for arbitrary images is unconfirmed, so we do NOT use it).
   Linear asset URLs are workspace-private (401 without auth) — a leaked link
   does not leak the screenshot. ADR 260803-205035 already records "heavier
   content lives in Linear as attachments, not a second blob store."
2. **The image travels inline with the submission** as a compressed WebP data
   URL (client → local server → site), per DOR-910's original design. The
   unused `screenshotUploadId` field in `FeedbackSubmissionSchema` is REMOVED
   (dead code) and replaced by `screenshot: { dataUrl }`.
3. **Client-side compression before send**: downscale so the longest edge
   ≤ 2000px, encode WebP quality ~0.8 (PNG fallback where WebP encode is
   unsupported), hard-cap the encoded payload at 600 KB — over-cap after
   compression = drop with a visible toast, never send.
4. **Body caps**: site route raises `MAX_BODY_BYTES` 64 KB → 900 KB with a
   per-field Zod cap on the data URL (850_000 chars); the server's
   `/api/feedback` forward stays under the existing global 1 MB Express JSON
   limit — set a route-local `express.json({ limit: '2mb' })` on the feedback
   router to leave headroom. The lockstep-by-hand rule between
   `feedback-reporter.ts` caps and the site route caps continues to apply.
5. **Capture library**: `@zumer/snapdom` (MIT), imported **dynamically at
   capture time** (never in the initial bundle). SVG-foreignObject approach =
   browser renders oklch/Tailwind-4 CSS natively. Before first use the
   implementer verifies current maintenance (commits within ~6 months) — if
   dead, fall back to `modern-screenshot` (same architecture, 9.7 KB gz).
6. **Desktop (Electron)**: `webContents.capturePage()` via the established IPC
   pattern (channel const + `ipcMain.handle` + preload `electronAPI` method +
   client seam with web fallback). Pixel-perfect and silent. The renderer is a
   single BrowserWindow loading `http://localhost:<port>` — no view layering
   concerns. Falls back to snapdom when the bridge is absent.
7. **Mobile**: "Add screenshot" = native file input (`accept="image/*"`,
   photo picker); paste/drag are desktop affordances that stay wired but
   undiscovered on touch. "Capture app view" (DOM render) works on mobile
   unchanged. "Point at element" is hidden on touch (`useIsMobile()`), like
   the sidebar precedent in AppShell.
8. **Obsidian (DirectTransport)**: all capture affordances hidden — that
   transport posts only the light telemetry event and drops rich fields by
   design.
9. **Point at element** (fast-follow tier): crosshair overlay → click →
   capture the app root via the same capture util, crop to the element's
   bounding rect (± 24px padding, clamped to viewport), collect element
   identity — nearest `data-slot`, `data-testid`, a shortest-unique CSS
   selector (small local util, no new dep unless `@medv/finder` proves
   necessary), tag chain — and open the feedback dialog prefilled (kind=bug,
   screenshot attached, identity lines appended to diagnostics). Escape or
   click-outside cancels. Desktop-web + Electron only.
10. **Scope verification is step zero of the backbone PR**: Linear's docs say
    the `issues:create` scope "allows creating new issues and their
    attachments" — empirically verify `fileUpload` works with the site's
    Create-issues-scoped key before building on it (one throwaway call). If
    refused, STOP and surface: the operator must mint a broader key; do not
    silently widen scope requirements.
11. **Copy**: never "cockpit"/"mission control" in any user-facing string.
    Screenshot privacy line in the dialog: captures show "only the app, never
    the rest of your screen" (true for both snapdom and capturePage).
12. **Privacy defaults**: screenshot is opt-in per submission (user clicks a
    capture/attach affordance; nothing auto-attaches). Preview shows exactly
    what will be sent; remove is one click. Redaction/annotation is the
    follow-up ticket (DOR-912), not this programme.

## PR decomposition (each PR = worktree + adversarial REVIEW.md pass + merge queue)

### PR 1 — Backbone: screenshot delivery to Linear (site + shared + server)

- `packages/shared` `FeedbackSubmissionSchema`: remove `screenshotUploadId`,
  add optional `screenshot: z.object({ dataUrl: z.string().regex(/^data:image\/(webp|png|jpeg);base64,/).max(850_000) })`.
  `hasScreenshot` stays (metrics continuity).
- `apps/server`: feedback router gets route-local JSON limit ('2mb');
  `feedback-reporter.ts` forwards `screenshot` on the durable payload
  (lockstep caps comment updated).
- `apps/site` route: `MAX_BODY_BYTES` → 900_000; intake schema accepts
  `screenshot` (same shape/caps, `.strict()` preserved).
- `apps/site/src/lib/feedback/linear.ts`: `uploadScreenshot(apiKey, dataUrl)`
  — decode base64 → `fileUpload` mutation → PUT with returned headers →
  return assetUrl; `createFeedbackIssue` embeds
  `![Screenshot](assetUrl)` under `**Attachments**`. Upload failure degrades:
  issue is still created, a `Screenshot: upload failed (<reason>)` line lands
  in the Attachments section, route stays best-effort (never 500s the
  submission over a screenshot).
- Step zero: live scope check of `fileUpload` with the deployed key (see
  decision 10) — record the result in the PR body.
- Tests: schema round-trip, forward pass-through, upload happy path + failure
  degradation (fetch mocked), oversized data URL rejected at intake.

### PR 2 — Dialog capture UI, tier 1 (client)

- Replace the two placeholders: "Add screenshot" becomes real; "Point at
  element" stays a labeled-soon affordance (hidden on mobile) until PR 4.
- Paste (⌘V on open dialog), drag-drop (whole dialog is the drop target with
  the mocked drag-over treatment), browse/photo picker (`accept="image/*"`).
- New `shared/lib/image-compress.ts`: downscale ≤2000px, WebP q0.8, PNG
  fallback, 600 KB output cap — pure util + tests (jsdom can't encode; test
  the math/branching with canvas mocked, and note geometry limits per
  testing.md).
- Thumbnail preview in the dialog + in FeedbackPreviewDialog (new tab), remove
  button, `hasScreenshot` wired, draft carries the compressed data URL.
- Hidden entirely under DirectTransport; mobile shows photo-picker variant.
- Dev Playground: add a captured-state showcase beside the two existing ones.

### PR 3 — One-click "Capture app view" (client + desktop)

- Capture util `shared/lib/app-capture.ts`: Electron path via
  `window.electronAPI.captureAppView()` (new IPC: channel const, handler using
  `webContents.capturePage()`, preload method, typed in vite-env.d.ts) with
  web fallback `snapdom` dynamic import capturing `#root`; the dialog hides
  itself during capture (so the screenshot shows the app, not the dialog),
  then restores with the image attached.
- Feeds the same compression util from PR 2.
- Smoke path documented for the desktop app (capturePage needs a real
  Electron run — name the manual check in the PR body; do not fake it in
  jsdom).

### PR 4 — Point at element (client)

- Overlay feature (own slice under `features/feedback/`): crosshair cursor,
  hover highlight (element bounding box), click captures + crops via PR 3's
  util, Escape cancels; element identity block appended to diagnostics
  (`Element: <selector>` / `Slot: <data-slot>` / `Testid: <data-testid>`).
- Entry point: the dialog affordance + (optional, if trivial) a command
  palette entry. Desktop-web + Electron; hidden on touch.
- Dev Playground showcase for the overlay's hover state (static).

## Follow-ups (tickets, not this programme)

- DOR-912 reopened: annotation + redaction canvas on the preview (redaction is
  the load-bearing half).
- Reconciliation sweep for `received` rows whose Linear create failed
  (pre-existing documented follow-up).
- If Linear file uploads prove flaky at our sizes, revisit `attachmentCreate`
  - external storage — explicitly out of scope now.

## Verification bar (every PR)

- `pnpm vitest run <touched files>` green; affected typecheck + lint green.
- New assertions mutation-verified (red-then-green) per `.claude/rules/testing.md`.
- Adversarial review per REVIEW.md by a separate agent BEFORE the PR opens;
  blockers fixed, findings recorded in the PR body.
- PR 1 additionally: live end-to-end proof — a real submission with a small
  test image produces a Linear issue with a rendered screenshot (screenshot of
  the Linear issue in the PR body), then the test issue is canceled.
