---
slug: canvas-dev-server-preview
created: 2026-08-16
status: specified
tracker: DOR-1258
project: Canvas dev-server preview
---

# Canvas dev-server preview — make localhost dev servers actually render in the embedded browser

**Slug:** canvas-dev-server-preview
**Author:** Claude (investigation + orchestration directed by Dorian)
**Date:** 2026-08-16

---

## 1) Intent & Assumptions

- **Task brief (Dorian, 2026-08-16):** "I'm trying to load our Video Pipeline app in the canvas, but it's not visible" (`http://localhost:5178/`, a Vite + React dev server). Find the root cause in a real browser; say whether it's the canvas, the app, or both; fix it; and make this class of failure less confusing for users. Then: "implement both fixes" — the fast one and the proper one.
- **Assumptions:**
  - The embedded browser (`features/canvas`, DOR-216/DOR-233, ADR 260708-185519) stays the surface. We change how loopback targets are loaded and what the user sees when a load fails; the address bar / history / tab model is untouched.
  - The single-operator trust model of ADR 260708-185519 still holds. Loopback dev servers are the operator's own processes; framing one is no more privileged than opening it in a browser tab on the same machine.
  - The `serve` path (local HTML files served from the DorkOS origin) keeps its opaque-origin sandbox — that is where the "untrusted local HTML could call `/api/*` as you" threat lives, and nothing here weakens it.
  - The DevTools relay (DOR-213: console/network/screenshot for the agent) is a feature worth keeping for dev-server previews.
