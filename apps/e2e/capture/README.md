# Product media pipeline

Reproducible Playwright-driven capture of the real DorkOS UI, rendering seeded
demo data — one **shot registry** feeding the marketing site, docs, and
changelogs. Every automated asset is the actual app rendering actual (seeded)
data — no DOM-doctoring, no mock components — and a person can override any shot
with hand-captured media that wins.

## The shot registry

`shots.ts` is the single source of truth. A **shot** is one logical surface (the
cockpit, the topology graph, a streaming chat) with an `id`, a `kind`
(`still` or `loop`), a `frame` (`desktop`/`mobile`), and its `consumers`
(`marketing`, `docs`, `changelog`). The process phase writes a snapshot of the
registry into `manifest.json` (`shots`), so the site and docs stay consistent
with the pipeline without importing across the app boundary. Add a shot for docs
or changelog by listing it here with the right consumers — it never shows up on
`/features` unless tagged `marketing`.

> A shot's `kind` is `still` or `loop`, not a three-way `still`/`loop`/`both`:
> every loop already ships a light still (plus its dark poster), so "loop" _is_
> "both". There is no loop-without-a-still, so two values stay exhaustive.

## Two-phase pipeline

Like an organized video editor, raw source material is kept strictly apart
from processed deliverables:

```bash
pnpm --filter @dorkos/e2e capture:record          # RECORD: boot + drive + save raws to the library
pnpm --filter @dorkos/e2e capture:process         # PROCESS: edit raws (+ overrides) → apps/site/public/product/
pnpm --filter @dorkos/e2e capture                 # both phases, in order
pnpm --filter @dorkos/e2e capture:archive <label> # freeze the current set under archive/<label>/
```

**Record** (`record.ts`):

1. wipes and prepares an isolated `~/.dork-capture` home + an offline marketplace cache,
2. boots a **test-mode** DorkOS server (ports 4344/4343, no real Claude/Codex/OpenCode credentials) and a Vite client bound to it,
3. seeds a deterministic fleet, tasks + pinned run history, completed sessions, and a file-backed canvas doc through real API/code paths,
4. drives the UI through every money state and saves RAW, untouched screenshots + recordings into `library/<run-id>/raw/` with a `run.json` provenance manifest (settings, app git SHA, source hashes, per-loop trim markers),
5. tears the stack down, points `library/latest` at the run, and prunes the library to the last 3 runs.

**Process** (`process.ts`, takes an optional run id, defaults to `latest`):
reads the raws and runs the full editing stage — PNG optimization, head-trim to
the run's markers, the end-seam crossfade, two-pass VP9, poster extraction —
then **applies human overrides on top**, into `apps/site/public/product/` plus
`manifest.json`. Output order: wipe → write auto-processed → apply overrides, so
wiping first stays safe (overrides are re-applied every run). The wipe only
touches top-level `*.png`/`*.webm`/`manifest.json` — `archive/` is never
disturbed.

The payoff: **editing changes are re-process-only.** A trim, seam, encode, or
override tweak never requires re-booting the app or re-recording — re-run
`capture:process` against the existing raws. The library itself is gitignored
(raws are heavy and regenerable); see `library/README.md` for the layout.

## Parallel capture (`--shards N`)

Recording is the slow phase (it boots a stack, drives ~16 surfaces, and holds
each loop for its full duration). `--shards N` splits those shots across `N`
**fully isolated stacks** and records them at the same time:

```bash
pnpm --filter @dorkos/e2e capture:record --shards 2   # record on 2 parallel stacks
pnpm --filter @dorkos/e2e capture --shards 3          # record on 3, then process (once)
```

The safe parallel unit is a whole stack, so each shard gets its own:

- **data directory** (`DORK_HOME`): shard 0 keeps the base `~/.dork-capture`; shard _i_ uses `~/.dork-capture-<i>`. Each has its own SQLite DB, config, and scan boundary, so global-state mutations (onboarding dismissal, scan roots) never cross shards.
- **port pair**: `SERVER_PORT`/`VITE_PORT` = `4344`/`4343` + `i × 10` (shard 1 → 4354/4353, shard 2 → 4364/4363). All clear of the dev (`6xxx`), production (`4242`), and e2e-mock (`4243`/`4248`) ports.

How a sharded record runs (`record.ts`):

