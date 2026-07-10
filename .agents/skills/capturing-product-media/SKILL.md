---
name: capturing-product-media
description: Regenerate DorkOS product screenshots and video loops from the real UI, and manage the shot registry, human overrides, and version archives that feed the marketing site, docs, and changelogs. Use when marketing/docs media is stale after UI changes, a new feature or docs page needs a money shot, a person wants to override an automated capture, or a release calls for a fresh capture or archive — anything under apps/site/public/product/ or the apps/e2e/capture pipeline.
---

# Capturing Product Media

DorkOS product media is a **general system**: one shot registry (`apps/e2e/capture/shots.ts`) feeding the marketing site, docs, and changelogs, from **real** UI rendering **seeded** demo data — never mockups, never doctored screenshots. Automated captures can be beaten by human overrides, and any published set can be frozen into a versioned archive. This skill is the map: the registry, the phases, overrides, archives, docs embeds, the honesty rules, and how to add a shot.

## When To Use

- The UI changed and a screenshot or loop on the site or docs now looks stale or wrong.
- A new feature needs a "money shot" (hero still or animated loop) on `/features`, or a docs page needs an embedded `<ProductShot>`.
- A person wants to override an automated capture with hand-captured media.
- A release calls for a fresh capture or a frozen archive of the shots its notes embed.
- A media-guard test (`features.test.ts` or `shots.test.ts`) fails because an asset or registry entry is missing.

## Commands

```bash
pnpm --filter @dorkos/e2e capture                  # record + process (the full refresh)
pnpm --filter @dorkos/e2e capture:record           # boot + drive + save raws to the library
pnpm --filter @dorkos/e2e capture:record --shards N # same, but record on N parallel isolated stacks
pnpm --filter @dorkos/e2e capture:process [run-id] # edit raws + apply overrides → product/ (default: latest)
pnpm --filter @dorkos/e2e capture:archive <label>  # freeze the current published set under archive/<label>/
pnpm --filter @dorkos/e2e test                     # unit tests: registry, partition, aspect guard, override discovery
```

**`--shards N` (parallel record)** splits the shots across `N` fully isolated stacks — each its own `DORK_HOME` (`~/.dork-capture` for shard 0, `~/.dork-capture-<i>` after), server/Vite port pair (`4344`/`4343` + `i×10`), and browser — recorded at the same time, then merged into one run. The **process** phase is unchanged: a serial run and a sharded run produce the **same published asset set**. Default is `1` (the serial path). Reach for it to shorten a full re-record when the box has spare cores; 2 shards is the reliable win, and returns fall off past that once per-shard boot+seed overhead dominates. `--shards` also works on `capture` (only the record phase parallelizes). Details: `apps/e2e/capture/README.md` (Parallel capture).

`capture` is fully reproducible. It runs both pipeline phases:

1. **Record**: wipes an isolated `~/.dork-capture` home + an offline marketplace cache, boots a **test-mode** DorkOS server + Vite client on isolated ports (4344/4343, no real Claude/Codex/OpenCode credentials), seeds a deterministic fleet + tasks + sessions through **real API/code paths**, drives the real UI through every money state, and saves RAW recordings/screenshots into the media library. Shots flagged `skipAuto` (an override supplies them) are not driven.
2. **Process**: edits the raws (head-trim, end-seam crossfade, two-pass encode, poster extraction), **applies human overrides on top**, and writes `apps/site/public/product/` + a v2 `manifest.json`, then tears down.

Before running, confirm ports 4344/4343 are free, and that the workspace packages are built (`pnpm --filter "./packages/*" build`) — a stale/missing `@dorkos/shared` (or other) dist stops the capture client from booting. The run takes several minutes (it builds server deps, boots, drives ~16 shots, and two-pass-encodes the loops).

## The shot registry

`apps/e2e/capture/shots.ts` is the single source of truth. Each **shot** has an `id`, a `kind` (`still` or `loop`), a `frame` (`desktop`/`mobile`), and `consumers` (`marketing` / `docs` / `changelog`). The process phase writes the registry into `manifest.json` (`shots`); the site reads it (`apps/site/.../marketing/lib/shots.ts`) so the marketing `ProductSurface` union + `LOOP_SURFACES` and the docs `<ProductShot>` embeds stay consistent (guarded by `shots.test.ts`). Add a docs- or changelog-only shot by listing it with the right consumers — it never appears on `/features` unless tagged `marketing`. (`kind` is two-valued: every loop already ships a still, so there is no `both`.)

## Human overrides