- **Out of scope:**
  - Rewriting HTML/JS/CSS URLs inside the proxy (fragile; can't fix `history.pushState`, `fetch('/api')`, HMR sockets — see §5).
  - Previews through an ngrok/tunnel origin (the preview listener port is not exposed by a tunnel; we say so honestly instead of showing a blank frame).
  - Docker/remote dev servers (the proxy is loopback-pinned by design).

## 2) Pre-reading Log

- `decisions/260708-185519-local-html-serving-origin-isolation.md` — the opaque-origin decision this spec amends for the proxy half.
- `specs/right-panel-workbench/` (D6 sandbox posture), DOR-213 DevTools bridge (`services/workbench-serve/devtools-shim.ts`, `features/canvas/model/use-devtools-bridge.ts`).
- `apps/server/src/services/workbench-serve/{proxy,token,devtools-inject}.ts`, `routes/workbench-serve.ts`, `services/core/auth/session-gate.ts` (gate exemptions for `/api/workbench/{serve,proxy}/`), `app.ts` CORS delegate + `lib/trusted-origins.ts`.
- `docs/guides/workbench.mdx` §"Embedded Browser" — currently claims "localhost dev servers render right in the canvas". False today; the demo-claim gate (`meta/positioning-202607/09-gtm-plan.md` §2.0) says never claim an unverified surface works.
- Live reproduction (headless Chromium, 2026-08-16) — evidence in §3.

## 3) Root cause (verified, not inferred)

Reproduced with Playwright against the running cockpit (`localhost:4242`) and the video app (`localhost:5178`):

1. **Path-prefixed proxy loses root-absolute URLs.** The canvas frames `http://localhost:4242/api/workbench/proxy/<token>/`. The app's HTML loads (title "Video pipeline"), but its scripts are `/@vite/client` and `/src/main.tsx`. Inside the frame those resolve to `http://localhost:4242/src/main.tsx` — DorkOS's own SPA fallback answers 200 with the cockpit HTML. Every Vite/Next/CRA app, and every SPA router (`BrowserRouter` sees `/api/workbench/proxy/<token>/` as its path), breaks the same way. Vite's transformed modules also import `/node_modules/.vite/deps/*` root-absolute, so rewriting the HTML alone can't save it.
2. **Opaque origin breaks ES-module loads even without the proxy.** Framing `http://localhost:5178/` directly with `WORKBENCH_SANDBOX_ISOLATED` (no `allow-same-origin`): `#root` stays empty; console shows `Access to script … from origin 'null' has been blocked by CORS policy`. Module scripts are CORS-fetched; from a null origin Vite (and our proxy) send no `Access-Control-Allow-Origin`.
3. **Direct framing with the EXTERNAL sandbox works.** Same URL, `WORKBENCH_SANDBOX_EXTERNAL`: the app renders ("3 projects across 2 brands…"), HMR connects. Vite sets no `X-Frame-Options`; DorkOS's CORS delegate does not allow a `localhost:<other-port>` origin, so the framed page cannot read `/api/*`.
4. **The user sees nothing.** `CanvasBrowserContent` shows "Loading…" then a white frame. The parent gets `load` for a 200 HTML document and has no signal that the page is dead. The injected DevTools shim did relay the CORS errors to the session buffer — but no UI surfaces them in the canvas.

Verdict: **the app is fine; the canvas is wrong**, twice over. Static HTML with relative assets is the only thing the proxy path handles today.

## 4) What the user needs

- Kai starts a dev server, tells the agent "open it in the canvas", and sees the app — same as a browser tab, HMR included. From the phone (cockpit at `machine.tail.ts.net:4242`), the same request also works, because DorkOS is the machine that can reach `127.0.0.1:5178`.
- When it can't work, the canvas says **why** in one plain sentence and offers the way out ("Nothing is listening on localhost:5178", "This page hit errors while loading — Open in system browser", "Dev-server previews aren't available through a tunnel — open DorkOS on the machine that runs it").
- The agent keeps its eyes: console, failed requests, screenshot for the framed preview.

## 5) Options considered

| Option                                                                                                                                                                                                | Verdict                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Rewrite URLs in the proxy** (`src="/…"`, `import "/…"`, `url(/…)`, JS string literals)                                                                                                           | Rejected. Runtime-built URLs (`fetch('/api')`, `new URL('/x', import.meta.url)`), SPA routers, HMR websocket paths and workers all escape. Every proxy that tried this (Jupyter's `/proxy/`, code-server) needs per-app config.                                                                 |
| **B. Host-based origins on the same port** (`http://5178.localhost:4242/`)                                                                                                                            | Rejected as primary. Chrome/Firefox resolve `*.localhost` natively; Safari does not, and it cannot work for a `machine.tail.ts.net` cockpit.                                                                                                                                                    |
| **C. Frame `http://localhost:<port>/` directly** with the external sandbox                                                                                                                            | **Phase 1.** Zero server work, works today on a loopback cockpit. Cannot work when the cockpit is viewed from another device (the phone's `localhost` is the phone). No shim → no console relay.                                                                                                |
| **D. One dedicated origin per proxied target — an ephemeral listener port on the DorkOS host**, bound like the main server, cookie-authorized by the signed token, WS upgrades proxied, shim injected | **Phase 2 (the proper fix).** Root-absolute paths, SPA routers and HMR all just work because the frame's origin root _is_ the app root. Works from any device that reaches the DorkOS host (LAN, Tailscale). This is how CodeSandbox / Codespaces / StackBlitz do it (`<port>-<id>.preview.*`). |
| **E. Keep opaque origin + add `Access-Control-Allow-Origin: *` on the proxy**                                                                                                                         | Fixes only break #2, not #1. Insufficient alone; irrelevant once D gives the frame a real origin.                                                                                                                                                                                               |

## 6) Decisions

- **D1 — Both C and D ship; C first.** C unblocks today and stays as the fallback path; D becomes the primary source for every loopback target once it lands (uniform: agents get the console relay, remote cockpits work). Recorded in `02-specification.md` §2.
- **D2 — Loopback dev servers get `allow-same-origin` (a real origin); the local-file `serve` path keeps the opaque origin.** ADR 260708-185519 is amended, not superseded: its threat model was untrusted _local HTML on the DorkOS origin_; a dev server framed on its own origin (a different port from the cockpit) is cross-origin to `/api/*` and no more privileged than the same server open in a tab. The amendment lands in **two steps**, because the posture changes in two: **P1** adds a dated note to that ADR's Status (direct frames only), and **P2** brings the new ADR for the per-target preview origin.
- **D3 — The path-prefixed `/api/workbench/proxy/:token/*` route is retired in Phase 2.** It never worked for real apps and would be dead code beside the listener. Its gate exemption goes with it.
- **D4 — Honesty over guessing.** The canvas never shows a blank frame for a failure it can detect: no upstream on the port, load errors reported by the shim, tunnel-origin cockpit. What it cannot detect (an external site refusing to be framed) keeps the existing always-on "Open in system browser" escape hatch.
- **D5 — A test that would have failed on the old code.** An e2e boots a Vite-style static server (root-absolute `<script type="module">`, a `BrowserRouter`-style deep path) and asserts the frame renders — plus the "nothing listening" message for a dead port.
- **D6 — Docs tell the truth at each phase.** After P1: "renders on the machine running DorkOS; through a tunnel/other device you'll be offered Open in system browser." After P2: the remote story is true and the docs say so; tunnel stays an honest exception.
