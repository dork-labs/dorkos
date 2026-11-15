---
title: 'Agent browser: keep building, adopt, or package?'
date: 2026-11-13
type: internal-architecture
status: active
tags: [agent-browser, playwright, build-vs-adopt, tab-per-chat, local-first, bot-walls, browser]
---

# Agent browser: keep building, adopt, or package?

Date: 2026-11-13. Asked by Dorian (via PM). Author: DorkOS PM (build-vs-adopt spin-off). Evidence: current source of 21 outside projects (shallow clones taken 2026-11-10…13), and DorkOS `origin/main` at 9fb500adec (Nov 13). Nothing was installed or run.

**Decision (PM, 2026-11-13): path A.** Keep ours, borrow patterns, retire the managed engine (DOR-4284). The tab-per-chat design is DOR-4273; its spec is [`specs/agent-browser-tab-per-chat/`](../specs/agent-browser-tab-per-chat/02-specification.md).

## Summary (2-minute read)

1. **Recommendation: keep ours and borrow. Don't switch. Retire the parked managed-browser engine. Don't package yet.**
2. We already adopted the industry engine: the live Agent browser is a thin layer (~6.2k product lines) on **playwright-core**, the same engine OpenClaw, Playwright MCP, Playwright CLI and Skyvern use. **The main cost of switching isn't the driver; it's our safety rules.** They live in our service layer, not in Playwright: refusing stale pages by revision, refusing DorkOS and Cloud pages, person handoff, audit lines, outsider holds and profile grants. Every alternative would either have to sit under that layer or rebuild each rule. None of them has equals for these rules.
3. **No outside project meets our needs as a whole.** The closest, OpenClaw (MIT), is a 65k-line plugin tied to its own SDK. Everything else is Python, a Rust binary, AGPL, VM-per-browser, or brings its own browser and can't drive our Electron panel.
4. **Scored on Dorian's local-first rule (§4b), the tab-per-chat model wins.** One signed-in browser with a tab per chat costs a tab for each extra agent. A browser per agent costs a whole Chrome (agent-browser, Playwright CLI, Steel, browser-use, Stagehand, Hermes). A VM per agent costs about 8 GB (Kernel). Our own prototype found no room for even a third browser on a loaded Mac. DOR-4273 is the tab-per-chat plan, the same model as OpenClaw, BrowserOS and nanobrowser.
5. **The sunk cost is real, but it isn't the live browser.** It's the parked managed engine in `packages/browser` + `services/browser`: ~42k product lines plus ~54k test lines. It is macOS-only, headless Chrome for Testing, and wired into nothing. Stop it and delete it after launch.
6. **What we can borrow for DOR-4273**, all permissive licences:
   - OpenClaw's per-session tab ownership (`session-tab-*`, ~2.4k lines) and its takeover lock (`operator-control.ts`);
   - nanobrowser's per-chat tab binding and per-tab lock;
   - agent-browser's `tab_locked` / `tab_gone` errors;
   - Chrome DevTools MCP's per-page action queue.
7. **For DOR-2667 (watching a page that runs on a server, e.g. a cloud agent computer):** stream the live browser's page with screencast and send input back. Reuse our own tested prototype viewer (`scripts/browser-control-prototype/viewer*.mjs`: latest frame only, receipt after paint, local p95 under 250 ms) with Steel's fan-out pattern. Don't use the rest of the managed engine. Don't use WebRTC (Kernel/neko), which needs a UDP port that our tunnel doesn't carry.
8. **Bot walls:** every tool that "gets past" them does it with paid cloud stealth, residential proxies or captcha solvers. That is evasion, which we ruled out on Nov 11. The honest best is real Chrome, headed, with no debugger attached while the person signs in. We ship that already (DOR-4178). **Data-center IPs are the cloud gap.** A cloud agent computer's address is flagged before any browser signal is checked. The honest options are the person taking over through the stream, or the person's own network or Chrome. A "use my own Chrome" extension mode is a Could.
9. **Effect on dates:**
   - Nov 17 launch: none.
   - DOR-4273: start on Nov 18 as planned; still 3–4 build days, with less design risk.
   - Switching instead: about 3–5 weeks of rework, and it would put the shipped launch Musts at risk.
10. **Package later** as a host-agnostic "tab broker" (ownership, takeover lease, per-tab queue, audit, URL policy over a Playwright `Page`). Keep that boundary inside DOR-4273's code now; publish only after the API holds steady for two releases.

---

## 1. The question and the constraints

Dorian asked whether we should keep building our own Agent browser, switch to an existing tool, or spin ours out as a package, and to judge it on merit, not sunk cost.

**Needs (from the brief):**

- a page the person sees in the app panel or its own window;
- person takeover for sign-in and 2FA;
- saved sign-ins kept apart from everyday Chrome;
- parallel agents, one page per chat, with ownership enforced by the server;
- outsider-content holds and site allow/block lists;
- a per-page audit;
- works on a hosted server with no local Chrome;
- gets past bot walls.

