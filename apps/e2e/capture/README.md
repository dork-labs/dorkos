# Product capture pipeline

Reproducible Playwright-driven capture of the real DorkOS UI, rendering seeded
demo data, for the marketing site. Every asset is the actual app rendering
actual (seeded) data — no DOM-doctoring, no mock components.

## Two-phase pipeline

Like an organized video editor, raw source material is kept strictly apart
from processed deliverables:

```bash
pnpm --filter @dorkos/e2e capture:record   # RECORD: boot + drive + save raws to the library
pnpm --filter @dorkos/e2e capture:process  # PROCESS: edit raws → apps/site/public/product/
pnpm --filter @dorkos/e2e capture          # both phases, in order
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
into `apps/site/public/product/` plus `manifest.json` (tagged with the source
`runId`).

The payoff: **editing changes are re-process-only.** A trim, seam, or encode
tweak never requires re-booting the app or re-recording — re-run
`capture:process` against the existing raws. The library itself is gitignored
(raws are heavy and regenerable); see `library/README.md` for the layout.

## Output contract

The site consumes these through `ProductFrame` (`apps/site/src/layers/features/marketing/ui/ProductFrame.tsx`)
and pins them with the media-guard test in
`apps/site/src/layers/features/marketing/lib/__tests__/features.test.ts`:

- every referenced surface ships `<surface>-light.png`;
- loop surfaces additionally ship `<surface>-dark.webm` + `<surface>-dark.png` (the poster).

Desktop stills are 1280×800 @2x (tight enough that UI text reads at rendered
size); mobile stills are 390×844 @3x. Loops are 1280×800 (desktop) / 390×844
(mobile) VP9, no audio. `manifest.json` describes each asset (surface, theme,
kind, dimensions, size, duration).

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

- `config.ts` — ports, viewports, library/output paths, and all deterministic demo data (fleet, tasks, runs, sessions, prompts, canvas doc, discovery projects, marketplace).
- `boot.ts` — spawns/teardowns the test-mode server + Vite client.
- `seed.ts` — pre-boot filesystem prep + post-boot API/DB seeding.
- `record.ts` / `process.ts` / `capture.ts` — the phase entry points (record raws, process raws, both).
- `library.ts` — the media library: run recorder (raw sink + `run.json` provenance), `latest` symlink, retention pruning, run loading.
- `lib.ts` — shared Playwright plumbing (theme init-script, live-turn opener, raw loop recorder + head-trim marker).
- `surfaces-desktop.ts` / `surfaces-mobile.ts` — the per-surface drives.
- `optimize.ts` — the editing stage: PNG recompression (sharp), loop editing (ffmpeg-static: head-trim, end-seam crossfade, two-pass VP9, poster extraction), and the manifest writer.

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