Drop hand-captured media in `apps/e2e/capture/overrides/<shot-id>/` (`still-light.png` and/or `loop-dark.{mp4,mov,webm,mkv}`, optional `override.json` with `reason`/`capturedBy`/`date`/`skipAuto`) and it **beats** the automated capture. Overrides run through the **same** optimization path and are scaled to the shot's target dimensions; an aspect-ratio mismatch fails that shot loudly rather than cropping. Re-run `capture:process` to apply. Full workflow: `apps/e2e/capture/overrides/README.md`.

## Archive (frozen versions)

`capture:archive <label>` snapshots the published set under `archive/<label>/` (immutable). A docs/changelog embed of a **past** version points at `/product/archive/<label>/…`; current embeds use the live path. Archive **only the shots a release's notes embed** (`--shots a,b,c`) — archives are committed binaries, so keep them minimal.

## Media Library and Editing Workflow

The pipeline behaves like an organized video editor: **raws and deliverables never mix.**

- **Raws** live in `apps/e2e/capture/library/<run-id>/raw/` (gitignored; only `library/README.md` is committed) — untouched Playwright webms and unoptimized screenshots, next to a `run.json` recording provenance: capture settings, the app's git SHA, content hashes of `config.ts` + `demo-scenarios.ts`, and each loop's head-trim marker. A `latest` symlink points at the newest run.
- **Processed deliverables** live in `apps/site/public/product/` (committed); `manifest.json` carries a `runId` field tying them to their source raws.
- **Two-phase commands**: `capture:record` (boot + drive + save raws), `capture:process [run-id]` (edit raws into the published set; defaults to `latest`), `capture` (both).
- **Re-record vs re-process**: UI changed, new surface, or seed-data change → `capture:record` then process. Editing/encode change only (trim, seam, bitrate, poster logic) → `capture:process` — no app boot, no re-shoot.
- **Retention**: the last 3 runs are kept; older runs are pruned automatically at the end of each record run (reported in the run output).

## Architecture (files in `apps/e2e/capture/`)

- `shots.ts` — **the shot registry** (source of truth): ids, kinds, frames, consumers, target dimensions, the manifest snapshot projection, and `partitionShots` (round-robin shot assignment for parallel records; the session-list shots `multi-session`/`mobile-sessions` and `agent-discovery` are pinned to shard 0 via `SHARD_0_PINNED_SHOTS`).
- `config.ts` — ports, viewports, library/output/archive/overrides paths, and **all** deterministic demo data (fleet, tasks, pinned runs, sessions, prompt pool, canvas doc, discovery projects, marketplace registry). Everything a shot shows is pinned here; nothing depends on `Date.now()`.
- `boot.ts` — builds server deps once (`buildServerDeps`) and spawns/tears down the test-mode server + Vite client on this shard's ports, with an isolated `DORK_HOME` and a **directory boundary** confined to the capture world. Process-group teardown (`teardownAll`) leaves no orphaned ports.
- `seed.ts` — pre-boot filesystem prep + post-boot API/DB seeding, all through real code paths.
- `record.ts` / `process.ts` / `capture.ts` / `archive.ts` — the entry points (record raws, process raws + overrides, both, freeze an archive). `record.ts` also orchestrates a `--shards N` parallel record: partition, spawn workers, merge.
- `record-shard.ts` — one parallel-record worker: preps its isolated filesystem, boots its own stack, and captures only its assigned shots into the shared run (spawned by `record.ts`, never run by hand).
- `library.ts` — the media library: run recorder (raw sink + `run.json` provenance), `latest` symlink, retention pruning, run loading.
- `overrides.ts` — human-override discovery, validation, and application (manual media beats the automated capture).
- `lib.ts` — shared Playwright plumbing: the theme init-script, the live-turn opener, the raw loop recorder with its head-trim marker, and the `attemptShot` skip guard.
- `surfaces-desktop.ts` / `surfaces-mobile.ts` — the per-surface drives (one `drive*` shared between a still and its loop; one `shoot*`/`capture*` that waits for the money state).
- `optimize.ts` — the editing stage: PNG recompression + aspect-validated scaling (sharp) and loop editing (bundled `ffmpeg-static`): head-trim, end-seam crossfade, two-pass VP9, poster extraction, then the v2 manifest writer.
- `overrides/` — committed human-override sources. `__tests__/` — unit tests for the pure logic.

### Test-mode seam

Demo scenarios (paced streaming, tool approval, file-backed canvas, sub-agent fan-out) live in `apps/server/src/services/runtimes/test-mode/demo-scenarios.ts`, inside the test-mode runtime boundary, reachable only when `DORKOS_TEST_RUNTIME=true` and selectable only via `POST /api/test/scenario`. They emit standard stream events through the exact normalizer → projector → SSE path a production runtime uses, so the client renders **real components against real stream data**.

### Manifest contract (v2)

