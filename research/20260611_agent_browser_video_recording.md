---
title: 'Agent-Driven Video Recording of Browser Sessions — Capabilities by Control Surface'
date: 2026-06-11
type: external-best-practices
status: active
tags:
  [
    browser-automation,
    video-recording,
    playwright-mcp,
    claude-in-chrome,
    chrome-devtools-mcp,
    gif,
    webm,
    screencast,
    agent-recording,
  ]
---

# Agent-Driven Video Recording of Browser Sessions — Capabilities by Control Surface

**Date:** 2026-06-11
**Mode:** Focused investigation (live tool-schema inspection + web research)
**Question:** Of the ways an AI agent (e.g. Claude Code) can control a browser, which can _programmatically record video_ of what the agent did — and how is each enabled?

> **Scope note.** This file is about the **agent's browser-control surfaces and their recording capability**. For recording tooling aimed at **release notes / changelog production** (shot-scraper, VHS, Screen Studio, screenshot-as-a-service APIs), see the complementary [`20260327_screenshot_recording_tools_release_notes.md`](20260327_screenshot_recording_tools_release_notes.md). For the Playwright MCP tool surface and AI test authoring, see [`20260225_playwright_mcp_ai_test_authoring.md`](20260225_playwright_mcp_ai_test_authoring.md). For the `apps/e2e` architecture, see [`20260225_browser_testing_system.md`](20260225_browser_testing_system.md).

---

## TL;DR

- The central distinction is **"a tool that records for you"** vs **"a script you write that records."** An agent that can run code (Playwright/Puppeteer) can _always_ produce video; the "MCP video tool" question only matters when the agent is restricted to tool calls.
- **Three browser-control surfaces are available to Claude Code in this environment**, with very different recording stories:
  1. **Claude-in-Chrome** (`mcp__claude-in-chrome__gif_creator`) → **animated GIF, annotated, works today.** Per-action keyframes, not continuous video.
  2. **Playwright MCP** (`@playwright/mcp`) → **WebM video, but gated behind `--caps=devtools`**, which the official plugin does **not** enable by default. Off in the current install.
  3. **Chrome DevTools MCP** → **experimental screencast** requiring `ffmpeg` and a flag; perf traces are a screenshot filmstrip, not a playable video. Off by default.
- The **most reliable true-video path** is the **Playwright _library_** (`recordVideo` / `video:` config), which `apps/e2e` already uses (`video: 'retain-on-failure'` → WebM). No special MCP capability required.
- **GIF vs WebM:** GIF is a heavy _format_ (256 colors, no temporal compression), but `gif_creator` records **per-action keyframes**, so its size scales with _action count_, not _minutes_ — lighter than a naive continuous GIF, at the cost of being a choppy slideshow. WebM (VP9/H.264) is smooth, full-color, and an order of magnitude smaller per minute, but carries no annotations.

---

## 1. The framing that matters: tool-that-records vs script-that-records

|                           | Tool-that-records                                                       | Script-that-records                                                               |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Mechanism                 | Agent calls a dedicated MCP tool (`gif_creator`, `browser_start_video`) | Agent writes & runs a Playwright/Puppeteer script with recording enabled          |
| Requires                  | The MCP server to expose the capability                                 | The framework dependency to be present (it is — `@playwright/test` in `apps/e2e`) |
| Reliability               | Depends on server config                                                | Highest; full control over codec, fps, size                                       |
| When it's the only option | Agent is sandboxed to tool calls                                        | n/a                                                                               |

Practical implication: if an agent can author and execute code, recording is essentially solved via Playwright. The MCP-tool question is about convenience and about agents that cannot run arbitrary code.

---

## 2. Control surface A — Claude-in-Chrome `gif_creator` (works today)

- **Tool:** `mcp__claude-in-chrome__gif_creator` with actions `start_recording`, `stop_recording`, `export`, `clear`.
- **Output:** **animated GIF**, with optional overlays: click indicators (orange rings), drag paths (red arrows), action labels, progress bar, Claude watermark. `quality` 1–30 (default 10). `download: true` to save.
- **Capture model:** **per-action keyframes**, not continuous video. The tool captures a frame around each browser action (click/scroll/navigation), plus an explicit screenshot at start (first frame) and before stop (last frame). Scoped to the tab group.
- **Status in this environment:** **available and ready now** — no configuration required.
- **Strengths:** annotated, agent-native, zero setup, file size bounded by _number of actions_ rather than duration.
- **Limits:** GIF only (256-color palette, no audio), choppy "slideshow" motion, not a smooth recording.

**Best for:** an annotated highlight reel of an agent's discrete steps, available immediately.

---

## 3. Control surface B — Playwright MCP video (capable, but disabled by default)

- **Tools (when enabled):** `browser_start_video`, `browser_stop_video`, `browser_video_chapter` (chapter markers with title/description).
- **Output:** **WebM** (e.g. `Video saved to: /output/login-flow.webm`).
- **Gate:** lives behind the optional **`devtools` capability**. Enable via **`--caps=devtools`** in the server args, or auto-record every session with env var **`PLAYWRIGHT_MCP_SAVE_VIDEO=1280x720`** (a `WxH` resolution). A `saveVideo` object in a `--config` JSON file is equivalent.
- **Why it's off here:** the official Claude Code **Playwright plugin** launches the server with the bare minimal args — verified at
  `~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json`:
  ```json
  { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
  ```
  No flags → the `devtools` cap is not enabled → the video tools never appear (the connected instance exposes only `browser_take_screenshot` for capture). This is the stock default, not a bug, and the plugin offers no knob for it.
