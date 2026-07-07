---
name: capturing-product-media
description: Regenerate the marketing site's product screenshots and video loops from the real DorkOS UI. Use when marketing assets are stale after UI changes, a new feature needs a money shot, or a release calls for a fresh capture — anything under apps/site/public/product/ or the apps/e2e/capture pipeline.
---

# Capturing Product Media

The marketing site shows the **real** DorkOS UI rendering **seeded** demo data — never mockups, never doctored screenshots. One command regenerates every asset. This skill is the map: when to run it, how it works, the honesty rules, the staging knobs, and how to add a new surface.

## When To Use

- The UI changed and a screenshot or loop on the site now looks stale or wrong.
- A new feature needs a "money shot" (hero still or animated loop) on `/features`.
- A release-time refresh of all product media.
- The media-guard test (`apps/site` `features.test.ts`) fails because an asset is missing.

## The One Command

```bash
pnpm --filter @dorkos/e2e capture
```

That single command is fully reproducible. It:

1. wipes an isolated `~/.dork-capture` home + an offline marketplace cache,
2. boots a **test-mode** DorkOS server + Vite client on isolated ports (4344/4343) with no real Claude/Codex/OpenCode credentials,
3. seeds a deterministic fleet, tasks + pinned run history, completed sessions, and a file-backed canvas doc through **real API/code paths**,
4. drives the real UI through every money state, runs the post-processing stage on each loop, and writes optimized stills + edited webm loops + posters + `manifest.json` into `apps/site/public/product/`,
5. tears the stack down.

Before running, confirm ports 4344/4343 are free. The run takes several minutes (it builds server deps, boots, drives ~15 surfaces, and two-pass-encodes the loops).

## Architecture (files in `apps/e2e/capture/`)

- `config.ts` — ports, viewports, and **all** deterministic demo data (fleet, tasks, pinned runs, sessions, prompt pool, canvas doc, discovery projects, marketplace registry). Everything a shot shows is pinned here; nothing depends on `Date.now()`.
- `boot.ts` — spawns/tears down the test-mode server + Vite client, with an isolated `DORK_HOME` and a **directory boundary** confined to the capture world.
- `seed.ts` — pre-boot filesystem prep + post-boot API/DB seeding, all through real code paths.
- `lib.ts` — shared Playwright plumbing: the theme init-script, the live-turn opener, and the loop recorder with its head-trim marker.
- `surfaces-desktop.ts` / `surfaces-mobile.ts` — the per-surface drives (one `drive*` shared between a still and its loop; one `shoot*`/`capture*` that waits for the money state).
- `optimize.ts` — PNG recompression (sharp) and the loop **editing stage** (bundled `ffmpeg-static`): head-trim, tail→head crossfade, two-pass VP9, poster extraction, then the manifest writer.
- `capture.ts` — the orchestrator / entry point.

### Test-mode seam

Demo scenarios (paced streaming, tool approval, file-backed canvas, sub-agent fan-out) live in `apps/server/src/services/runtimes/test-mode/demo-scenarios.ts`, inside the test-mode runtime boundary, reachable only when `DORKOS_TEST_RUNTIME=true` and selectable only via `POST /api/test/scenario`. They emit standard stream events through the exact normalizer → projector → SSE path a production runtime uses, so the client renders **real components against real stream data**.

### Manifest contract

The site consumes assets through `ProductFrame` (`apps/site/.../marketing/ui/ProductFrame.tsx`), which resolves files by convention: `<surface>-light.png` (still) and, for loop surfaces, `<surface>-dark.webm` + `<surface>-dark.png` (the poster). `manifest.json` records each asset's surface, theme, kind, dimensions, size, and (loops) duration. The media-guard test in `apps/site/.../marketing/lib/__tests__/features.test.ts` pins this: every referenced surface ships a light still; every loop surface ships a webm + dark poster + light still.

## Honesty Rules (non-negotiable)

