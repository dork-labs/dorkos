# Product capture pipeline

Reproducible Playwright-driven capture of the real DorkOS UI, rendering seeded
demo data, for the marketing site. Every asset is the actual app rendering
actual (seeded) data — no DOM-doctoring, no mock components.

## Regenerate everything

```bash
pnpm --filter @dorkos/e2e capture
```

That single command:

1. wipes and prepares an isolated `~/.dork-capture` home + an offline marketplace cache,
2. boots a **test-mode** DorkOS server (ports 4344/4343, no real Claude/Codex/OpenCode credentials) and a Vite client bound to it,
3. seeds a deterministic fleet, tasks + pinned run history, completed sessions, and a file-backed canvas doc through real API/code paths,
4. drives the UI through every money state and writes optimized stills + short webm loops, plus `manifest.json`, into `apps/site/public/product/`,
5. tears the stack down.

## Output contract

The site consumes these through `ProductFrame` (`apps/site/src/layers/features/marketing/ui/ProductFrame.tsx`)
and pins them with the media-guard test in
`apps/site/src/layers/features/marketing/lib/__tests__/features.test.ts`:

- every referenced surface ships `<surface>-light.png`;
- loop surfaces additionally ship `<surface>-dark.webm` + `<surface>-dark.png` (the poster).

Desktop stills are 1280×800 @2x (tight enough that UI text reads at rendered
size); mobile stills are 390×844 @3x. `manifest.json` describes each asset
(surface, theme, kind, dimensions, size, duration).

## What gets captured

| Surface           | Stills      | Loop | Notes                                            |
| ----------------- | ----------- | ---- | ------------------------------------------------ |
| `cockpit`         | light       | —    | Dashboard home: the fleet + recent activity      |
| `agents`          | light       | —    | Fleet list with identities/runtimes, Active rows |
| `topology`        | light, dark | dark | Mesh graph, 6 agents across namespaces           |
| `tasks`           | light       | —    | Schedules + expanded green run history           |
| `marketplace`     | light       | —    | In-app browse grid                               |
| `chat-streaming`  | light, dark | dark | Mid-stream: markdown + tool-call cards           |
| `tool-approval`   | light       | —    | Permission prompt awaiting the operator          |
| `canvas`          | light, dark | dark | Canvas open beside chat with a file-backed doc   |
| `canvas-editing`  | light, dark | dark | Live typing/formatting in the canvas editor      |
| `subagents`       | light, dark | dark | Three sub-agents running concurrently, settling  |
| `multi-session`   | light, dark | dark | Sidebar alive: four concurrent streams pulsing   |
| `personality`     | light, dark | dark | Personality radar morphing through presets       |
| `agent-discovery` | light, dark | dark | Onboarding scan finding a mixed existing fleet   |
| `mobile-sessions` | light       | —    | 390px session-list sheet with working indicators |
| `mobile-chat`     | light, dark | dark | 390px streaming session (the mobile loop)        |
| `mobile-approval` | light       | —    | 390px tool-approval prompt                       |

Dark stills exist only where a loop needs a poster (plus the new surfaces, so
the site can wire them without a re-shoot).

## Determinism

Demo data lives in `config.ts` with pinned timestamps (run history at 2:47 AM,
etc.) and fixed content. Scheduled-task crons are non-imminent so the scheduler
never fires during the capture window. Multi-session drives rotate through a
fixed prompt pool so repeated drives mint distinct, stable session titles.
Nothing rendered depends on `Date.now()`.

## Files

- `config.ts` — ports, viewports, and all deterministic demo data (fleet, tasks, runs, sessions, prompts, canvas doc, discovery projects, marketplace).
- `boot.ts` — spawns/teardowns the test-mode server + Vite client.
- `seed.ts` — pre-boot filesystem prep + post-boot API/DB seeding.
- `capture.ts` — the entry point/orchestrator (`pnpm --filter @dorkos/e2e capture`).
- `lib.ts` — shared Playwright plumbing (theme priming, live-turn opener, loop recorder).
- `surfaces-desktop.ts` / `surfaces-mobile.ts` — the per-surface drives.
- `optimize.ts` — PNG recompression (sharp), webm budget enforcement, and the manifest writer.

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