**Hard constraints** (Dorian, Nov 13):

- local-first: the browser layer runs wherever DorkOS runs, as a local library or process;
- no VM or container per browser, because of resource cost;
- in the cloud, an agent gets its own computer with DorkOS inside, using that computer's browser;
- hosted browser services are a fallback only;
- scored: memory per extra parallel agent (tab, browser or VM), how a page running on a server is shown, and data-center IP bot walls (§4b).

**Code's point:** the switching cost is our safety layer, not the driver (§7).

**Earlier context also read:**

- `specs/local-playwright-browser/01-ideation.md`: Playwright chosen for v1; embedded view plus own window; VM and streaming out of v1 scope.
- `specs/agent-browser-sessions/*`: the Layer 1 storage-state and Playwright MCP preset.
- `specs/shared-browser-control/06-production-specification.md`: the managed engine's frozen contract.
- `research/20261006_agent-linux-desktop.md`: one Linux box per agent, with Playwright MCP attached to the in-box Chromium. Under Dorian's Nov 13 rule, the cloud computer should run **the same Agent browser layer** instead, so that every safety rule applies there too.

**Standing decisions:**

- no stealth or fingerprint evasion (Nov 11);
- server-enforced chat ownership, person-held page untouchable, per-page audit by origin, per-page rules (Security's Musts for DOR-4273).

## 2. What we actually have (main, Nov 13)

| Stack                                                                                                                    | Status                                                                                                                                       | Product / test lines | What it is                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent browser** (`apps/server/src/services/session/local-browser`, `apps/desktop/src/main/local-browser`)              | **Live**, the `local_browser_*` tools                                                                                                        | ~5.2k / ~6.8k        | playwright-core `1.65.0-alpha-2026-10-30`. The panel is an Electron `WebContentsView` driven over `webContents.debugger`. The own window is installed Google Chrome via `launchPersistentContext` (pinned Chromium 157 as fallback). Tools: state, observe (aria snapshot), screenshot, act (role+name, revision-fenced), ask_person. |
| Signed-in browser, Layer 1 (`packages/cli/src/lib/agent-browser`, `packages/shared/src/agent-browser.ts`)                | Live, older                                                                                                                                  | ~1.0k / ~0.9k        | `dorkos browser login` saves storage state; a pinned Playwright MCP 0.0.82 preset starts from it.                                                                                                                                                                                                                                     |
| **Managed browser engine** (`packages/browser`, `apps/server/src/services/browser`, `scripts/browser-control-prototype`) | **Parked**: nothing in the server imports it; specs say "prototype" / "proposed"; the egress broker README says app startup doesn't mount it | **~42k / ~54k**      | Headless Chrome for Testing 153. It includes a supervisor, crash custody, a native macOS observer written in C, a ~5k-line hash-verified installer and a ~3.5k-line egress proxy. macOS only.                                                                                                                                         |

Status of the live Agent browser against each need:

- **Done:** page visible (panel + window); takeover (`ask_person`, which detaches the debugger, or relaunches plain Chrome and hands back); separate saved sign-ins with person-granted, signed profile grants, Forget and Delete.
- **Partial:** outsider holds (handoff refused in outsider turns; agents blocked from DorkOS and Cloud origins; no per-site lists); audit (append-only `actions.jsonl`, no viewer); bot walls (real Chrome, no `--enable-automation`, Chrome UA in the panel).
- **Missing:** parallel chats (one holder per install; other chats get `not_shared`); hosted with no display.

## 3. The landscape, from the code

| Project                                                           | Stars / last release       | Licence            | Drives with                                                                             | Parallel agents                                                                                                                         | Takeover                                                 | Shows page                                               | Bot walls                                                    | Embeddable in our Node app?                                              |
| ----------------------------------------------------------------- | -------------------------- | ------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **OpenClaw**                                                      | 394k / v2026.11.3 (Nov 10) | MIT                | playwright-core 1.64 over CDP; aria refs                                                | **One browser per profile, tabs per session**; ownership by session key + target id, kept in SQLite, filtered tab lists, cleanup claims | **"Take control" lock**, 5-min idle release              | CDP screencast to its UI panel; headed window; extension | Honest: installed Chrome, headed                             | No: plugin-SDK bound; copy files                                         |
| **Hermes Agent** (Nous)                                           | 263k / v0.23.1 (Nov 10)    | MIT                | browser-harness (raw CDP), model writes Python                                          | One Chromium per task by default                                                                                                        | Lease + noVNC "Bot Desktop", **Linux only**              | noVNC / headed                                           | Real-profile Chrome; evasion via Browserbase/Camofox         | No (Python)                                                              |
| **DeepSeek Harness** (`deepseek-ai/deepseek-harness`)             | 280k / no releases         | MIT                | **Delegates** to Playwright MCP, chrome-devtools-mcp or Stagehand (~1.2k lines of glue) | One browser per session; attach = exclusive lock                                                                                        | None                                                     | None                                                     | None                                                         | Nothing to embed                                                         |
| **DeepSeek Super Agent** (`deepseek-ai/dsh-superagent-prototype`) | 23k / Oct 31               | MIT                | No browser of its own                                                                   | n/a                                                                                                                                     | n/a                                                      | n/a                                                      | n/a                                                          | n/a                                                                      |
| **Buzz** (`block/buzz`)                                           | 37k / desktop v0.5.28      | Apache-2.0         | No browser; agents bring their own MCP                                                  | n/a                                                                                                                                     | n/a                                                      | n/a                                                      | n/a                                                          | n/a                                                                      |
| dsh-browser-agent (community DSH plugin)                          | 1                          | ISC                | puppeteer-core                                                                          | One shared tab                                                                                                                          | **Pane input relay; page reads denied during sign-in**   | CDP screencast → SSE pane                                | Mild evasion in "stealth" mode                               | Small modules, yes                                                       |
| terminal-browser (zenbu)                                          | 4.6k                       | MIT                | Wraps agent-browser                                                                     | Visual marker only                                                                                                                      | Person always in control                                 | Electron offscreen rendering, patched Electron           | None                                                         | Terminal-only library                                                    |
| **browser-use** 1.0.3                                             | 121k / Nov 12              | MIT                | Raw CDP via browser-harness; **no Playwright**                                          | One Chrome + daemon per agent                                                                                                           | Cloud live view only                                     | Headed / cloud                                           | **Cloud-only** stealth, residential proxy, captcha           | No (Python)                                                              |
| browser-harness                                                   | 19k                        | MIT                | Raw CDP                                                                                 | Agents "take turns"                                                                                                                     | None                                                     | Person's Chrome                                          | Person's Chrome; AppleScript clicks the debug-consent prompt | No (Python)                                                              |
| **Stagehand** 4.4                                                 | 26k / Oct 23               | MIT                | Own CDP layer **inside a Chrome extension** (v4)                                        | One instance per browser; no tab ownership                                                                                              | Headed only                                              | Headed / Browserbase                                     | Browserbase-only stealth                                     | Yes, but needs Chrome's `Extensions.*` CDP domain, so likely no Electron |
| **agent-browser** (Vercel) 0.43                                   | 51k / Nov 12               | Apache-2.0         | Rust, raw CDP; AX refs `@e1`                                                            | Daemon + Chrome per session; `--pin-tab` advisory file lock                                                                             | Stream accepts input; no handoff state                   | WebSocket screencast + dashboard                         | Chrome for Testing headless; evasion via plugins             | No: Rust binary or MCP                                                   |
| **Playwright MCP** 0.0.85                                         | 40k / Nov 9                | Apache-2.0         | Playwright; aria refs                                                                   | Browser per client, or `--isolated` contexts; shared mode = **no tab ownership**                                                        | `--extension` into your Chrome; dashboard input          | Headed / dashboard                                       | Installed Chrome; `AutomationControlled` off (mild)          | `createConnection()`, but brings its own browser                         |
| Playwright CLI                                                    | 15k                        | Apache-2.0         | Playwright                                                                              | Daemon + browser per session                                                                                                            | **`show` dashboard: click to take over, Esc to release** | Screencast dashboard                                     | Honest                                                       | No (CLI; internals private)                                              |
| **Chrome DevTools MCP** 1.13                                      | 55k / Nov 11               | Apache-2.0         | Puppeteer 25                                                                            | `pageId` routing + **per-page task queue**, no ownership                                                                                | `--autoConnect` to your Chrome                           | Headed                                                   | Real Chrome                                                  | `createMcpServer()`; **telemetry on by default**                         |
| **Steel** 0.5.5                                                   | 8k / Oct 31                | Apache-2.0         | puppeteer-core                                                                          | **One session per server process**                                                                                                      | Viewer input over WebSocket                              | **Screencast fan-out with backpressure**                 | Fingerprint spoofing (evasion)                               | No (server)                                                              |
| Skyvern 1.0.57                                                    | 23k / Nov 6                | **AGPL-3.0**       | Playwright + vision                                                                     | Browser per run; extension mode = **tab leases** (`LEASE_HELD`)                                                                         | take-control / cede-control                              | Screencast, VNC                                          | Cloud solver; patchright                                     | No (AGPL, Python)                                                        |
| Kernel images                                                     | 1.1k                       | Apache-2.0         | Bring your own CDP client                                                               | **One VM/container per browser, 8 GB**                                                                                                  | WebRTC (neko)                                            | Full-desktop WebRTC                                      | Humanised mouse                                              | No; breaks the constraint                                                |
| nanobrowser 0.3                                                   | 14k / Oct 15               | Apache-2.0         | puppeteer-core over `chrome.debugger` (extension)                                       | **Tab ↔ conversation binding**, coloured tab groups, per-tab lock                                                                       | `ask_user` in the person's own Chrome                    | Person's Chrome                                          | Honest; no webdriver flag without a debug port               | Core is host-agnostic behind `ports.ts`                                  |
| BrowserOS                                                         | 14k                        | **AGPL-3.0** + CLA | Rust CDP against a **patched Chromium**                                                 | Tab group per chat; **ownership is a label, by design**                                                                                 | request/await human help                                 | Person's browser + screencast                            | Honest                                                       | No (AGPL, Rust, fork-only CDP)                                           |
| Lightpanda                                                        | 42k                        | **AGPL-3.0**       | Its own Zig engine                                                                      | 1 context per connection                                                                                                                | n/a                                                      | **No real rendering**                                    | n/a                                                          | Separate binary only                                                     |

Name choices: "DeepSeek Harness" = `deepseek-ai/deepseek-harness` (official, 280k stars). "DeepSeek Super Agent" = `deepseek-ai/dsh-superagent-prototype` (DeepSeek's Oct 31 research prototype, a DSH plugin for coding agents). "Buzz" = `block/buzz` (Block's humans-and-agents workspace, the closest product analogue to DorkOS). Neither DeepSeek repo nor Buzz has a browser of its own, so I also read the community DSH browser plugin and the engine it forked.

## 4. Need by need

| Need                                                | Ours today                                                                                      | Best elsewhere                                                                                                                                                                                                                                                                                                                                                | Verdict                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Page the person sees (panel or window)              | **Done.** A real page in the panel, not a stream, plus a real Chrome window                     | No one embeds a live, drivable page in an app panel. Others use a headed window, a screencast, or VNC. terminal-browser streams Electron offscreen                                                                                                                                                                                                            | **Unique to us.** Keep                                                                                                      |
| Takeover for sign-in / 2FA                          | **Done.** `ask_person`, debugger detached, plain Chrome, hand-back wakes the chat               | OpenClaw's take-control lock; Skyvern take/cede; Hermes's fail-closed lease; dsh "deny page reads during sign-in"                                                                                                                                                                                                                                             | Ours is on par or ahead for the local case. **Borrow** OpenClaw's idle release and dsh's read-deny                          |
| Saved sign-ins apart from everyday Chrome           | **Done.** Named profiles, person-granted signed grants, Forget/Delete, password saving off      | Hermes copies the real profile; browser-use and agent-browser copy a profile read-only; OpenClaw imports cookies                                                                                                                                                                                                                                              | **Ours is stronger** (consent + grant model). A "copy my Chrome profile" helper is a later Could                            |
| Parallel agents, one page per chat, server-enforced | **Missing** (one holder per install)                                                            | OpenClaw's session-tab registry (closest, enforced at its gateway); nanobrowser bindings; Skyvern leases (AGPL, design only); agent-browser `--pin-tab` (advisory)                                                                                                                                                                                            | **Covered better elsewhere today. Borrow OpenClaw + nanobrowser for DOR-4273**                                              |
| Outsider holds + site allow/block                   | **Partial.** Outsider-turn hold on handoff; DorkOS/Cloud origins blocked                        | agent-browser's `--allowed-domains` + action policy + confirm; OpenClaw `navigation-guard.ts` (SSRF, DNS pin, redirects); browser-use `domains.py`; BrowserOS nonce fencing                                                                                                                                                                                   | Outsider-content tracking tied to chat trust is **unique to us**. **Borrow** OpenClaw's navigation guard for per-page rules |
| Per-page audit                                      | **Partial.** `actions.jsonl`, no viewer                                                         | BrowserOS audit observer; Kernel's CDP-proxy observer; nanobrowser redacted audit                                                                                                                                                                                                                                                                             | Small gap. Wire ours into the DorkOS audit trail rather than borrowing                                                      |
| Hosted, no local Chrome                             | **Missing**                                                                                     | Under Dorian's rule, "hosted" = DorkOS on the agent's own computer. The pattern is headless Chrome + screencast + input (Steel, dsh pane, OpenClaw). Kernel/Steel/Browserbase need VMs or the cloud                                                                                                                                                           | **Borrow** the screencast-plus-input viewer. That is what DOR-2667 should become                                            |
| Bot walls                                           | **Partial, honest.** Real Chrome, headed, no `--enable-automation`, debugger off during sign-in | Everyone who claims more uses **cloud stealth, residential proxies, captcha solvers or fingerprint spoofing** (browser-use cloud, Browserbase, Steel, Skyvern cloud, agent-browser plugins). Honest extra: an extension driving `chrome.debugger` doesn't set `navigator.webdriver` (nanobrowser asserts this; Playwright and OpenClaw ship extension relays) | **No one beats us honestly.** Next lever: "use my own Chrome" extension mode, a Could after DOR-4273                        |
| Memory per extra agent                              | Plan: tabs in one browser                                                                       | Browser-per-agent tools (agent-browser, Playwright CLI, Steel, browser-use, Stagehand, Hermes default) add a whole Chrome per agent; Kernel adds an 8 GB VM. Tab-per-chat tools (OpenClaw, BrowserOS, nanobrowser) add a tab                                                                                                                                  | **Our plan is the right shape.** No project publishes per-tab numbers, so DOR-4273 should measure RSS at 1/3/5 chats        |

## 4b. Scored on the local-first constraint (Dorian, Nov 13)

The browser layer must run wherever DorkOS runs, as a local library or process. Mainly that's the person's own computer. In the cloud it's the agent's own computer with DorkOS inside, using that computer's browser. Hosted browser services are a fallback, not the base.

Scores: ●●● good, ●● workable, ● poor, ✕ fails.

| Option                                 | Runs where DorkOS runs                           | Memory per extra parallel agent                                                      | Viewing a page that runs on a server                                                                            | Data-center IP bot walls                                                                  | Keeps our safety layer                                        |
| -------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Ours + DOR-4273**                    | ●●● Node library in our server                   | ●●● **one tab** in one signed-in browser                                             | ●● after DOR-2667: screencast + input over DorkOS's HTTP/tunnel; our prototype viewer passed local p95 < 250 ms | ● on its own; honest fallbacks are handoff through the stream or the person's own network | ●●● it _is_ the layer                                         |
| OpenClaw (copy files)                  | ●●● Node                                         | ●●● one tab                                                                          | ●●● screencast to its panel; noVNC sandbox                                                                      | ● same; no evasion                                                                        | ●● has its own equivalents to merge with ours                 |
| Playwright MCP                         | ●●● Node                                         | ●● one context in a shared browser (`--isolated`); one browser per client by default | ● local dashboard only                                                                                          | ●                                                                                         | ✕ sits beside our layer, not under it; brings its own browser |
| Chrome DevTools MCP                    | ●●● Node                                         | ●● isolated context                                                                  | ✕ headed window only                                                                                            | ●                                                                                         | ✕                                                             |
| agent-browser                          | ●● Rust sidecar binary                           | ● **one browser + daemon** per session (tab only when attached via `--cdp`)          | ●● WebSocket screencast + input, loopback only                                                                  | ● plugins for evasion                                                                     | ✕ replaces it                                                 |
| Playwright CLI                         | ●● CLI daemon                                    | ● one browser per session                                                            | ● local dashboard                                                                                               | ●                                                                                         | ✕                                                             |
| Stagehand v4                           | ●● Node, but needs Chrome's extension CDP domain | ● one browser per launch                                                             | ✕ local headed / Browserbase link                                                                               | Browserbase stealth (hosted)                                                              | ✕                                                             |
| browser-use / browser-harness / Hermes | ✕ Python                                         | ● one browser per agent (shared-Chrome mode "takes turns")                           | Hosted live-view URL, or noVNC on Linux (Hermes)                                                                | Hosted stealth + residential proxies                                                      | ✕                                                             |
| Steel                                  | ●● separate Node server                          | ● one browser + server per session                                                   | ●●● screencast fan-out with backpressure                                                                        | Fingerprint spoofing (evasion)                                                            | ✕                                                             |
| Skyvern                                | ✕ Python + DB + worker, AGPL                     | ● one browser per run                                                                | ●● screencast / VNC                                                                                             | Hosted solver                                                                             | ✕                                                             |
| Kernel images                          | ✕ container/VM only                              | ✕ **one VM per browser, ~8 GB**                                                      | ●● WebRTC, needs UDP (poor through our tunnel)                                                                  | ●                                                                                         | ✕                                                             |
| BrowserOS                              | ✕ patched Chromium + Rust, AGPL                  | ●●● tab group per chat                                                               | ●● MJPEG screencast; hosted Xvnc                                                                                | ●                                                                                         | ✕                                                             |
| Lightpanda                             | ●● separate binary, AGPL                         | ●●● very light, but no real rendering                                                | ✕ nothing to show                                                                                               | n/a                                                                                       | ✕                                                             |

**Memory, the evidence we have:**

- No project publishes per-tab numbers.
- Our own managed-engine prototype measured two browsers plus two viewer pages on a loaded Mac. Its pressure calculation recommended **zero more slots** (`specs/shared-browser-control/05-prototype-evidence.md`).
- Kernel asks for 8 GB per browser VM.

That is why DOR-4273 should measure RSS at 1, 3 and 5 chats as an acceptance check.

**Viewing a page on a server:**

- The Electron panel only exists in the desktop app. A cloud agent computer runs the browser on its own display, real or virtual, so the person needs a stream either way.
- Two forms work through DorkOS's existing HTTP proxy and tunnel:
  - a page-level CDP screencast plus input (Steel, OpenClaw, agent-browser, our prototype);
  - a whole-desktop stream (Selkies or noVNC, per `research/20261006_agent-linux-desktop.md`).
- WebRTC (Kernel, neko) needs a UDP or TCP mux port, so it's a poor fit for the tunnel.
- Page-level screencast is the smaller step and keeps the agent's input on one page.

**Data-center IPs:**

- **Not measured** in this review; this is reasoning from how bot walls score traffic.
- Akamai- and Cloudflare-style walls weigh the network address's reputation alongside browser signals. A cloud agent computer will be challenged more than the person's laptop, however honest the browser.
- **Every product that claims to beat this rents residential proxies or solves captchas in its cloud.** Our Nov 11 decision rules both out.
- The honest options, best first:
  1. The person takes over through the stream for the challenge or sign-in.
  2. An opt-in route out through the person's own computer or network.
  3. "Use my own Chrome" on the person's machine.
- Option 2 needs a Security ruling before anyone designs it.

## 5. What to borrow

All of these licences permit copying with attribution (MIT, Apache-2.0 with NOTICE, ISC). AGPL projects (Skyvern, BrowserOS, Lightpanda) are **design only, never code**.

**For DOR-4273 (per-chat tabs, own window first):**

| Borrow                                                                                                                                                                                                 | From                     | Licence             | Why                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/browser/src/browser/session-tab-{registry,store,tracking,identity,cleanup-claim}.ts` (~2.4k lines), `src/browser-tool-session-tabs.ts`, the tab filter in `src/gateway/browser-request.ts` | OpenClaw                 | MIT                 | Ownership by session key + target id, kept across restarts, list filtering, close-only-if-owner, per-session tab cap, idle cleanup. Swap their session key for our **server-stamped chat id** |
| `operator-control.ts` (191 lines)                                                                                                                                                                      | OpenClaw                 | MIT                 | Person-holds-the-page lock: refuses agent input at one route boundary, observation stays, releases on idle/disconnect. Matches Security's "person-held page untouchable"                      |
| `src/extension/bindings.ts` (302 lines), `src/browser-control/core/lock.ts`                                                                                                                            | nanobrowser              | Apache-2.0          | Tab ↔ chat binding, "move this tab to that chat only with the person's OK", popups join the opener's chat, per-tab action serialisation                                                       |
| `tab_locked` / `tab_gone` error semantics (`cli/src/native/tab_binding.rs`)                                                                                                                            | agent-browser            | Apache-2.0 (design) | Clear agent-facing errors for "someone else's tab" and "your tab closed"                                                                                                                      |
| Per-page task queue (`src/ToolHandler.ts`, `McpContext.ts`)                                                                                                                                            | Chrome DevTools MCP      | Apache-2.0          | Serialise actions per page so two chats never interleave on one tab                                                                                                                           |
| `navigation-guard.ts`                                                                                                                                                                                  | OpenClaw                 | MIT                 | Per-page allow/block, SSRF, redirect-chain and DNS-pin checks                                                                                                                                 |
| `LEASE_HELD` / `LEASE_REQUIRED`; popups follow the opener                                                                                                                                              | Skyvern extension broker | AGPL (design only)  | Confirms the error model above                                                                                                                                                                |

**BrowserOS deliberately removed enforced ownership**, and DOR-4273's design must answer its two reasons (`page_ownership_notice.rs`):

- **"The person's tabs became unreachable."** In DorkOS the person drives through the UI, not the agent tools. Unowned tabs stay the person's, and a person can give a tab to a chat.
- **"A lost session handle orphaned the agent's pages."** Our key is the chat id, which DorkOS stamps on the server, not a protocol session handle. Add an "adopt my orphaned tab" path anyway for a chat that restarts.

**For DOR-2667 (watching the page on the web, phone or a hosted server), rebased on the live Agent browser:**

- **Our own prototype viewer** (`scripts/browser-control-prototype/viewer.mjs`, `viewer-client.mjs`, `viewer-pointer.mjs`, `manager-input.mjs`, ~1.7k lines). It keeps one pending frame at most, acknowledges only after paint, and refuses missing or replayed receipts. Measured local input-to-drawn p95 was 163–217 ms, and it passed the 600 ms target with 150 ms of added round-trip delay on the second run (`05-prototype-evidence.md`). It is the one part of the managed programme worth keeping; port it from the prototype onto the live service.
- **Steel** `api/src/plugins/browser-socket/page-screencast.ts` + `casting.handler.ts` (Apache): one screencast fanned out to many viewers, with per-viewer backpressure, ack throttling and input forwarding.
- **dsh-browser-agent** `src/pane.ts` + `src/login-mode.ts` (ISC): screencast pushed to a pane over SSE, starting on the first viewer and stopping on the last; mouse, key and wheel relay; page reads denied while the person types credentials.
- **Playwright CLI** `show` dashboard: the interaction to copy (live grid; click to take over; Esc to release).
- **terminal-browser** Electron offscreen rendering: the option for streaming the panel's `WebContentsView` itself, if the screencast quality isn't enough.

**Also worth taking:**

- BrowserOS nonce-fenced page text (design) and OpenClaw `wrapExternalContent`, for marking page text as outsider content;
- agent-browser's action policy and confirm-with-timeout flow, for payments and deletes.

## 6. What is unique to us (why not adopt)

1. **The person's live page embedded in the app panel**, driven by the agent, and the same profile in a real Chrome window. No project does both, and no adoptable library can drive an Electron `webContents`.
2. **Chat identity, trust and permissions in the browser.** Outsider-content holds, person-granted signed profile grants, Security's per-page rules, and rooms/DMs as the owners. Every other tool has either no owner concept (MCP servers, CLIs) or its own (OpenClaw sessions).
3. **Honest bot-wall posture with an in-app handoff** that detaches the debugger. Nobody else ships the debugger-off sign-in.

## 7. The options, with cost

**The main cost line is our safety layer, not the driver** (Code's point, confirmed in the code). Each rule lives in `apps/server/src/services/session/local-browser/`, not in Playwright:

| Rule                                                                                    | Where it lives                     |
| --------------------------------------------------------------------------------------- | ---------------------------------- |
| Refuse stale pages: every action carries the last observe's revision                    | `page-action.ts`                   |
| Refuse DorkOS and Cloud pages, including frames                                         | `service.ts`, `errors.ts`          |
| Person handoff: debugger detached, or plain Chrome relaunched; hand-back wakes the chat | `handover.ts`, `plain-chromium.ts` |
| Audit lines without values                                                              | `action-audit.ts`                  |
| Outsider-turn holds                                                                     | `outside-turn.ts`                  |
| Signed, person-granted profile grants                                                   | `profile-access.ts`                |

A replacement either sits _under_ these rules, giving them a Playwright `Page`, or must rebuild each one. **None of the alternatives can sit under them.** They bring their own browser, tool surface and process. So switching means rebuilding all of them, and Security re-reviewing all of them.

| Path                                                                | What it means                                                                                                                                                                 | Safety layer                                                                                                                               | Other switch cost                                                                                                                               | Nov 17 launch                                       | DOR-4273                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| **A. Keep ours + borrow + retire the managed engine** (recommended) | Stay on playwright-core; copy the files above; after launch delete `packages/browser` + `services/browser` + the prototype scripts, except the viewer files kept for DOR-2667 | **Kept as is**                                                                                                                             | ~1 day to delete the engine after launch (Security reads the diff)                                                                              | **No effect**                                       | Starts Nov 18 as planned, 3–4 build days; borrowing cuts design risk, not days |
| B. Adopt Playwright MCP underneath                                  | Run MCP's backend instead of our service                                                                                                                                      | **Rebuild all of it** around MCP tools; its "allowed origins" is documented as "not a security boundary"; shared mode has no tab ownership | Loses the Electron panel (it launches its own browser). 3–4 weeks + Security re-review                                                          | Breaks shipped Musts (DOR-4178, DOR-3112, DOR-4265) | Slips to mid-Dec or later                                                      |
| C. Adopt agent-browser (Rust sidecar)                               | Ship the binary, drive it over CLI or MCP                                                                                                                                     | **Rebuild all of it** outside a binary we don't control; its domain policy and confirm flow are good but are not ours                      | A new binary to sign and update; a browser per session (fails local-first); advisory locks; no panel. 4–5 weeks                                 | Breaks shipped Musts                                | Slips to Dec+                                                                  |
| D. Fork OpenClaw's browser plugin                                   | Lift the 65k-line plugin                                                                                                                                                      | **Merge two safety layers** (theirs: SSRF guard, take-control lock, content wrapping; ours: everything above)                              | Untangle the plugin SDK; it's a screencast, not our embedded page; we inherit their churn (41 browser changelog lines in one release). 4+ weeks | Breaks shipped Musts                                | Slips                                                                          |
| E. Package ours now                                                 | Publish an npm package                                                                                                                                                        | Kept, but its API gets frozen too early                                                                                                    | 1–2 weeks of API hardening during launch week                                                                                                   | Distracts launch                                    | Slips ~1 week                                                                  |

**Sunk-cost check:** Path A isn't sunk-cost thinking. Each alternative still needs the product layer we already have (ownership, takeover, grants, holds, audit, UI), and each breaks a constraint: local-first, Node-embeddable, Electron panel, or licence. The genuinely sunk code is the managed engine, and we should drop it. It has no users, solves problems Playwright already handles (launch, process lifetime) or that we've decided not to have (headless Chrome for Testing), and costs CI time on ~54k test lines.

## 8. If and when we package: the boundary

Build DOR-4273's broker as a directory with **no server imports**, so it can be lifted later. Publish only after two releases without breaking changes to its API (a Could, revisit mid-Dec).

**In the package (`@dorkos/agent-browser-core`):**

- the tab broker: owner ids, bind/adopt/release, popups follow the opener, idle cleanup, tab cap, persistence through an injected store;
- the takeover lease: hold, release, idle timeout, refuse agent input;
- per-tab action queue;
- observe/act on a Playwright `Page` with revision fencing and role+name targeting;
- URL policy (allow/block, scheme, private-network);
- page-text fencing;
- an audit event emitter;
- the screencast fan-out viewer protocol.

**Out of the package, staying in DorkOS:**

- chat, room and agent identity;
- permission tiers and approval cards;
- outsider-content marks (passed in as a callback);
- profile grants and Forget;
- the Electron `webContents` transport;
- the Chrome launch and theme;
- all UI.

The package would compete with free 40k–50k-star tools, so its value is the ownership and takeover model, not the engine. Treat it as a marketing and ecosystem bet, not a cost saver.

## 9. Recommended actions

| #   | Action                                                                                                                                                                                                                                                                              | Owner                             | When                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------- |
| 1   | Confirm path A; unhold DOR-4273                                                                                                                                                                                                                                                     | PM                                | Sun Nov 15                              |
| 2   | DOR-4273 design note cites the borrowed files and answers BrowserOS's two objections; adds RSS measurement at 1/3/5 chats to acceptance                                                                                                                                             | Code; Security reviews the design | Before build, Nov 18                    |
| 3   | Re-scope DOR-2667: drop the managed engine; the target is a screencast + input viewer for the live Agent browser (Steel / dsh pattern)                                                                                                                                              | PM + Code, Linear via Code        | Grooming after launch                   |
| 4   | New ticket: delete `packages/browser`, `apps/server/src/services/browser` (keep `agent-browser-guard.ts` / lint if still used) and `scripts/browser-control-prototype` (keep the viewer files for DOR-2667 until they are ported); mark the shared-browser-control specs superseded | Code; Security reads the diff     | After launch, Should                    |
| 5   | Decide whether the Playwright MCP preset (Layer 1, pinned 0.0.82) stays as an "advanced" path or retires in favour of the Agent browser                                                                                                                                             | PM with Security                  | Grooming                                |
| 6   | Could: "use my own Chrome" extension mode (borrow Playwright `cdpRelay` / OpenClaw `extension-relay`), the honest bot-wall lever                                                                                                                                                    | Backlog                           | After DOR-4273                          |
| 7   | Cloud agent computers run the same Agent browser layer, not a separate Playwright MCP-over-CDP stack as the Oct 6 research proposed; note this on the agent-computer plan                                                                                                           | PM → Cloud + Code                 | When the cloud computer work is groomed |
| 8   | Security ruling: may a cloud agent's browser route out through the person's own computer or network (opt-in) for data-center IP walls?                                                                                                                                              | Security                          | Before any design                       |

## 10. Limits of this review

- Read from code only; nothing was run. There are no memory measurements, because no project publishes per-tab numbers.
- Playwright MCP and Playwright CLI source sit inside playwright-core. MCP was read from the installed 0.0.85 bundle; the CLI dashboard claims come from its README.
- Star counts and releases are from the GitHub API, Nov 13.
- Licence notes are not legal advice. AGPL items are listed as designs only for that reason.
- Line counts are approximate (`wc -l`, excluding tests where stated).

## Addendum (2026-11-13, Security ruling on home-network routing)

Option (2), opt-in routing of a cloud agent's browser through the person's home network: **acceptable in principle**, opt-in per agent and off by default. Musts for the design:

1. Public internet only. The home relay refuses loopback, private, link-local, CGNAT, multicast, IPv6 ULA/link-local and `.local` names, checking the resolved address at connect time at the home end (stops DNS rebinding); tests for each range plus a rebinding name.
2. Plain CONNECT tunnel, TLS end to end, never decrypted; agent browser traffic only (not shell or HTTP tools, not other users).
3. Only the person's own instance can use it: mutual auth bound to account and device, revocable from either side, never a shared pool.
4. Consent card: "sites will see your home connection, and this agent's browsing will look like you". Visible on-indicator; one-click off cuts open connections.
5. Outsider holds still apply; per-agent page and bandwidth caps.
6. Audit per connection (agent, chat, origin, time, bytes). If the home machine is offline, fall back to the normal cloud route, never to anything wider.

Option (1), live-view takeover: covered by DOR-4273's handoff Must. Option (3), "use my own Chrome": riskiest, needs its own design review.