The site consumes assets through `ProductFrame` (`apps/site/.../marketing/ui/ProductFrame.tsx`), which resolves files by convention: `<id>-light.png` (still) and, for loop shots, `<id>-dark.webm` + `<id>-dark.png` (the poster); loop-ness comes from the registry (`shotHasLoop`). Docs embed the same assets through `<ProductShot id="…" />`. `manifest.json` (schema v2) carries the registry (`shots`) and, per asset, its dimensions, size, (loops) duration, `source` (`auto`/`manual`), `capturedAt`, and either the source `runId` (auto) or `override` provenance (manual). Two guard tests pin it: `features.test.ts` (catalog media exists + framing) and `shots.test.ts` (registry ↔ `LOOP_SURFACES` consistency, manifest v2, and every docs `<ProductShot>` id resolves with its files present).

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

`writeLoop` (`optimize.ts`) edits every raw loop with `ffmpeg-static`:

1. **Head-trim** to the action. `recordLoop` records a marker into `run.json`: drives whose motion happens _inside_ the drive (personality morphs, canvas typing) call `mark()` at the content start; drives that build a state and then hold default the trim to drive completion. ffmpeg cuts everything before the mark.
2. **End-seam crossfade** (~300ms). The clip opens clean — no blend on film — and its own first ~300ms of footage fades IN over the final ~300ms, so the literal last frame equals the literal first frame and the restart is invisible. Seam placement matters: a head-placed blend makes the video's opening read wrong (founder-reviewed lesson).
3. **Two-pass VP9** targeting ~1.35MB (under the 1.5MB budget), no audio, normalized to the surface's dimensions — two passes because average-bitrate hits the target regardless of scene complexity.
4. **Poster** extracted from the loop's own first post-trim frame, so the site's poster→video handoff is invisible. No separate dark screenshots are taken.

Two hard-won ffmpeg rules live in this filter graph: the seam overlay MUST be windowed (`enable='between(t,dur-cf,dur)'` + `eof_action=pass`) — ffmpeg's default `eof_action=repeat` composites the overlaid segment's last frame over the ENTIRE clip, producing full-duration double-exposure ghosting; and the VFR Playwright source MUST be fps-normalized before frame-accurate trims/fades, or a 300ms window can hold a single barely-faded frame.

Deterministic and idempotent: same raw + markers → same webm + poster.

## Adding A New Shot (end-to-end)

1. **Register it.** Add the shot to `SHOTS` in `apps/e2e/capture/shots.ts` with its `id`, `kind`, `frame`, and `consumers`. This is the source of truth; everything else follows.
2. **Scenario (if needed).** If the shot needs scripted stream activity, add a demo scenario in `demo-scenarios.ts` (inside the test-mode boundary) and select it via `POST /api/test/scenario`. Any seeded content must byte-match its `config.ts` counterpart when an autosave/hydration path compares it.
3. **Capture fn.** Add a `drive*` (shared by still and loop) + `shoot*`/`capture*` in `surfaces-desktop.ts` or `surfaces-mobile.ts`, wrapped in `attemptShot('<id>', …)`. Wait for a real money-state selector before shooting. For a loop, add a `LoopSpec` to `captureLoops`; call `mark()` in the drive only if the motion is in-drive. (Or supply the shot entirely via an override + `skipAuto` — no drive needed.)
4. **Manifest.** It updates automatically — the drive records raw entries into `run.json`, the process phase publishes them, and `writeManifest` embeds the registry.
5. **Consume it.** Marketing: add the id to `ProductSurface` + (if a loop) `LOOP_SURFACES` in `features.ts`, then bind it to a feature's `media`. Docs: embed `<ProductShot id="<id>" alt="…" />` in an `.mdx`. Changelog: reference `https://dorkos.ai/product/<id>-…`.
6. **Guards.** `features.test.ts` and `shots.test.ts` enforce that the registry, catalog, docs embeds, and files all agree — run `pnpm --filter @dorkos/site test`.

## Verify After A Run

- `pnpm --filter @dorkos/site test` — the media guard must pass (all referenced assets exist, framing matches).
- Spot-check a loop's first frame is dark: `ffmpeg -i <surface>-dark.webm -frames:v 1 /tmp/f.png` and confirm.
- Check per-loop sizes stay ≤1.5MB and the total budget is reasonable (`manifest.json` `totalBytes`).

## Art Direction

- Desktop stills are 1280×800 @2x (text readable at rendered size); mobile is 390×844 @3x; loops match their surface's dimensions.
- What reads premium: an **inhabited** app (a real fleet, distinct session rows, green-with-one-failure run history), motion that tells a story (streaming tokens, morphing radar, pulsing concurrent sessions), and a settled, un-squished layout. Crop modes (`top`/`bottom` in `ProductFrame`) bias a frame toward the edge that holds content when the vertical center is empty.
- Keep loops short and looping cleanly; respect the size budget so the site stays fast.
