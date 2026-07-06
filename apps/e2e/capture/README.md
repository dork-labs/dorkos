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
3. seeds a deterministic fleet, tasks + pinned run history, and completed sessions through the real API,
4. drives the UI through every money state and writes optimized stills + short webm loops, plus `manifest.json`, into `apps/site/public/product/`,
5. tears the stack down.

Output is the contract consumed by the marketing site. Filenames are
`<surface>-<variant>.<ext>` (e.g. `cockpit-light.png`, `chat-streaming-dark.webm`);
`manifest.json` describes each asset (surface, theme, kind, dimensions, size, duration).

## What gets captured

| Surface          | Stills      | Loop | Notes                                       |
| ---------------- | ----------- | ---- | ------------------------------------------- |
| `cockpit`        | light, dark | —    | Dashboard home: the fleet + recent sessions |
| `agents`         | light, dark | —    | Fleet list with identities/runtimes         |
| `topology`       | light, dark | dark | Mesh graph, ~6 agents across namespaces     |
| `tasks`          | light, dark | —    | Schedules + expanded green run history      |
| `marketplace`    | light, dark | —    | In-app browse grid                          |
| `chat-streaming` | light, dark | dark | Mid-stream: markdown + tool-call cards      |
| `tool-approval`  | light, dark | —    | Permission prompt awaiting the operator     |
| `canvas`         | light, dark | dark | Canvas open beside chat with a document     |
| `mobile-cockpit` | light       | —    | 390px session view                          |

## Determinism

Demo data lives in `config.ts` with pinned timestamps (run history at 2:47 AM,
etc.) and fixed content. Scheduled-task crons are non-imminent so the scheduler
never fires during the capture window. Nothing rendered depends on `Date.now()`.

## Files

- `config.ts` — ports, viewports, and all deterministic demo data (fleet, tasks, runs, sessions, marketplace).
- `boot.ts` — spawns/teardowns the test-mode server + Vite client.
- `seed.ts` — pre-boot filesystem prep + post-boot API/DB seeding.
- `capture.ts` — Playwright driving, entry point (`pnpm --filter @dorkos/e2e capture`).
- `optimize.ts` — PNG recompression (sharp), webm sizing, and the manifest writer.

## Test-mode seam

Three demo scenarios (rich paced streaming, tool approval, canvas open) live in
`apps/server/src/services/runtimes/test-mode/demo-scenarios.ts` — inside the
existing test-mode runtime boundary, reachable only when `DORKOS_TEST_RUNTIME=true`
and selectable only via `POST /api/test/scenario`. They emit standard
`StreamEvent`s through the exact normalizer → projector → SSE path a production
runtime uses, so the client renders real components against real stream data.
