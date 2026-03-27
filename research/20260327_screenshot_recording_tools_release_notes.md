---
title: 'Screenshot & Recording Tools for Release Notes and Changelogs'
date: 2026-03-27
type: external-best-practices
status: active
tags:
  [screenshots, recording, release-notes, changelog, mcp, playwright, ci-cd, gif, video, automation]
searches_performed: 22
sources_count: 38
---

## Research Summary

This report surveys tools for automatically capturing screenshots and recordings for software release notes and changelogs. The landscape divides into five distinct categories: MCP servers for AI-driven screenshot capture, CLI tools that run headlessly in CI/CD, screenshot-as-a-service APIs, GIF/terminal recording tools, and video recording solutions. The clearest recommendation for DorkOS is a two-track strategy: **Playwright MCP** for AI-assisted interactive documentation (integrated with Claude Code today) and **shot-scraper + GitHub Actions** for automated per-release CI snapshots. Neither requires paid services for typical dev-tool changelog volumes.

---

## Key Findings

1. **Playwright MCP is the strongest fit for DorkOS's existing Claude Code workflow.** It installs with one command (`claude mcp add playwright npx @playwright/mcp@latest`), supports localhost URLs natively, runs headlessly in CI with `--headless`, and saves screenshots to a configurable output directory. It is free and open source.

2. **shot-scraper is the best pure-CLI/CI option.** Built on Playwright by Simon Willison, it has a declarative YAML format (`shots.yml`) with first-class support for spinning up a dev server before capture, executing JavaScript before screenshotting, and committing results back to the repo in a GitHub Actions workflow. Free and open source (Apache 2.0).

3. **VHS (charmbracelet) is the definitive tool for terminal/CLI GIF recordings.** It has a declarative `.tape` format, a dedicated GitHub Action, and outputs GIF, MP4, and WebM. It cannot capture browser sessions — it is terminal-only.

4. **Playwright's built-in video API produces WebM files** from any headless browser test, making it viable for capturing short browser session demos in CI without additional tooling. Combine with ffmpeg to convert to GIF or MP4.

5. **Screenshot APIs (ScreenshotOne, Urlbox, Microlink) are designed for external public URLs**, not localhost. They are useful for capturing the marketing site or docs site on deploy, not for capturing a local dev build. All have free tiers for low-volume use.

6. **Screen Studio and OBS cannot run headlessly** and are therefore not suitable for automated CI/CD pipelines. They are best for manually produced demo videos.

7. **skills.sh has one relevant skill: `agent-browser`** (by inference.sh). It wraps Playwright and supports browser session recording with cursor indicators — useful for documentation-style demos — but is not specifically oriented toward CI/CD or release pipelines.

---

## Detailed Analysis

### Category 1: MCP Servers for Screenshot Capture

#### Playwright MCP (`@playwright/mcp`)

- **Source:** Microsoft — official package
- **Install:** `npx @playwright/mcp@latest` or `claude mcp add playwright npx @playwright/mcp@latest`
- **Localhost support:** Yes — pass any `http://localhost:PORT/route` to the agent
- **Headless CI:** Yes — add `"--headless"` to the args array in MCP config
- **Output:** Screenshots saved to `.playwright-mcp/` by default; configurable via `--output-dir`
- **Quality:** Full-resolution viewport or full-page screenshots, PNG format
- **Cost:** Free, open source
- **Release pipeline fit:** High. An agent can be prompted to navigate to specific routes, apply state (auth, dark mode, specific data), then screenshot. Natural language instructions eliminate custom scripting. The Microsoft Playwright team explicitly recommends MCP for autonomous agent workflows.
- **CI example:**
  ```json
  {
    "mcpServers": {
      "playwright": {
        "command": "npx",
        "args": ["@playwright/mcp@latest", "--headless", "--output-dir", "docs/screenshots"]
      }
    }
  }
  ```

#### `@tscodex/mcp-screenshot`

- **Description:** MCP server using Playwright for viewport, full-page, and element screenshots
- **Install:** npm package
- **Localhost support:** Yes
- **Headless CI:** Yes (Playwright-based)
- **Cost:** Free
- **Fit:** Lighter-weight alternative to Playwright MCP for screenshot-only use cases; less ecosystem support

#### `mcp-screenshot-server` (sethbang)

- **Description:** Puppeteer-based web screenshot + native OS screenshot capabilities
- **Notable:** Security-hardened — SSRF prevention, DNS rebinding defense, path traversal protection
- **Localhost support:** Yes, with security controls that may need configuration for 127.0.0.1
- **Cost:** Free (open source)
- **Fit:** Good for cases where native OS screenshots are also needed