1. **Build once.** Server workspace deps are built a single time up front (`buildServerDeps`), then every shard boots from that output — no per-shard rebuild.
2. **Partition.** Shots are split round-robin by registry order (`partitionShots` in `shots.ts`). `agent-discovery` is pinned to shard 0 and, like every shard, driven **last** in its stack — it flips global onboarding state, which every other shot in the same stack needs left dismissed (each shard's own `DORK_HOME` keeps that flip local).
3. **Record in parallel.** One `record-shard.ts` worker process per shard prepares its filesystem, boots its stack, seeds it, and captures **only its assigned shots** into the shared run's `raw/` dir (file names never collide — shots are disjoint), writing a partial manifest to `library/<run-id>/shards/`.
4. **Merge.** Once every shard exits, the orchestrator merges the partials into one `run.json` (assets sorted by file name), points `latest` at it, and prunes — producing exactly the run a serial record would.

The **process** phase is shard-agnostic: it always reads one merged run, so a
serial run and a sharded run yield the **same published asset set** (`manifest.json`
`shots` + files + dimensions are identical; only VP9 bytes and per-loop head-trim
timing vary run-to-run, as they already do serial-to-serial).

Teardown is reliable: each worker tears its own stack down in a `finally` and on
`SIGTERM`/`SIGINT` (`teardownAll`), and the orchestrator kills every shard's
process group on failure or interrupt, so nothing is left holding a port.

**Default is `--shards 1`** (the unchanged serial path). How much sharding helps
is bound by cores and by the per-shard boot+seed cost, which is paid on every
shard: 2 shards is a solid win; beyond that, returns fall off once the fixed
boot+seed overhead and the `agent-discovery` long pole dominate the critical
path. Pick `N` to fit the box.

## Human overrides

A person can beat the automated capture for any shot: drop files in
`overrides/<shot-id>/` and they win. Manual sources run through the **same**
optimization path (palette-quantized PNG for stills; fps-normalized, two-pass
VP9 with an extracted poster for loops) and are scaled to the shot's target
dimensions — an override is never a lower-quality second class. If a source's
aspect ratio doesn't match the shot's frame, that shot **fails loudly** rather
than being cropped. `skipAuto` (in `override.json` or `shots.ts`) tells the
record phase not to bother capturing that shot at all. Full workflow:
[`overrides/README.md`](overrides/README.md).

## Archive (frozen past versions)

`capture:archive <label>` copies the currently published assets + manifest into
`apps/site/public/product/archive/<label>/` with an archive manifest. A docs page
or changelog entry that embeds a **past** version points at
`archive/<label>/…`, which is immutable and resolves forever; current embeds use
the live path and always show the latest capture.

```bash
pnpm --filter @dorkos/e2e capture:archive v0.45.0                  # archive everything
pnpm --filter @dorkos/e2e capture:archive v0.45.0 --shots canvas,topology  # only these shots
```

**Repo-size discipline:** archives are committed binaries. Archive **only the
shots a release's notes actually embed** (release automation passes `--shots`);
never snapshot the whole set "just in case". Old archives are never touched by
the process phase.

## Consuming media

- **Marketing site** — `ProductFrame` resolves files by convention and gates
  loop playback via the shot registry; features bind a shot through `media.surface`.
- **Docs** — embed `<ProductShot id="canvas" alt="…" />` in any `.mdx`; it
  renders the same assets in the shared frame. Registered in
  `apps/site/src/components/mdx-components.tsx`.
- **Changelog / release notes** — embed media via absolute URLs. Current:
  `https://dorkos.ai/product/<file>`. Frozen at a release:
  `https://dorkos.ai/product/archive/<version>/<file>` (archive that version's
  shots first). See `changelog/README.md`.

Guard tests keep it honest: `features.test.ts` (catalog media exists + framing),
`shots.test.ts` (registry ↔ `LOOP_SURFACES` consistency + every docs
`<ProductShot>` id resolves and its files exist).

## Output contract

Desktop stills are 1280×800 @2x (tight enough that UI text reads at rendered
size); mobile stills are 390×844 @3x. Loops are 1280×800 (desktop) / 390×844
(mobile) VP9, no audio. `manifest.json` (schema v2) carries the shot registry
(`shots`) and, per asset, its `source` (`auto`/`manual`), `capturedAt`, and
either the source `runId` (auto) or `override` provenance (manual):

- every marketing shot ships `<id>-light.png`;
- loop shots additionally ship `<id>-dark.webm` + `<id>-dark.png` (the poster).

## Theme (no light-mode flash)

Playwright records from page creation, so a dark loop must be dark on its very
first frame. The theme is seeded on the recording **context** via
`seedThemeOnContext` (`lib.ts`), which registers a `context.addInitScript` that
sets `localStorage['dorkos-theme']` and toggles the `dark` class on
`documentElement` _before any page script runs_. Never set the theme after
navigating — that is what put a light boot frame on film.

## Processing (the editing stage)

Every loop is edited by `writeLoop` (`optimize.ts`) with the bundled
`ffmpeg-static` binary — no system ffmpeg required:

1. **Head-trim.** Each raw loop carries a timestamp marker for where its action
   begins (recorded into `run.json` by `recordLoop` in `lib.ts`). Drives whose
   motion happens _inside_ the drive (personality morphs, canvas typing) call
   `mark()` at the content start; drives that build a state and hold default
   the trim to drive completion. ffmpeg cuts everything before the mark.
2. **End-seam crossfade.** The clip opens clean (no blend on film); over the
   final ~300ms the clip's own first 300ms of footage is alpha-faded IN over
   the tail, so the literal last frame equals the literal first frame and the
   restart is invisible. Two hard-won rules live in this filter: the overlay
   must be windowed (`enable='between(t,dur-cf,dur)'` + `eof_action=pass`) or
   ffmpeg's default `eof_action=repeat` composites the overlay's last frame
   over the whole clip (full-duration double-exposure ghosting), and the VFR
   Playwright source must be fps-normalized first or a 300ms trim window can
   hold a single barely-faded frame. Clips too short to spare the fade ship
   straight.
3. **Consistent encode.** Two-pass VP9 targeting ~1.35MB (under the 1.5MB
   budget), no audio, normalized to the surface's dimensions. Two passes because
   average-bitrate lands on the target regardless of scene complexity — a fixed
   CRF cannot.
4. **Poster.** The dark PNG poster is the loop's own first post-trim frame
   (`extractPoster`), so the site's poster→video handoff is invisible. There is
   no separate dark-still capture.

The stage is deterministic and idempotent: the same raw + markers always yields
the same webm + poster.

## What gets captured

| Surface           | Stills | Loop | Notes                                            |
| ----------------- | ------ | ---- | ------------------------------------------------ |
| `cockpit`         | light  | —    | Dashboard home: the fleet + recent activity      |
| `agents`          | light  | —    | Fleet list with identities/runtimes, Active rows |
| `topology`        | light  | dark | Mesh graph, 6 agents across namespaces           |
| `tasks`           | light  | —    | Schedules + expanded green run history           |
| `marketplace`     | light  | —    | In-app browse grid                               |
| `chat-streaming`  | light  | dark | Mid-stream: markdown + tool-call cards           |
| `tool-approval`   | light  | —    | Permission prompt awaiting the operator          |
| `canvas`          | light  | dark | Canvas open beside chat with a file-backed doc   |
| `canvas-editing`  | light  | dark | Live typing/formatting in the canvas editor      |
| `subagents`       | light  | dark | Three sub-agents running concurrently, settling  |
| `multi-session`   | light  | dark | Sidebar alive: four concurrent streams pulsing   |
| `personality`     | light  | dark | Personality radar morphing through presets       |
| `agent-discovery` | light  | dark | Onboarding scan finding a mixed existing fleet   |
| `mobile-sessions` | light  | —    | 390px session-list sheet with working indicators |
| `mobile-chat`     | light  | dark | 390px streaming session (the mobile loop)        |
| `mobile-approval` | light  | —    | 390px tool-approval prompt                       |

Dark PNGs exist only as loop posters, and each is extracted from its loop's own
first frame during post-processing — no dark screenshots are taken.

## Determinism

Demo data lives in `config.ts` with pinned timestamps (run history at 2:47 AM,
etc.) and fixed content. Scheduled-task crons are non-imminent so the scheduler
never fires during the capture window. Multi-session drives rotate through a
fixed prompt pool so repeated drives mint distinct, stable session titles.
Nothing rendered depends on `Date.now()`.

## Files

- `shots.ts` — **the shot registry** (source of truth): every shot's id, kind, frame, consumers, and target dimensions; plus the manifest snapshot projection.
- `config.ts` — ports, viewports, library/output/archive/overrides paths, and all deterministic demo data (fleet, tasks, runs, sessions, prompts, canvas doc, discovery projects, marketplace).
- `boot.ts` — spawns/teardowns the test-mode server + Vite client.
- `seed.ts` — pre-boot filesystem prep + post-boot API/DB seeding.
- `record.ts` / `process.ts` / `capture.ts` / `archive.ts` — the entry points (record raws, process raws + overrides, both, freeze an archive).
- `library.ts` — the media library: run recorder (raw sink + `run.json` provenance), `latest` symlink, retention pruning, run loading.
- `overrides.ts` — human-override discovery, validation, and application (manual media beats the automated capture).
- `lib.ts` — shared Playwright plumbing (theme init-script, live-turn opener, raw loop recorder + head-trim marker, the `attemptShot` skip guard).
- `surfaces-desktop.ts` / `surfaces-mobile.ts` — the per-surface drives.
- `optimize.ts` — the editing stage: PNG recompression + aspect-validated scaling (sharp), loop editing (ffmpeg-static: head-trim, end-seam crossfade, two-pass VP9, poster extraction), and the v2 manifest writer.
- `overrides/` — committed human-override sources (see `overrides/README.md`).
- `__tests__/` — unit tests for the registry, aspect validation, and override discovery (`pnpm --filter @dorkos/e2e test`).

## Test-mode seam

Four demo scenarios (paced streaming, tool approval, file-backed canvas, and a
three-sub-agent fan-out) live in
`apps/server/src/services/runtimes/test-mode/demo-scenarios.ts` — inside the
existing test-mode runtime boundary, reachable only when `DORKOS_TEST_RUNTIME=true`
and selectable only via `POST /api/test/scenario`. They emit standard
`StreamEvent`s through the exact normalizer → projector → SSE path a production
runtime uses, so the client renders real components against real stream data.
The canvas document text in `demo-scenarios.ts` must byte-match
`CANVAS_SOURCE_DOC` in `config.ts` (the autosave is conditioned on it).