- **How to enable (operational):** **do not edit the plugin's `.mcp.json`** — it lives in the plugin _cache_ and is overwritten on every plugin update. Instead add your own server entry (project `.mcp.json` or user config) with the flag, under a distinct name to avoid colliding with the plugin's `playwright` server:
  ```json
  {
    "mcpServers": {
      "playwright-video": {
        "command": "npx",
        "args": ["@playwright/mcp@latest", "--caps=devtools"],
        "env": { "PLAYWRIGHT_MCP_SAVE_VIDEO": "1280x720" }
      }
    }
  }
  ```
  Requires a Claude Code restart. (Alternatively, disable the plugin and name the entry `playwright`.)

**Best for:** smooth WebM via explicit tool calls, with chapter markers — once the capability is turned on.

---

## 4. Control surface C — Chrome DevTools MCP (experimental only)

- **Screencast recording** exists but is **experimental**: requires `ffmpeg` on the server PATH and the **`--experimental-ffmpeg-path`** flag. Underlying mechanism is the Chrome DevTools Protocol `Page.startScreencast` API.
- **`performance_start_trace`** records a performance trace that includes a **screenshot filmstrip**, _not_ a playable video file. `take_screenshot` is otherwise the only capture tool.
- **Status in this environment:** screencast **not enabled** (no ffmpeg flag configured).

**Best for:** nothing video-related today; better suited to performance/trace analysis. A GitHub feature request (Feb 2026, issue #878) tracks first-class screen-cast recording.

---

## 5. The reliable path — Playwright _library_ (already wired in this repo)

- `apps/e2e/playwright.config.ts` already sets **`use: { video: 'retain-on-failure' }`** → WebM at `test-results/*/video.webm`. So this project already records browser video on test failure with zero extra tooling.
- For an arbitrary agent-authored script, the Playwright **`recordVideo: { dir, size }`** browser-context option produces a WebM of the whole session. No MCP capability needed — just the `@playwright/test` dependency the repo already has.
- **Puppeteer alternative:** `Page.startScreencast` → frames → `ffmpeg` (the `puppeteer-screen-recorder` package wraps this). Same CDP mechanism Chrome DevTools MCP uses experimentally.
- Convert WebM → GIF/MP4 with `ffmpeg -i video.webm -vf "fps=15,scale=1280:-1" output.gif`.

**Best for:** dependable, smooth, compact true-video of multi-minute sessions. The default recommendation when video fidelity matters.

---

## 6. GIF vs WebM — the weight question, answered

The instinct that "GIFs are heavy" is half right:

- **GIF as a format is heavy:** max 256 colors, per-frame LZW, **no inter-frame/motion compression** (unlike H.264/VP9 which encode only frame deltas). A _continuous_ multi-minute GIF would be brutal — easily hundreds of MB to a GB, and still choppy.
- **But `gif_creator` is not continuous.** It captures **one frame per action**, so size scales with **action count, not duration**. A 3-minute, ~40-interaction session ≈ ~40 frames ≈ a few–tens of MB — far smaller than a naive continuous GIF.
- The real trade is **smoothness/fidelity, not just size.**

|                                | `gif_creator` (Claude-in-Chrome)                | Playwright WebM                                 |
| ------------------------------ | ----------------------------------------------- | ----------------------------------------------- |
| Motion                         | Stepped slideshow (1 frame/action)              | Smooth, true motion                             |
| ~3-min session size (ballpark) | few–tens of MB (scales w/ action count)         | ~5–30 MB (scales w/ duration, compressed)       |
| Color/fidelity                 | 256-color palette (UI text slightly degraded)   | Full color                                      |
| Audio                          | None                                            | None (browser video)                            |
| Annotations                    | ✅ click rings, labels, progress bar, watermark | ❌ none                                         |
| Ready in this env?             | ✅ yes                                          | ❌ needs `--caps=devtools` (or use the library) |

_Size figures are order-of-magnitude estimates, not measured benchmarks._

---

## 7. Decision guidance

- **Want a recording today, zero setup, annotated steps:** Claude-in-Chrome `gif_creator` (accept GIF + choppiness).
- **Want a smooth, faithful, compact WebM, reliably:** Playwright **library** (`recordVideo`) — the repo is already set up for it.
- **Want WebM via MCP tool calls specifically:** enable Playwright MCP with `--caps=devtools` (§3).
- **Avoid** Chrome DevTools MCP for video today (experimental, ffmpeg-dependent; traces are filmstrips, not video).

### DorkOS product angle (out of research scope, flagged for follow-up)

Kai's core need — _"agents tell me what they did"_ — maps naturally onto embedding a recording (WebM / annotated GIF / Playwright Trace Viewer) into the DorkOS session UI. The recording mechanics are settled here; the _product integration_ is unexplored.

---

## 8. Sources

- [Playwright MCP — Video Recording](https://playwright.dev/mcp/tools/video)
- [Playwright MCP — Configuration options](https://playwright.dev/mcp/configuration/options)
- [Playwright MCP — Profile & State](https://playwright.dev/mcp/configuration/user-profile)
- [Playwright — Videos (library API)](https://playwright.dev/docs/videos)
- [microsoft/playwright-mcp #695 — Video recording option](https://github.com/microsoft/playwright-mcp/issues/695)
- [microsoft/playwright-mcp #1093 — `--save-video` with `--extension`](https://github.com/microsoft/playwright-mcp/issues/1093)
- [ChromeDevTools/chrome-devtools-mcp #878 — screen-cast recording](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/878)
- [ChromeDevTools/chrome-devtools-mcp — repo](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- Live tool-schema inspection: `mcp__claude-in-chrome__gif_creator`, `mcp__plugin_playwright_playwright__*`, `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`
- Local config: `~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json`; `apps/e2e/playwright.config.ts`