- **Real UI + seeded data only.** Every pixel is the actual app rendering data seeded through a real API/code path. No mock components, no DOM doctoring, no editing pixels in.
- **Skip-and-report over faking.** Each drive is error-isolated (`attempt`): if a surface can't reach its money state, it is skipped and logged — never faked. A clean run has zero skips; investigate any skip before shipping.
- **Demo-claim gate.** Only market what is genuinely working. If a surface or pillar is unverified, do not stage a shot that implies it works (see the GTM plan's demo-claim gate).

## Staging Knobs

- **Theme, flash-free.** Playwright records from page creation, so a dark loop must be dark on frame one. `seedThemeOnContext` (`lib.ts`) registers a `context.addInitScript` that sets `localStorage['dorkos-theme']` and the `dark` class on `documentElement` **before any page script runs**. Never set the theme after navigating — that puts a light boot frame on film.
- **Wide right panel.** The personality radar reads better with a generous right column: the drive seeds the exact JSON `react-resizable-panels` persists (`WIDE_RIGHT_PANEL_LAYOUT` in `surfaces-desktop.ts`). The canvas panel width is seeded server-side via the demo scenario's `preferredWidth` (`demo-scenarios.ts`) — bump it if the editor wraps too aggressively.
- **Scan-boundary confinement (privacy).** The onboarding discovery scan can auto-start before config resolves and sweep the server's directory **boundary**. That boundary is pinned to the capture world (`DORKOS_BOUNDARY` in `boot.ts`), and `scanRoots` points only at the seeded projects tree (`PROJECTS_ROOT` in `config.ts`). **Never** let discovery scan the operator's real home directory — the lesson from the privacy incident. Keep the boundary and scan roots inside `~/.dork-capture`.
- **Deterministic timestamps.** Pinned run history uses fixed times (e.g. 2:47 AM) and a single realistic failure, so the ledger never churns between runs. Add new demo data to `config.ts` with pinned dates, never `Date.now()`.

## The Editing Stage (loops)

`writeLoop` (`optimize.ts`) edits every recorded loop with `ffmpeg-static`:

1. **Head-trim** to the action. `recordLoop` records a marker: drives whose motion happens _inside_ the drive (personality morphs, canvas typing) call `mark()` at the content start; drives that build a state and then hold default the trim to drive completion. ffmpeg cuts everything before the mark.
2. **Loop-point crossfade** (~300ms, tail dissolved over the head with an opaque base) so the restart is seamless and never flashes through black.
3. **Two-pass VP9** targeting ~1.35MB (under the 1.5MB budget), no audio, normalized to the surface's dimensions — two passes because average-bitrate hits the target regardless of scene complexity.
4. **Poster** extracted from the loop's own first post-trim frame, so the site's poster→video handoff is invisible. No separate dark screenshots are taken.

Deterministic and idempotent: same source + head-trim → same webm + poster.

## Adding A New Surface (end-to-end)

1. **Scenario (if needed).** If the surface needs scripted stream activity, add a demo scenario in `demo-scenarios.ts` (inside the test-mode boundary) and select it via `POST /api/test/scenario`. Any seeded content must byte-match its `config.ts` counterpart when an autosave/hydration path compares it.
2. **Capture fn.** Add a `drive*` (shared by still and loop) + `shoot*`/`capture*` in `surfaces-desktop.ts` or `surfaces-mobile.ts`. Wait for a real money-state selector before shooting. For a loop, add a `LoopSpec` to `captureLoops`; call `mark()` in the drive only if the motion is in-drive.
3. **Manifest.** It updates automatically — the asset entries flow from the capture fns into `writeManifest`.
4. **`ProductSurface` union + `LOOP_SURFACES`.** Add the surface name to `ProductSurface` in `apps/site/.../marketing/lib/features.ts`; add it to `LOOP_SURFACES` if it ships a loop. `ProductFrame` consumes surfaces purely by this convention — light still for cards/non-animated, dark webm + dark poster when `animate` and a loop exists.
5. **Media guard.** Wire the surface into a feature's `media` in the features catalog; the guard test enforces that its files exist and that phone/desktop framing matches the capture's aspect.

## Verify After A Run

- `pnpm --filter @dorkos/site test` — the media guard must pass (all referenced assets exist, framing matches).
- Spot-check a loop's first frame is dark: `ffmpeg -i <surface>-dark.webm -frames:v 1 /tmp/f.png` and confirm.
- Check per-loop sizes stay ≤1.5MB and the total budget is reasonable (`manifest.json` `totalBytes`).

## Art Direction

- Desktop stills are 1280×800 @2x (text readable at rendered size); mobile is 390×844 @3x; loops match their surface's dimensions.
- What reads premium: an **inhabited** app (a real fleet, distinct session rows, green-with-one-failure run history), motion that tells a story (streaming tokens, morphing radar, pulsing concurrent sessions), and a settled, un-squished layout. Crop modes (`top`/`bottom` in `ProductFrame`) bias a frame toward the edge that holds content when the vertical center is empty.
- Keep loops short and looping cleanly; respect the size budget so the site stays fast.