#### Microsoft `@playwright/mcp` vs. Execute Automation `mcp-playwright`

- The official Microsoft package uses accessibility snapshots by default (token-efficient; does not require screenshots for navigation)
- ExecuteAutomation's `mcp-playwright` package is a community wrapper that focuses more on traditional screenshot-based interaction
- For release notes documentation, the official Microsoft package is preferred

---

### Category 2: CLI Tools for Headless Screenshot Capture

#### shot-scraper (Simon Willison)

- **Install:** `pip install shot-scraper && shot-scraper install`
- **Language:** Python / Playwright
- **Localhost support:** Yes — `url: http://localhost:PORT/route` in YAML. Use the `server:` block to auto-start a dev server before capturing:
  ```yaml
  - server: npm run dev
    url: http://localhost:5173/
    output: dashboard.png
    wait: 2000
  ```
- **Headless CI:** Yes — fully headless, no display required
- **YAML multi-shot format:**
  ```yaml
  - output: dashboard.png
    url: http://localhost:5173/
    width: 1440
    height: 900
    wait_for: "document.querySelector('.dashboard')"
    javascript: "document.body.classList.add('screenshot-mode')"
  - output: session.png
    url: http://localhost:5173/session
    selector: '.chat-panel'
    padding: 16
  ```
- **GitHub Actions:** Official support with caching, oxipng compression, and auto-commit. The `shot-scraper-template` repository bootstraps a new repo with CI pre-configured.
- **Output formats:** PNG, JPEG (with quality control)
- **Video/GIF:** No
- **Cost:** Free (Apache 2.0)
- **Fit:** Excellent for automated per-release screenshot generation. The declarative YAML approach makes it easy to maintain a `shots.yml` at the root of the repo that captures all key routes on every release tag.

#### Playwright CLI (`@playwright/cli`)

- **Install:** `npx @playwright/cli`
- **Launched:** Early 2026 (official Microsoft package)
- **Localhost support:** Yes
- **Headless CI:** Yes (default headless)
- **Usage:** `npx playwright screenshot --browser chromium http://localhost:5173 out.png`
- **Output:** PNG/JPEG
- **Cost:** Free
- **Fit:** Best when the team already has Playwright installed for testing — zero additional dependencies. The Microsoft recommendation is: use CLI for coding agent tasks, use MCP for autonomous agent workflows.

#### Puppeteer (Node.js)

- **Install:** `npm i puppeteer`
- **Localhost support:** Yes — `page.goto('http://localhost:PORT')`
- **Headless CI:** Yes (default headless in recent versions)
- **Output:** PNG, JPEG, PDF
- **Video:** No native support; requires ffmpeg + Xvfb workarounds
- **Cost:** Free
- **Fit:** More setup than shot-scraper for multi-route documentation. Best when Node.js is the only runtime available and Playwright is not already in the stack. For new work, Playwright is strictly superior.

---

### Category 3: Screenshot-as-a-Service APIs

None of these services can capture localhost URLs — they require a publicly accessible URL. They are appropriate for capturing deployed docs/marketing sites (e.g., on Vercel deployments) but not for local dev builds.

#### ScreenshotOne

- **Free tier:** 100 screenshots/month (no credit card required)
- **Paid:** $17/mo for 2,000; $79/mo for 10,000; $259/mo for 50,000
- **Features:** 200+ parameters, scrolling video captures, GPU rendering, geo-location, HTML-to-image, ad blocker, 18 geographic locations
- **Localhost:** No
- **CI fit:** Yes for post-deploy Vercel preview URL screenshots
- **Quality:** High

#### Microlink

- **Free tier:** 50 requests/day, no API key required
- **Paid:** $27.70/month for 28,000 requests
- **Features:** Full headless browser, JavaScript execution, GDPR popup blocking, device emulation, full-page capture, sub-second response
- **Localhost:** No
- **CI fit:** Good for capturing Vercel preview URLs on deploy
- **Quality:** High

#### Urlbox

- **Free tier:** 7-day trial only (no permanent free tier)
- **Paid:** $19/mo (Lo-Fi, 2,000 renders), $49/mo (Hi-Fi), $99/mo (Ultra)
- **Features:** JavaScript rendering, custom CSS/JS injection, cookie banner hiding, geo-location emulation, full-page screenshots
- **Localhost:** No
- **CI fit:** Yes for production/preview URL capture
- **Quality:** Very high

#### Summary for APIs

For DorkOS release notes, the practical use case is: after a Vercel preview deploy, trigger a webhook that calls a screenshot API with the preview URL and stores the result in GitHub as a release artifact. ScreenshotOne's free 100/month tier covers most indie dev release cadences; Microlink's 50/day free tier is generous for CI.

---

### Category 4: GIF Recording Tools

#### VHS (charmbracelet) — Best for Terminal/CLI

- **Install:** `brew install vhs` (macOS), also via Docker, apt, nix
- **Dependencies:** ttyd, ffmpeg
- **CI support:** Full — official GitHub Action (`charmbracelet/vhs-action`), Docker image `ghcr.io/charmbracelet/vhs`
- **Headless:** Yes — fully headless, no display required
- **Output formats:** GIF, MP4, WebM, PNG sequence
- **Configuration (tape format):**

  ```
  Output demo.gif
  Output demo.mp4

  Set FontSize 14
  Set Width 1200
  Set Height 600

  Type "dorkos start"
  Enter
  Sleep 2s
  Type "dorkos agents list"
  Enter
  Sleep 1s
  ```

- **GitHub Actions:**
  ```yaml
  - uses: charmbracelet/vhs-action@v2
    with:
      path: docs/demo.tape
  ```
- **Browser recording:** No — terminal only
- **Cost:** Free (MIT)
- **Fit:** Excellent for DorkOS CLI demos in release notes. Cannot capture the web UI.

#### asciinema + agg

- **Install:** `pip install asciinema` + `cargo install agg` (or brew)
- **CI support:** asciinema 3.0 includes `--headless` flag (RC available). Older versions require a PTY.
- **Workflow:** Record with `asciinema rec demo.cast -c "my-command"`, convert to GIF with `agg demo.cast demo.gif`
- **Output:** `.cast` (replay in browser) → GIF via agg
- **Browser recording:** No
- **Cost:** Free (open source)
- **Fit:** Good for sharing terminal recordings with replay capability (the `.cast` format embeds in the asciinema player web component). For static GIFs in GitHub changelogs, agg conversion works well. VHS has the edge for declarative CI scripting.

#### LICEcap / Gifox / Kap

- All require a GUI — no headless/CI support
- **LICEcap:** Free, Windows/macOS, minimal (670KB), GIF only
- **Gifox:** macOS only, paid ($15), polished UI, compression options, updated May 2025 (v2.7.0)
- **Kap:** Free/open source, macOS only, exports GIF/MP4/WebM/APNG
- **Fit:** Manual use only. Not suitable for automated release pipelines.

---

### Category 5: Video Recording Tools

#### Playwright (native video)

- **Feature:** `video: 'on'` in `playwright.config.ts` records WebM video for every test
- **Output:** `test-results/*/video.webm`
- **Headless CI:** Yes — works in headless mode
- **Format conversion:** `ffmpeg -i video.webm -vf "fps=15,scale=1280:-1" output.gif`
- **Use case:** Record a Playwright script that navigates through key UI flows → export as WebM → convert to GIF or MP4 for changelog
- **Cost:** Free
- **Fit:** High for browser UI demos. Requires writing a Playwright script that walks through the feature, but that doubles as a functional test.

#### ffmpeg + Xvfb (Linux CI)

- **Approach:** Start Xvfb virtual display → launch browser headed → record X11 display with ffmpeg
- **CI support:** Linux only (GitHub Actions ubuntu runners)
- **Complexity:** High — requires Xvfb setup, PulseAudio for audio, precise ffmpeg invocation
- **Output:** MP4, GIF (via ffmpeg palette filter)
- **Cost:** Free
- **Fit:** Works but significantly more complex than using Playwright's native video API. Only worth it for recordings that cannot be automated through Playwright (e.g., native desktop window capture).

#### Screen Studio

- **Platform:** macOS only, GUI application
- **Automated/headless:** No — requires manual operation
- **Features:** Auto-zoom, cursor smoothing, background blur, zoom transitions, selfie camera layout
- **Output:** MP4 (high quality)
- **Cost:** Paid ($89 one-time or subscription)
- **Fit:** Excellent for manually produced hero demo videos for marketing/Product Hunt launches, not for automated release pipelines.

#### OBS Studio

- **Platform:** Windows/macOS/Linux, GUI application
- **Automated/headless:** No for recordings; technically scriptable via WebSocket API but requires display
- **Cost:** Free (GPL)
- **Fit:** Manual use only. Overkill for changelog screenshots; useful for long-form screencasts.

---

### Category 6: skills.sh Skills

A search of skills.sh found three relevant entries:

#### `agent-browser` (inference.sh/agent-skills)

- **Installs:** 134,500+
- **Description:** Playwright-backed browser automation skill for AI agents
- **Screenshot support:** Yes — viewport and full-page screenshots
- **Video/session recording:** Yes — records browser sessions with optional cursor indicator (red dot follows mouse movements)
- **Localhost support:** Implied (no explicit restriction documented)
- **CI fit:** Not documented — primarily designed for interactive agent sessions
- **Fit for DorkOS:** Moderate. Useful for AI-driven interactive demo capture within Claude Code sessions. The session recording with cursor indicator is particularly relevant for creating walkthrough-style documentation videos.

No skills specifically targeting changelog generation with screenshots, visual release documentation, or screenshot-to-markdown pipelines were found on skills.sh.

---

## Recommended Strategy for DorkOS

### Immediate (no new tooling): Playwright MCP

Use Claude Code + Playwright MCP to manually generate screenshots when writing release notes. The workflow:

1. Start `pnpm dev`
2. In Claude Code: "Navigate to `http://localhost:6241/agents` and take a full-page screenshot, save to `docs/releases/v0.x.0/agents-page.png`"
3. Claude navigates, interacts, screenshots, and saves — all via natural language

### Automated CI pipeline: shot-scraper + GitHub Actions

Add a `shots.yml` at the repo root defining key routes. On release tag push:

1. GitHub Actions builds the app and starts the dev server
2. shot-scraper captures all defined routes
3. Screenshots are committed to `docs/releases/{version}/` or uploaded as release assets

Example workflow structure:

```yaml
on:
  push:
    tags: ['v*']

jobs:
  screenshots:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: pnpm install
      - run: pnpm build
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install shot-scraper && shot-scraper install
      - run: |
          # Start server in background
          pnpm --filter=@dorkos/server start &
          pnpm --filter=@dorkos/client preview &
          sleep 5
          shot-scraper multi shots.yml
      - uses: actions/upload-artifact@v4
        with:
          name: release-screenshots
          path: '*.png'
```

### CLI demos: VHS + vhs-action

For DorkOS CLI commands, maintain `.tape` files in `docs/tapes/`:

```
# docs/tapes/quickstart.tape
Output docs/demos/quickstart.gif
Set Width 1200
Set Height 600
Type "dorkos start"
Enter
Sleep 3s
```

The `charmbracelet/vhs-action` regenerates GIFs on every push.

### Manual demo videos: Screen Studio

For Product Hunt launches, major version announcements, and marketing videos: Screen Studio on macOS. Not integrated into CI.

---

## Comparison Matrix

| Tool                | Headless CI      | Localhost | Cost          | Output       | Browser UI | Terminal | Complexity |
| ------------------- | ---------------- | --------- | ------------- | ------------ | ---------- | -------- | ---------- |
| Playwright MCP      | Yes (--headless) | Yes       | Free          | PNG          | Yes        | No       | Low        |
| shot-scraper        | Yes              | Yes       | Free          | PNG/JPEG     | Yes        | No       | Low        |
| Playwright CLI      | Yes              | Yes       | Free          | PNG          | Yes        | No       | Low        |
| Playwright video    | Yes              | Yes       | Free          | WebM         | Yes        | No       | Medium     |
| Puppeteer           | Yes              | Yes       | Free          | PNG          | Yes        | No       | Medium     |
| VHS                 | Yes              | No        | Free          | GIF/MP4/WebM | No         | Yes      | Low        |
| asciinema+agg       | Partial\*        | No        | Free          | GIF/.cast    | No         | Yes      | Medium     |
| ScreenshotOne API   | Yes              | No        | Free (100/mo) | PNG/JPEG     | Yes        | No       | Low        |
| Microlink API       | Yes              | No        | Free (50/day) | PNG          | Yes        | No       | Low        |
| Urlbox API          | Yes              | No        | $19+/mo       | PNG          | Yes        | No       | Low        |
| ffmpeg+Xvfb         | Yes (Linux)      | Yes       | Free          | MP4/GIF      | Yes        | Yes      | High       |
| Screen Studio       | No               | Yes       | $89+          | MP4          | Yes        | No       | None       |
| Kap                 | No               | Yes       | Free          | GIF/MP4      | Yes        | No       | None       |
| agent-browser skill | No               | Likely    | Free          | PNG/Video    | Yes        | No       | Low        |

\*asciinema 3.0 adds `--headless`; earlier versions require PTY

---

## Research Gaps & Limitations

- **Localhost tunnel support for screenshot APIs**: ScreenshotOne, Microlink, and Urlbox don't document support for tunneled localhost (via ngrok/cloudflared). This would be the path to use cloud APIs against a local build — worth investigating for CI use cases where `pnpm preview` is unavailable.
- **agent-browser skill CI integration**: Documentation for whether the inference.sh `agent-browser` skill works in headless GitHub Actions environments was not found. Given it's Playwright-backed, it likely does, but requires verification.
- **Playwright MCP screenshot quality options**: The `--caps vision` flag enables additional screenshot capabilities including full-page capture; the precise PNG quality and resolution controls in CI mode were not fully documented in the sources found.
- **VHS browser recording workarounds**: No community solutions were found for capturing browser sessions with VHS; the terminal-only limitation appears fundamental to its architecture (ttyd emulates a terminal, not a graphical display).

---

## Contradictions & Disputes

- The Playwright team's own documentation recommends Playwright MCP for autonomous agent workflows but Playwright CLI for AI coding agent tasks (like Claude Code). In practice for DorkOS, both work — the MCP approach is more natural for interactive documentation generation sessions, while the CLI/API approach is more deterministic for CI pipelines.
- Multiple sources describe asciinema as "headless" but the headless flag (`--headless`) is only in the 3.0 RC, not the stable release as of early 2026. The `--headless` flag requires verification against the current stable release.

---

## Sources & Evidence

- [GitHub: simonw/shot-scraper](https://github.com/simonw/shot-scraper) — Apache 2.0, Playwright-based, YAML multi-shot format
- [shot-scraper: GitHub Actions integration](https://shot-scraper.datasette.io/en/stable/github-actions.html)
- [shot-scraper: Multi-screenshot YAML format](https://shot-scraper.datasette.io/en/stable/multi.html)
- [GitHub: charmbracelet/vhs](https://github.com/charmbracelet/vhs) — MIT, terminal GIF recorder
- [GitHub: charmbracelet/vhs-action](https://github.com/charmbracelet/vhs-action) — GitHub Action for VHS
- [GitHub: microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) — Official Playwright MCP server
- [Shipyard: Taking screenshots with Playwright MCP](https://shipyard.build/blog/playwright-mcp-screenshots/) — localhost workflow details
- [DEV: Automate screenshot documentation with Playwright MCP](https://dev.to/debs_obrien/automate-your-screenshot-documentation-with-playwright-mcp-3gk4)
- [GitHub: sethbang/mcp-screenshot-server](https://github.com/sethbang/mcp-screenshot-server) — Puppeteer MCP, security-hardened
- [GitHub: ananddtyagi/webpage-screenshot-mcp](https://github.com/ananddtyagi/webpage-screenshot-mcp) — Puppeteer-based screenshot MCP
- [npmjs: @tscodex/mcp-screenshot](https://www.npmjs.com/package/@tscodex/mcp-screenshot) — Playwright-based element/viewport/full-page MCP
- [ScreenshotOne pricing](https://screenshotone.com/pricing/) — 100 free/mo, $17 for 2,000
- [Microlink screenshot API](https://microlink.io/screenshot) — 50 free req/day, $27.70/mo for 28,000
- [Urlbox pricing](https://urlbox.com/pricing) — $19/mo Lo-Fi, 7-day trial
- [Scrapfly: Best screenshot API 2026](https://scrapfly.io/blog/posts/what-is-the-best-screenshot-api)
- [Playwright: Videos documentation](https://playwright.dev/docs/videos) — `video: 'on'` WebM output
- [GitHub Actions + Playwright screenshots workflow](https://mfyz.com/github-actions-and-playwright-to-generate-web-page-screenshots/)
- [asciinema headless CI discussion](https://github.com/orgs/asciinema/discussions/247) — 3.0 RC includes --headless
- [agg: asciinema GIF generator](https://docs.asciinema.org/manual/agg/)
- [skills.sh: agent-browser](https://skills.sh/inferencesh/skills/agent-browser)
- [Screen Studio](https://screen.studio/) — macOS only, no CLI/headless
- [Playwright CLI: token-efficient AI agent alternative to MCP](https://testcollab.com/blog/playwright-cli)

## Search Methodology

- Searches performed: 22
- Most productive search terms: "playwright-mcp screenshot localhost CI", "shot-scraper YAML multi GitHub Actions", "vhs charmbracelet terminal GIF CI headless", "mcp screenshot browser web app npm 2025"
- Primary source types: GitHub READMEs, official documentation sites, developer blog posts, npm package pages
