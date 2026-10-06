---
title: 'Every agent gets its own Linux desktop'
date: 2026-10-06
type: internal-architecture
status: active
tags: [agent-computer, linux-desktop, sandboxing, containers, streaming, browser, vision-202610]
---

# Every agent gets its own Linux desktop

Research date: 2026-10-06. Web and repo research for the founder's decision: every agent gets its own Linux desktop, and that desktop is the only computer it can reach. It must be provisioned the same way on a Mac, on Windows, on Linux, in DorkOS Cloud and on a self-hosted server. Local use must be free. An agent can move from the laptop to a cloud or self-hosted instance and back.

Legend: **[verified]** = read at the cited source today. **[unverified]** = my estimate or a secondary source only; test it in a prototype before relying on it.

---

## 0. The answer in one screen

**The core design implication holds.** Run the agent's runtime (Claude Code CLI, Codex CLI, OpenCode) _inside_ its box, and treat "move the agent" as "move the box". Three things make this work:

1. **The box is an OCI image plus one persistent home volume.** The image is pinned by digest. The home holds the agent's files, git checkouts, Chromium profile and the runtime's own transcripts (`~/.claude/projects`, `~/.codex`, the OpenCode store). Nothing in the box points at a host path.
2. **The DorkOS server stays the control plane and the box is the execution plane.** The Claude Agent SDK already has the seam: `spawnClaudeCodeProcess` ("Use this to run Claude Code in VMs, containers, or remote environments"). DorkOS already takes that seam in `apps/server/src/services/runtimes/claude-code/sessions/tracked-spawn.ts`. Swapping the local spawn for "exec into box N" is a small change. For Codex, `codexPathOverride` can point at an exec wrapper. OpenCode is already an HTTP sidecar, so it can run in the box behind a forwarded port. **[verified in repo]**
3. **A move is cold, at a turn boundary: files move, processes do not.** Docker shipped exactly this on 2026-09-24 (`sbx move my-project --to cloud`: "A move captures the sandbox's filesystem and recreates it on the other side"). Fly Sprites draw the same line ("disk persists, memory does not"). Live process migration (CRIU) is the wrong tool here. Section 5 explains why.

**Recommended stack (details in §8):**

- **Image:** Debian or Ubuntu, multi-arch (arm64 and amd64), X11 (Xvfb or Xorg-dummy) with XFCE, Chromium with a portable profile, Node, git, and the three runtime CLIs. Build it ourselves. Borrow ideas from the linuxserver Selkies base, E2B desktop, ByteBot and the Anthropic reference container rather than depending on them.
- **Streaming:** Selkies (MPL-2.0) in WebSocket mode for "watch and take over", so it passes through DorkOS's existing HTTP proxy and tunnel. Keep noVNC (MPL-2.0) with x11vnc as the boring fallback. Neko (Apache-2.0) is the best at handing control between people, but it is WebRTC-first and needs a UDP or TCP port, so it is a poor fit for the tunnel.
- **Control API:** a DorkOS-owned in-box "computer" MCP server (stdio). It offers screenshot, input via xdotool, an AT-SPI accessibility tree, and the action set of Anthropic's `computer_toolset_20260801`. Next to it runs Playwright MCP attached over CDP to the _same_ visible Chromium. Shell and files are just the runtime's native tools.
- **Local runner:** a `BoxRunner` port with one backend per OS:
  - **Linux:** rootless Podman.
  - **macOS:** a bundled Lima VM (Apache-2.0) running Podman, with Apple `container` / Containerization (macOS 26+, Apache-2.0) as the VM-per-agent backend.
  - **Windows:** a DorkOS WSL2 distro brought in with `wsl --import`, running Podman.
  - Never require Docker Desktop or OrbStack. Use them only if they are already installed.
- **Cloud host:** run the _same self-host server_ (Hono server + Podman + gVisor) on plain arm64 and amd64 VMs (for example Hetzner CAX/CX). Graduate to Kata or Firecracker, or Kubernetes `agent-sandbox`, for multi-tenant density later. Fly Sprites and E2B are optional burst backends, not the foundation.
- **Move mechanism:** a lease with a fencing epoch. The home is synced continuously as content-addressed chunks to S3-compatible storage (kopia or restic style). A move means: pause at a turn boundary, final delta, bump the lease epoch, start on the destination from the same image digest, then `--resume` the session.

**Top risks:** laptop RAM ceiling; Windows and macOS-version setup friction; arm64↔amd64 mismatch on moves; credential injection and subscription auth inside boxes; isolation and egress (plus licence traps). See §9.

---

## 1. What the repo already has (checked first)

- `research/20260717_cloud-sandbox-workspace-provider.md` reached the conclusion this decision needs: _"The `WorkspaceProvider` port is the wrong seam for a remote sandbox… the future path being a **remote AgentRuntime, not a WorkspaceProvider**… To make a cloud sandbox useful you must run the **agent itself inside the sandbox**."_ It also logged per-provider costs (Daytona ~$66/mo, Sprites ~$126/mo, E2B ~$216/mo for 400 agent-hours) and recommended DEFER. That deferral now has to be reversed. Its local-first and privacy objections are answered here by making the box _local by default_.
- `research/20260721_vercel-sandbox-agent-execution.md`: Vercel Sandbox is a single US region (`iad1`), its snapshots expire after 30 days, and creation is reported before boot finishes. It is not a fit as a foundation.
- `research/20261001_shared-browser-control.md` and `packages/browser`: a DorkOS-owned **host-side** managed Chromium (Playwright 1.63, `playwright-core` dependency). It has a large darwin-specific supervisor, journal and custody layer (`src/runtime/darwin-*`) and ~40 lifecycle tests. Its descriptor enum already lists `darwin | linux | win32`. **Implication:** under "the box is the only computer", the _agent's_ browser moves into the box (Chromium in the Linux desktop, driven over CDP from inside). The host-side engine shrinks to the person's own preview needs, or gets re-targeted at "Chromium inside a Linux box". This is a re-scope decision worth making before more darwin custody work lands.
- `apps/server/src/services/runtimes/claude-code/sessions/tracked-spawn.ts`: DorkOS already injects `spawnClaudeCodeProcess` for warm processes, which is the box seam. The SDK contract (`SpawnedProcess`: stdin, stdout, kill, exit) is easy to meet with `podman exec -i` or a container exec API. **[verified]**
- Codex SDK 0.154: `codexPathOverride` and an `env` map that "will not inherit variables from `process.env`". This works for an exec wrapper. **[verified]**
- ADR-0310 (session storage is runtime-owned and read from host paths) and message search (an FTS index over Claude Code, Codex and OpenCode transcripts) both assume the transcripts are on the host filesystem. With runtimes inside boxes, those readers must go through the box volume or a box API. This is the largest internal knock-on effect.
- Earlier internal notes already sketch "agent computer = one port, levels: host shell → Linux box → Linux GUI desktop → macOS VM → cloud". This report fills in the Linux-desktop level.

---

## 2. Building blocks for a persistent, watchable Linux desktop

| Project                                    | What it is                                                                                                                                                                                                                                                                                          | Licence                                                                                                                                                     | Status (2026-10)                                                                                                                                         | Fit for DorkOS                                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **linuxserver webtop / baseimage-selkies** | Full desktops (XFCE, KDE, i3…) streamed to the browser. Webtop "is based on Docker Baseimage Selkies". The base bundles Selkies, pixelflux (capture, encode, Wayland compositor), pcmflux (audio), NGINX, PulseAudio, labwc; "Openbox in X11 fallback mode". WebSocket by default, WebRTC optional. | **GPL-3.0** (Dockerfiles and init scripts); Selkies itself MPL-2.0                                                                                          | Active; Alpine 3.24, Debian Trixie, Ubuntu, Fedora 44, arm64 and amd64 **[verified]**                                                                    | Best reference. Do not base on it directly: GPL-3 scripts, "by default there is **no authentication**", "privileged access to the host", and no `latest` tag ("breaking changes occur between versions"). Copy the approach, not the image. |
| **baseimage-kasmvnc / KasmVNC**            | VNC server with a modern web client                                                                                                                                                                                                                                                                 | KasmVNC **GPL-2.0**; base repo GPL-3.0                                                                                                                      | One search summary says linuxserver retired the KasmVNC bases. The repo page shows no notice. Webtop has moved to Selkies. **[status unverified]**       | Viable, but linuxserver is moving away from it. Lower priority.                                                                                                                                                                             |
| **Kasm Workspaces**                        | Full multi-user platform                                                                                                                                                                                                                                                                            | **Community Edition: non-commercial only, 5 concurrent sessions**; paid per user                                                                            | Active                                                                                                                                                   | **Avoid.** Its licence is incompatible with "free local for companies".                                                                                                                                                                     |
| **neko (m1k1o)**                           | Self-hosted virtual browser or desktop over **WebRTC**; XFCE and KDE images plus every major browser; multiple users with control handover; `NEKO_SESSION_IMPLICIT_HOSTING` gives control to whoever touches the screen                                                                             | **Apache-2.0**                                                                                                                                              | v3.1.0 (2026-04-02), active **[verified via search]**                                                                                                    | Best "many watchers, one controller" model to copy. WebRTC needs a UDP or TCP mux port (`NEKO_WEBRTC_UDPMUX`/`TCPMUX`), not plain HTTP, so it is awkward through DorkOS's HTTP tunnel without TURN.                                         |
| **Selkies (selkies-project)**              | Low-latency streaming over WebSocket (default) or WebRTC; GPU optional; built for containers and Kubernetes "without requiring root"                                                                                                                                                                | **MPL-2.0**                                                                                                                                                 | Active; Google-originated, now linuxserver and community                                                                                                 | **Recommended streaming core.** WebSocket mode passes through reverse proxies and tunnels.                                                                                                                                                  |
| **noVNC + x11vnc / TigerVNC**              | The classic stack                                                                                                                                                                                                                                                                                   | noVNC **MPL-2.0**; x11vnc and TigerVNC **GPL-2.0+**                                                                                                         | Mature                                                                                                                                                   | Recommended fallback. Used by Anthropic's reference container and by E2B. Lower quality, but it always works.                                                                                                                               |
| **Xpra**                                   | Remote applications and desktops, HTML5 client                                                                                                                                                                                                                                                      | Server **GPL-2.0+**; HTML5 client MPL-2.0                                                                                                                   | Active                                                                                                                                                   | Strong at per-window streaming; niche. Not needed.                                                                                                                                                                                          |
| **E2B desktop** (`e2b-dev/desktop`)        | Ubuntu 22.04 with XFCE, noVNC streaming; SDK with `screenshot()`, click, drag, `write()`, `press()`                                                                                                                                                                                                 | **Apache-2.0**                                                                                                                                              | SDK moved into the E2B monorepo; needs E2B infra (self-host infra is Apache-2.0 but Terraform/Nomad-heavy)                                               | Good reference for the action API; not a local runner.                                                                                                                                                                                      |
| **trycua/cua**                             | Cua Driver (desktop automation for macOS, Windows, Linux, with an **MCP server for Claude Code, Codex, Cursor**); Lume (macOS and Linux VMs on Apple Silicon); lumier; gVisor Linux containers; `cua-spacesd` in-box daemon (port 3211)                                                             | SDK, Driver and Lume **MIT**. **Cua Spaces is FSL-1.1-MIT** ("no competing hosted service"; MIT after 2 years). `cua-perception`/`cua-som` are **AGPL**     | Very active (28k stars). Cua Spaces is "a full desktop for your agents… you can watch", multi-cursor over its own RCDP protocol over QUIC **[verified]** | **The closest competitor to this exact vision.** Cua Driver and Lume (MIT) are usable parts. Do **not** build on Cua Spaces (FSL forbids a competing hosted service, which DorkOS Cloud would be) or on the AGPL perception packages.       |
| **OpenMuse** (CopilotKit)                  | A personal agent with persistent Chromium (Playwright worker, "Take control") plus an _optional_ nonroot Linux container with a `/workspace` volume; **no GUI desktop, no VNC or WebRTC**; Hono API; Render blueprint for cloud                                                                     | **MIT**                                                                                                                                                     | Active                                                                                                                                                   | Useful pattern for a persistent browser profile and a token-protected browser worker. Not a desktop.                                                                                                                                        |
| **Daytona**                                | Sandboxes with desktop and VNC                                                                                                                                                                                                                                                                      | Last open release **v0.190.0, AGPL-3.0**; "As of June 2026, Daytona's core development has moved to a private codebase"; community fork **Nightona** (AGPL) | **Frozen and closed** **[verified]**                                                                                                                     | **Avoid as a dependency.** Usable only as a paid hosted backend.                                                                                                                                                                            |
| **OpenClaw sandbox-browser**               | Chromium container with CDP 9222, VNC 5900, noVNC 6080; "noVNC observer access is password-protected and brokered through a one-time, authenticated bootstrap URL"                                                                                                                                  | Image by a third party (`canyugs`); OpenClaw's `Dockerfile.sandbox-browser`                                                                                 | Active                                                                                                                                                   | Copy its **one-time bootstrap URL** pattern for viewer auth.                                                                                                                                                                                |
| **Anthropic computer-use reference**       | Ubuntu 22.04, Xvfb, mutter, tint2, x11vnc, noVNC 1.5, xdotool, scrot                                                                                                                                                                                                                                | **MIT** (anthropic-quickstarts)                                                                                                                             | Maintained reference                                                                                                                                     | Minimal and proven; use it as the action-semantics reference.                                                                                                                                                                               |
| **ByteBot**                                | Ubuntu 22.04 with XFCE, Firefox and VS Code, one Docker container per agent; NestJS agent plus Next.js UI                                                                                                                                                                                           | **Apache-2.0**                                                                                                                                              | **Upstream archived March 2026**; forks continue                                                                                                         | Validates the product shape. Do not depend on it.                                                                                                                                                                                           |
| **Agent S / Simular**                      | Computer-use _agent_ framework (`gui-agents`); S3 hit 72.6% on OSWorld                                                                                                                                                                                                                              | **Apache-2.0**                                                                                                                                              | Active                                                                                                                                                   | A brain, not a box. Irrelevant to provisioning; maybe useful for grounding later.                                                                                                                                                           |
| **Steel browser**                          | Browser API sandbox (CDP/Puppeteer), profiles that persist cookies, storage and extensions                                                                                                                                                                                                          | **Apache-2.0**                                                                                                                                              | Active                                                                                                                                                   | Only browser sessions. DorkOS's in-box Chromium already covers this.                                                                                                                                                                        |
| **Docker Sandboxes (`sbx`)**               | MicroVM per agent; kits for Claude Code, Codex, OpenCode and others; a host-side proxy enforces network policy **and injects credentials ("the raw key never entering the VM")**; `sbx move --to cloud`                                                                                             | `sbx` is **not open source** but "free to use, including commercially". **Sandbox Kit spec v3 is Apache-2.0** and is being donated to the CNCF              | Local since 2026-03; **Cloud Sandboxes launched 2026-09-24** ($0.07–$1.12/hr, 24 h max session, paused = free) **[verified]**                            | **The closest prior art for the move and credential design.** It is also a competitor. Consider emitting or consuming the Kit spec (OCI) so DorkOS boxes interoperate.                                                                      |

**Licence summary.** Shipping GPL programs (x11vnc, TigerVNC, KasmVNC) _inside_ the image is ordinary aggregation and does not touch DorkOS's MIT code. It does oblige us to offer the corresponding source for the GPL binaries we redistribute; distro packages make that easy. Forking linuxserver's GPL-3 Dockerfiles would make _those files_ GPL-3, so write our own. Hard no: Kasm CE (non-commercial), Cua Spaces (FSL), Daytona/Nightona and the AGPL Cua perception packages as dependencies.

---

## 3. How the agent drives the box

There are three channels, in the order agents actually use them:

1. **Shell and files (most of the work).** The runtime runs in the box, so its native Bash, Read and Edit tools act on the box. No adapter is needed. This is the main argument for putting the runtime inside: every tool call lands on the one computer by construction.
2. **Browser.** A persistent Chromium in the desktop session runs with `--remote-debugging-port` bound to the box's loopback. **Playwright MCP** (`@playwright/mcp`, already pinned in `packages/shared/src/agent-browser.ts`) attaches with `--cdp-endpoint`, so the agent drives _the same window the person is watching_. That solves the "visible browser ≠ automated browser" split described in the 2026-10-01 research. Profile portability details:
   - Launch Chromium with `--password-store=basic`. Otherwise the cookie encryption key lives in the Linux keyring (libsecret / gnome-keyring) and a moved profile loses its sign-ins. **[unverified for every site; well known for Chromium on Linux]**
   - Keep the profile in `$HOME/.config/chromium` on the home volume.
3. **Full desktop (fallback for non-web GUIs).** An in-box **computer MCP server** over stdio exposes Anthropic's action set (`computer_toolset_20260801`: screenshot, zoom, clicks, drag, mouse_move, scroll, type, key, hold_key, wait, cursor_position). The recommended resolution is **1280×800** for web work and 1024×768 or 1280×720 for general desktop. Implementation:
   - screenshots via XShm or `scrot`
   - input via `xdotool`
   - an **AT-SPI** accessibility tree (pyatspi / `at-spi2-core`), so the agent can act on element IDs instead of pixels
   - candidates to vendor or learn from: `cua-driver` (MIT, already MCP, cross-OS); `nisavid/computer-use-linux`, which also handles Wayland via ydotool and portals (licences not checked); and the minimal Anthropic reference implementation.
   - **Choose X11, not Wayland**, inside the box. xdotool and the mature AT-SPI bridges are X11-centric. linuxserver's new base defaults to Wayland (labwc) with an X11 fallback, which is one more reason to own the image.

**Human takeover.** Selkies does not arbitrate control by itself **[unverified]**. DorkOS should own a per-box **control token**: whoever holds it can send input. While a person holds it, the computer MCP and the input-capable Playwright tools refuse with a clear message (for example "A person has the controls."). Copy neko's model (implicit hosting, a request-control button) at the DorkOS proxy layer.

**What the runtimes need inside the box:**

- **Claude Code:** the native installer needs **no Node.js** and installs to `~/.local/bin/claude` without root. It supports Ubuntu 20.04+, Debian 10+ and Alpine 3.19+ on x64 or ARM64, and asks for "4 GB of RAM". Headless auth can use a token generated elsewhere (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`; the env var name is from my knowledge, not re-verified today), but `research/anthropic-tos-compliance.md` excludes that pattern when DorkOS code is what drives the Agent SDK with it.
- **Codex:** a Rust binary; `codex login --device-auth` for headless, or `auth.json` under `$CODEX_HOME`.
- **OpenCode:** its sidecar binary.
- **Still install Node 22+, pnpm, python3, git, gh, build-essential, ripgrep and jq.** The agents' _projects_ need them, the Agent SDK's MCP servers (Playwright MCP) need Node, and image layers are shared across boxes, so the cost is paid once.
- **Credentials:** see §6. The aim is that no raw long-lived keys live in the box.

---

## 4. Running it locally for free, per OS

### Runner options

| Runner                               | Licence / cost                                                                                                                  | Mac                                            | Windows          | Linux              | Admin needed?                                                                                                                           | Notes                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Desktop                       | **Paid for companies with ≥250 employees or ≥$10M revenue** ($9–$24 per user per month)                                         | ✓                                              | ✓                | ✓                  | install                                                                                                                                 | **Cannot be required.** It violates "local must be free".                                                                                                                                                                                                                                       |
| OrbStack                             | Free only for personal non-commercial use; **$8 per user per month commercial**, "even on a personal machine for work projects" | ✓                                              | –                | –                  | –                                                                                                                                       | Cannot be required.                                                                                                                                                                                                                                                                             |
| Podman / Podman Desktop              | **Apache-2.0, no commercial restrictions**                                                                                      | ✓ (podman machine, **libkrun default** on Mac) | ✓ (WSL2 machine) | ✓ native, rootless | the Mac .pkg needs admin; brew does not                                                                                                 | A good engine everywhere.                                                                                                                                                                                                                                                                       |
| Lima / Colima                        | Lima **Apache-2.0**, Colima **MIT**                                                                                             | ✓ (vz default; krunkit for GPU)                | –                | ✓                  | none if bundled and signed in the app                                                                                                   | Embeddable VM manager for macOS 13+.                                                                                                                                                                                                                                                            |
| Apple `container` / Containerization | **Apache-2.0**; v1.0.0 shipped June to July 2026                                                                                | ✓ **macOS 26+ only**, Apple Silicon            | –                | –                  | signed pkg install (or embed the Swift package)                                                                                         | **One lightweight VM per container**: the strongest local isolation. But "memory pages freed… are **not relinquished to the host**", and macOS 15 lacks container-to-container networking. The Containerization Swift package can be embedded in the DorkOS app ("no extra binaries required"). |
| WSL2                                 | free; open source                                                                                                               | –                                              | ✓                | –                  | **Yes: enabling Virtual Machine Platform needs admin and a reboot**; virtualization must be on in BIOS; can be blocked by Intune or GPO | The only practical free path on Windows. `autoMemoryReclaim=gradual` gives memory back.                                                                                                                                                                                                         |
| Docker Engine (Linux)                | Apache-2.0                                                                                                                      | –                                              | inside WSL       | ✓                  | yes (root daemon)                                                                                                                       | Use it if present; prefer rootless Podman.                                                                                                                                                                                                                                                      |

### Recommendation: bundle the runner, do not require one

DorkOS defines a `BoxRunner` port (create, start, stop, exec-stdio, port-forward, volume export/import, stats) with these backends:

- **Linux (CLI and server):** rootless **Podman** (detect it, or install it through the distro package with a clear prompt). Fall back to an existing Docker Engine. Add gVisor `runsc` when available.
- **macOS (desktop app):** ship **Lima** inside the signed app with the `com.apple.security.virtualization` entitlement. Create one `dorkos` VM (vz, arm64) with Podman inside, and run one container per agent there. This works on macOS 13 to 26 with no admin prompt **[unverified: bundling details]**.
  - Offer an **Apple Containerization backend** (VM per agent) on macOS 26+ as the "stronger isolation" setting. Make it the default only once memory reclaim is fixed or idle boxes are stopped aggressively.
  - Do not use Lume/Cua for Linux boxes. It is a strong option later for the "macOS VM per agent" tier (max 2 per Mac, per Apple's licence).
- **Windows (desktop app):** ship a DorkOS Linux rootfs and run `wsl --import DorkOS <dir> rootfs.tar`. This avoids the Store and lets DorkOS control its distro and version. Run Podman inside it. Write `.wslconfig` advice (`autoMemoryReclaim=gradual`, a memory cap). The first run may need **one admin consent plus a reboot** to enable the Virtual Machine Platform. Say so plainly in onboarding. This is the one "admin hassle" that cannot be engineered away **[verified that admin is needed; corporate block rates unknown]**.
- **"Use what I have":** if Docker Desktop, OrbStack or Podman is already running, DorkOS can use it. The licence is then the user's own relationship, not a DorkOS requirement.

### Resources per desktop (estimates, flag all **[unverified]**, measure in the prototype)

| Component                                            | RAM                                                                                                                      | CPU                      | Disk                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------ |
| Xvfb + XFCE + streaming server, nobody watching      | ~300–500 MB                                                                                                              | ~0                       | –                              |
| webtop (Selkies, Alpine) as a third-party data point | "750 MB–1 GB… virtually zero CPU when idle"                                                                              |                          | ~400 MB base layer             |
| Chromium with 3–5 tabs                               | +0.6–1.5 GB                                                                                                              | bursts                   | profile 100–500 MB             |
| Claude Code CLI                                      | **~180 MB idle baseline** (claude-code issue #98420), but open issues show leaks to **6–16 GB** (#67433, #86267, #86712) | low (waits on the model) | ~200 MB binary                 |
| Codex CLI (Rust)                                     | lower than Claude Code                                                                                                   | low                      | small                          |
| Project builds (pnpm install, tsc, tests)            | spikes of 1–4 GB                                                                                                         | 1–4 cores while running  | node_modules 0.5–2 GB per repo |
| Video encode while a person watches                  | ~100–200 MB                                                                                                              | ~0.3–1 core at 1280×800  | –                              |
| Shared image (all boxes share its layers)            | –                                                                                                                        | –                        | ~2.5–4 GB once                 |
| Home volume per agent                                | –                                                                                                                        | –                        | 1–10 GB typical                |

**Planning figures:** ~1.5 GB for a typical active desktop, ~0.5 GB for an idle one with a closed browser, and a **hard cgroup cap of 4 GB per box**. With the cap, a runtime memory leak kills one box, not the laptop. Claude Code's open leak issues make the cap mandatory.

- **16 GB Mac:** macOS, the DorkOS app and the person's own apps use ~8–10 GB, leaving ~6 GB for boxes. That is **2–3 active desktops at once**, plus any number of stopped ones.
- **32 GB Mac:** ~18–22 GB for boxes, so **6–10 active desktops**.
- Kai's "10 agents" on 16 GB is **not** concurrently possible as full desktops. It needs scheduling: most agents stopped, woken per task.

**Idle sleep policy:**

- **Desktop on demand:** the box always exists, but the GUI processes (X server, window manager, Chromium, stream) start only when the agent asks for the screen or a person opens it. A shell-only turn needs ~200–400 MB instead of ~1.5 GB. This is the biggest single density lever.
- **Stop** a box (not pause or freeze) after N idle minutes. A frozen cgroup keeps its RAM, and on Apple's VM-per-container backend freed memory never returns to the host, so stopping is the only real reclaim. Cold start is a few seconds for the container, plus Chromium session restore.
- Keep the conversation on disk. A stopped box loses nothing that `--resume` needs.

---

## 5. Cloud side and moving between hosts

### Cloud hosts (2 vCPU / 4 GB box, 10 GB home)

| Host                                                        | Same OCI image?                                                                                            | Persistence and idle                                                                                                                                                 | Price (verified where marked)                                                                                                                                                                                     | Notes                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-host on any VPS with Podman** (the reference design) | ✓                                                                                                          | volume on local disk; idle costs the flat VPS price                                                                                                                  | Hetzner after the June 2026 increase: **CAX21 €10.49/mo, CAX31 €20.99, CX33 €8.49, CX43 €15.99** **[verified prices]**. Specs from memory: CAX21 = 4 arm64 vCPU / 8 GB, CAX31 = 8/16, CX33 = 4/8 **[unverified]** | 2–3 desktops on CAX21, ~6 on CAX31. Same code as local, so it also serves as **a hosted instance on plain arm64/amd64 VMs**. Hetzner raised prices twice in 2026; budget for more. |
| **Fly Machines**                                            | ✓ (OCI)                                                                                                    | volumes $0.15/GB-mo; stopped rootfs $0.15/GB-mo; **suspend** (Firecracker snapshot incl. memory) only for "≤ 2 GB memory and no swap"; volume fork for region moves  | performance-2x 4 GB **$0.0917/hr** (~$66/mo always on) **[verified]**                                                                                                                                             | **amd64 only.** "ARM isn't on their roadmap" (community, older thread).                                                                                                            |
| **Fly Sprites**                                             | ✗ **No custom image.** The create API takes only `name` and `url_settings`; the environment image is Fly's | warm pause (memory kept, 100–500 ms wake) → cold (processes dropped, 1–2 s); filesystem always durable; checkpoints are filesystem-only; DNS-allowlist egress policy | CPU $0.0385/CPU-hr, memory $0.021875/GB-hr, cold storage $0.000027/GB-hr (≈$0.02/GB-mo) **[verified on fly.io/pricing]**; fixed 8 vCPU, managed memory                                                            | Great economics for idle agents, but breaks "the same image everywhere". We would install our stack into it on first boot. Use only as an optional backend.                        |
| **E2B**                                                     | ✓ (template from a Dockerfile)                                                                             | pause saves the filesystem **and** memory (~4 s/GB pause, ~1 s resume); paused persists until killed                                                                 | $0.0504/vCPU-hr + $0.0162/GiB-hr (≈$0.17/hr for 2/4); **Pro $150/mo base**                                                                                                                                        | Desktop template exists (Apache-2.0). Self-host infra is heavy.                                                                                                                    |
| **Docker Cloud Sandboxes**                                  | ✓ (Kits are OCI)                                                                                           | **24 h max session**; paused is free; volumes and egress free                                                                                                        | Small 2 vCPU/4 GiB **$0.14/hr** **[verified]**                                                                                                                                                                    | Closed; the 24 h cap is bad for long-lived agents. Competitor.                                                                                                                     |
| **Daytona**                                                 | ✓                                                                                                          | –                                                                                                                                                                    | ~$0.05/vCPU-hr (2026-07 research)                                                                                                                                                                                 | Closed source since June 2026. Hosted backend at most.                                                                                                                             |
| **Kubernetes `agent-sandbox`** (SIG Apps)                   | ✓                                                                                                          | Sandbox CRD: stable identity, PVC, **pause/resume**, warm pools; `runtimeClassName` for gVisor or Kata; v1beta1; **GKE GA 2026-05-20**                               | cluster cost                                                                                                                                                                                                      | The right target once DorkOS Cloud needs multi-tenant scale. Apache-2.0.                                                                                                           |

### Moving a box: what to move and what breaks

**Do not use CRIU / `podman container checkpoint` for user-facing moves:**

- It needs root and a Linux host. It is not exposed through Docker Desktop, Apple `container` or WSL VMs in any supported way.
- The kernel and CPU features must match, and it **cannot cross architectures**.
- GPU state cannot be checkpointed ("A standard CRIU checkpoint captures none of GPU scheduling contexts…").
- Desktop stacks (X server, Chromium, the stream) are brittle under it.
- `--tcp-established` only works if the remote ends are still waiting.

Podman can export a checkpoint archive with volume contents, but that solves "same-cluster live migration", not "laptop → cloud". The valuable state, the conversation, is already on disk as transcripts, and the model's context lives on the provider side.

**What survives a cold move:** files, git repos (including uncommitted work), installed packages in the home, the Chromium profile (with `--password-store=basic`), runtime transcripts (so `claude --resume <id>` continues) and SQLite databases.

**What breaks, and the mitigation for each:**

| Breaks                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Running processes (dev servers, a half-finished `pnpm install`, open Chromium tabs)                       | Move only at a turn boundary. The runtime is told "you moved", and box services restart from definitions (the Sprites "Services" idea). Chromium restores its session.                                                                                                                                                         |
| Open network connections, IP address, hostname, `localhost` ports, preview URLs                           | Stable box hostname inside DorkOS (`<agent>.box`); previews reissued by the destination instance.                                                                                                                                                                                                                              |
| **CPU architecture**: Apple Silicon boxes are linux/arm64; Windows and most Linux boxes and Fly are amd64 | **Pin a box's architecture for life.** Cloud must offer _both_ arm64 (Hetzner CAX, Graviton, Axion) and amd64 hosts. A cross-arch move is a "re-home": copy the files, delete the native caches (node_modules, .venv, `~/.cache`), rebuild. Rosetta for Linux exists, but Rosetta 2 ends after macOS 27, so do not rely on it. |
| GPU                                                                                                       | Not provided in v1; software rendering.                                                                                                                                                                                                                                                                                        |
| Host mounts (a shared host folder)                                                                        | **A box with a host mount cannot move.** Say so in the UI ("This agent uses a folder on this computer, so it stays here"). Default flow is git clone into the box and push branches out.                                                                                                                                       |
| Website sessions bound to IP or location                                                                  | Some sites sign the agent out after a move. Expected; documented.                                                                                                                                                                                                                                                              |
| Clock, locale, machine-id-keyed caches                                                                    | Set them explicitly in the image.                                                                                                                                                                                                                                                                                              |

**Transfer times for a 2–10 GB home** (compressed with zstd ~1.5–3× for code-heavy homes, more for node_modules) **[estimates]**:

| Uplink              | 2 GB raw | 10 GB raw | Note                                         |
| ------------------- | -------- | --------- | -------------------------------------------- |
| 20 Mbps home upload | ~13 min  | ~67 min   | the reason a pre-synced replica is essential |
| 100 Mbps            | ~2.7 min | ~13 min   |                                              |
| 1 Gbps              | ~16 s    | ~80 s     | cloud ↔ cloud                                |

With **continuous background sync** to the destination store (content-addressed chunks, dedup, only changed chunks sent), a move costs one final delta, typically **seconds to a minute**. That is the design to build. Candidate engines: **kopia** (Apache-2.0) or **restic** (BSD-2), to any S3-compatible store; rclone (MIT) as the transport. For self-host object storage, prefer an Apache or MIT store such as SeaweedFS. MinIO and Garage are AGPL; that is fine to _run_ but should not be bundled carelessly **[licences of the stores from memory, unverified]**.

Images move separately and cheaply: push the image by digest to any OCI registry, or let the destination pull the public DorkOS base plus a small per-agent layer, if any. Pinning by digest means the destination runs byte-identical tools.

### The lease model (one host runs an agent at a time)

- Each agent has one **lease record**: `{agentId, holderInstanceId, epoch, arch, imageDigest, homeSnapshotId, state}`. It is kept by the agent's _owning_ instance. For an agent that has never moved, that is just the laptop; nothing in the cloud is required.
- **Fencing:** every box start, home sync write and relay subscription carries the epoch. The store refuses writes from a stale epoch, and the in-box agent daemon refuses to start a runtime without a current lease. This prevents split-brain when a laptop wakes up after its agent moved.
- **Move protocol:**
  1. Pre-sync until the delta is small.
  2. Request the move. The agent finishes or interrupts its turn at a tool boundary, and new triggers queue.
  3. Stop the box and take the final snapshot.
  4. The destination verifies the snapshot hash.
  5. The lease transfers (epoch + 1) and is recorded on both sides.
  6. The destination starts the box from the same digest.
  7. The runtime resumes the session.
  8. The source keeps a read-only copy for N days for rollback.
- **Offline laptop:** a move _to_ the cloud needs the laptop online at move time, or a recent synced snapshot plus an explicit "take over from snapshot X (loses changes since)". A move _back_ is the same protocol reversed.
- Relay and room membership follow the lease: messages for the agent route to the lease holder.

---

## 6. Security

**Isolation levels**, weakest to strongest:

- Plain container (shared kernel, namespaces and seccomp).
- **gVisor** (user-space kernel). Its own figures: "70% of applications… <1% overhead"; I/O-heavy work 10–30% slower. Used by GKE Agent Sandbox for multi-tenant work. arm64 supported.
- **Kata / Firecracker microVM** (hardware boundary). Firecracker ~125 ms boot and <5 MiB overhead; Kata 1–3 s and 50–100 MB.
- **Full VM per box** (Apple `container`, Docker `sbx`, Lume).

**Local default:** on Mac and Windows there is _already_ a VM between all boxes and the host (the Lima or WSL VM), so the host is protected by a hypervisor. Between agents, use gVisor where it works. Chromium inside gVisor may need `--no-sandbox` or user-namespace support **[unverified]**. Apple VM-per-box is the strong local option. On native Linux a box is only a container, so default to rootless Podman plus runsc.

**Cloud multi-tenant:** a minimum of gVisor, preferably Kata or Firecracker. Never plain containers between different customers.

**Network egress:** route all box traffic through a host-side proxy with a domain allowlist. The model to copy is Docker sbx's Open / Balanced / Locked Down modes, Sprites' DNS allowlist with a `defaults` include for GitHub, npm, PyPI and the AI APIs, and Anthropic's `sandbox-runtime` (Apache-2.0 npm `@anthropic-ai/sandbox-runtime`; bubblewrap on Linux; the network namespace removed and traffic only through proxies on Unix sockets). Anthropic's own computer-use guidance says to "limit internet access to an allowlist of domains" and to "avoid giving the model access to sensitive data". Default to Balanced. Block the cloud metadata IP (169.254.169.254) and host LAN ranges by default.

**Secrets injection (agent uses, never reads):**

- **Model APIs:** set `ANTHROPIC_BASE_URL` / the OpenAI base URL to the host proxy, which adds the real key or OAuth token per request. DorkOS already routes inference through a base URL for credits (`services/core/cloud/credits-inference.ts`), so the pattern exists.
- **Subscriptions:** Claude and ChatGPT logins create tokens the CLI wants to hold itself. Whether a subscription sign-in may run inside a hosted box at all is an open terms question (see `research/anthropic-tos-compliance.md`), so v1 defaults to an API key or credits for hosted boxes, with subscription sign-in offered only where the provider terms allow it.
- **git:** a credential helper that asks the host over a socket for a short-lived token per push, as VS Code dev containers do. Nothing is written to disk in the box.
- **Arbitrary HTTPS header injection:** this needs a MITM CA trusted inside the box. Allow it only for allowlisted hosts.
- **Secrets store:** the open-source vault decision from `research/20261006_secrets-vault-core.md` plugs in here. The proxy is the only reader.

**Viewer access:** never expose the stream port. Every viewer goes through the DorkOS server's auth, with a **one-time bootstrap URL** per viewer session (the OpenClaw pattern). The linuxserver images' "no authentication by default" is exactly the trap to avoid.

---

## 7. Does "the runtime runs inside the box" hold up?

**Yes, with five consequences to accept on purpose:**

1. **Transcript readers move.** Session listing (ADR-0310), message search indexing and session hydration read runtime stores from host paths today. With runtimes inside boxes they must read the box home. Locally that is a mounted path inside the VM, or a small in-box file API. Remotely it must go through the lease holder. This is real work across `services/runtimes/*` and `services/search`.
2. **The SDK driver stays on the DorkOS host. The CLI process runs in the box over an exec stdio pipe.** This keeps all DorkOS policy (permissions, approvals, tool gates, hooks) in the server, and needs no "DorkOS inside the box". The trade-off: when the DorkOS server restarts, the exec'd CLI dies, exactly as a local child does today. The tracked-spawn ledger must learn to reap in-box processes.
3. **DorkOS's MCP and relay must be reachable from inside the box**, through a host gateway address and a per-agent token. MCP auth is already fail-closed with per-user keys, so this is wiring, not new design.
4. **Agents lose implicit access to the person's files.** That is the point, but it changes Kai's workflow: the default becomes clone-in-box and push branches. A host-folder share is an explicit, visible exception that pins the agent to that computer. The worktree WorkspaceProvider becomes "git checkout inside the box".
5. **Cost at the low end.** One extra VM layer on Mac and Windows, ~0.5–1.5 GB per active desktop, and a first-run install step on Windows. "Desktop on demand" plus stop-when-idle keeps this tolerable.

**Prior art agrees.** Docker sbx (the agent runs in a microVM; the move copies the filesystem; the proxy injects credentials), Cua Spaces (a desktop per agent, local and cloud, watch and step in) and Fly Sprites (a persistent per-agent Linux computer; disk persists, memory does not) all landed on the same shape in 2026. DorkOS's difference has to be: **open source, local and free by default, multi-runtime, one move path between your own instances**, not the box itself.

---

## 8. Recommended stack

| Layer                  | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                             | Why                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Base image**         | `debian:trixie-slim` (or Ubuntu 24.04), built multi-arch by DorkOS. X11: Xvfb (or Xorg-dummy for RandR resize), XFCE, at-spi2-core, xdotool, scrot/XShm, PulseAudio optional; Chromium; Node 22, pnpm, python3, git, gh, ripgrep, build-essential; Claude Code native binary, Codex binary, OpenCode binary; a small `dorkos-boxd` init and agent daemon (lease check, services, file API, computer MCP). Non-root `agent` user; home on a volume. | Own the image: licence-clean (no GPL-3 scripts), X11 for tooling, digest-pinned, same on all hosts.   |
| **Streaming**          | **Selkies** (MPL-2.0), WebSocket transport, proxied by the DorkOS server with per-viewer one-time URLs; **noVNC + x11vnc** fallback; stream only while someone watches                                                                                                                                                                                                                                                                             | Passes through the existing HTTP tunnel; software encoding is fine at 1280×800; WebRTC later for LAN. |
| **Control API**        | In-box **computer MCP** (Anthropic toolset actions plus an AT-SPI tree; learn from or vendor `cua-driver`, MIT) + **Playwright MCP via CDP** on the visible Chromium + the runtime's native shell and file tools; a DorkOS-held **control token** for human takeover                                                                                                                                                                               | One computer, one browser, visible to both.                                                           |
| **Runtime placement**  | CLI inside the box; SDK on the DorkOS host via `spawnClaudeCodeProcess` → exec stdio; Codex via a `codexPathOverride` wrapper; OpenCode sidecar in the box via port forward                                                                                                                                                                                                                                                                        | Smallest change to today's runtimes; policy stays in the server.                                      |
| **Local runner**       | `BoxRunner` port. **Linux:** rootless Podman (+runsc). **macOS:** bundled Lima VM + Podman; Apple Containerization as the macOS 26+ VM-per-agent option. **Windows:** `wsl --import` DorkOS distro + Podman. Use existing Docker or OrbStack only if present.                                                                                                                                                                                      | Free for companies, no Docker Desktop licence, one engine (Podman) everywhere.                        |
| **Cloud host**         | A hosted instance on plain arm64/amd64 VMs (e.g. Hetzner CAX/CX), **both arm64 and amd64 pools**, Podman + gVisor. Later: Kata or Firecracker, or K8s `agent-sandbox`. Optional backends: Sprites, E2B.                                                                                                                                                                                                                                            | Self-host parity by construction; arch-matched moves.                                                 |
| **Move mechanism**     | Lease with an epoch fence; continuous kopia/restic-style chunk sync of the home to S3-compatible storage; image by digest via any OCI registry; cold move at a turn boundary; `--resume`; a rollback copy                                                                                                                                                                                                                                          | Proven shape (sbx, Sprites); fast final delta; no CRIU.                                               |
| **Security defaults**  | Host VM boundary + gVisor between boxes; 4 GB cgroup cap; Balanced egress allowlist through a host proxy; base-URL credential injection; git credential helper over a socket; no host mounts by default                                                                                                                                                                                                                                            | Matches Anthropic's computer-use guidance and Docker sbx.                                             |
| **Interop (optional)** | Read and write Docker's **Sandbox Kit spec v3** (Apache-2.0, OCI, going to the CNCF) for box definitions                                                                                                                                                                                                                                                                                                                                           | A free path to "bring your own kit"; hedges against Docker defining the standard.                     |

---

## 9. Top 5 risks

1. **The laptop resource ceiling.** Full desktops cost ~1.5 GB each when active. A 16 GB Mac runs 2–3 at once. Claude Code has open idle memory-leak issues growing to 6–16 GB, and Apple's VM-per-container backend never returns freed memory. _Mitigation:_ desktop on demand, stop when idle, a hard 4 GB cap per box, and honest "N agents can work at once on this computer" copy.
2. **First-run setup friction across OSes.** Windows needs admin plus a reboot to enable the Virtual Machine Platform, can be blocked by corporate policy, and needs virtualization on in BIOS. Apple `container` needs macOS 26. Bundling Lima inside a signed Electron app is unproven here. Any install failure strands the core promise ("every agent has a computer"). _Mitigation:_ a fallback ladder (the existing host-shell mode stays available as "no box"), a preflight check, and clear copy.
3. **Architecture mismatch on moves.** Apple Silicon boxes are arm64. Fly Machines are amd64-only. Windows and Linux PCs are mostly amd64. A naive move breaks native dependencies. _Mitigation:_ pin the arch per box, run arm64 and amd64 cloud pools, and treat a cross-arch move as a re-home with a rebuild. Rosetta ends after macOS 27.
4. **Credentials inside boxes.** Proxy injection works cleanly for API keys. Subscription OAuth (Claude, ChatGPT) and arbitrary websites are harder. Running a person's subscription token on DorkOS Cloud servers may raise provider-terms questions **[unverified]**. A leak here, or prompt-injected exfiltration through open egress, is the worst failure. _Mitigation:_ Balanced egress by default, base-URL injection, a git helper, and a terms review before Cloud launch.
5. **Isolation and licence traps, plus the scope of the internal rewrite.** Plain containers on native Linux share the host kernel. Chromium under gVisor is unverified. Stream ports must never be exposed. Tempting components carry restrictive licences: Kasm CE (non-commercial), Cua Spaces (FSL, no competing hosted service), Daytona (closed, AGPL), linuxserver (GPL-3 scripts). Moving the runtime into the box also forces changes to transcript readers (ADR-0310, search), tracked-spawn reaping, MCP and relay reachability, the WorkspaceProvider, and the in-flight darwin host-browser work in `packages/browser`. _Mitigation:_ own the image, prototype gVisor with Chromium early, and re-scope `packages/browser` now.

### Unverified items to settle in a prototype

- Real RSS per desktop (XFCE, Chromium, Selkies) and the encode CPU while watched.
- Lima bundled in the signed app without admin; the vz memory balloon behaviour.
- Selkies' X11 capture mode and how it arbitrates input between multiple viewers.
- Chromium inside gVisor on arm64.
- `--password-store=basic` profile portability across hosts.
- Subscription-token handling behind a proxy and the provider terms for cloud use.
- Sprites' CPU architecture and whether custom images will ever be allowed.
- Hetzner instance specs (from memory).
- Whether the linuxserver KasmVNC bases are formally retired (conflicting signals).
- Codex's own computer-use support inside Linux (not researched).

---

## Sources

Repo:

- `research/20260717_cloud-sandbox-workspace-provider.md`
- `research/20260721_vercel-sandbox-agent-execution.md`
- `research/20261001_shared-browser-control.md`
- `packages/browser/` (package.json, `src/runtime/darwin-*`, `src/runtime-descriptor.ts`)
- `apps/server/src/services/runtimes/claude-code/sessions/tracked-spawn.ts`
- Claude Agent SDK 0.3.280 `sdk.d.ts` (`spawnClaudeCodeProcess`, `SpawnedProcess`, `SpawnOptions`)
- `@openai/codex-sdk` 0.154 (`codexPathOverride`, `env`)
- `packages/shared/src/workspace.ts` (`WorkspaceProvider`)

Desktops and streaming:

- https://github.com/linuxserver/docker-baseimage-kasmvnc
- https://github.com/linuxserver/docker-webtop
- https://github.com/linuxserver/docker-baseimage-selkies
- https://www.linuxserver.io/blog/webtop-2-0-the-year-of-the-linux-desktop
- https://github.com/kasmtech/KasmVNC/blob/master/LICENSE.TXT
- https://kasm.com/community-edition , https://docs.kasm.com/docs/reference/license
- https://github.com/m1k1o/neko , https://neko.m1k1o.net/docs/v3/configuration/webrtc , https://neko.m1k1o.net/docs/v3/release-notes
- https://github.com/selkies-project/selkies , https://docs.selkies.io/
- https://github.com/novnc/noVNC/blob/master/LICENSE.txt , https://github.com/TigerVNC/tigervnc , https://github.com/Xpra-org/xpra , https://github.com/Xpra-org/xpra-html5
- https://github.com/e2b-dev/desktop , https://e2b.dev/docs/template/examples/desktop
- https://github.com/trycua/cua , https://spaces.cua.ai/ , https://cua.ai/
- https://github.com/CopilotKit/openmuse
- https://github.com/daytonaio/daytona , https://github.com/nightona-co/nightona
- https://github.com/openclaw/openclaw/blob/main/Dockerfile.sandbox-browser , https://github.com/canyugs/openclaw-sandbox-browser , https://docs.openclaw.ai/gateway/config-agents/sandbox
- https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/Dockerfile
- https://github.com/bytebot-ai/bytebot
- https://github.com/simular-ai/Agent-S
- https://github.com/steel-dev/steel-browser

Driving the box:

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- https://github.com/liufeicc/cc-computer-use , https://github.com/nisavid/computer-use-linux , https://github.com/TopherMayor/open-computer-use
- https://www.morphllm.com/install-claude-code , https://continuumcode.ai/guides/install-claude-code-linux/
- https://continuumcode.ai/guides/codex-cli-login/ , https://codex.danielvaughan.com/2026/04/01/codex-cli-authentication-flows-credential-management/
- https://github.com/anthropics/claude-code/issues/98420 , https://github.com/anthropics/claude-code/issues/67433 , https://github.com/anthropics/claude-code/issues/86267 , https://github.com/anthropics/claude-code/issues/86712

Local runners:

- https://gcn.com/docker-desktop-ships-free-every-developer/21055/ , https://www.macrostack.net/pricing/docker-desktop
- https://orbstack.dev/pricing , https://orbstack.dev/docs/faq
- https://podman-desktop.io/docs/installation/windows-install , https://releasebot.io/updates/podman
- https://github.com/abiosoft/colima , https://jeffbailey.us/blog/2026/01/31/what-is-lima/
- https://github.com/apple/container , https://github.com/apple/container/blob/main/docs/technical-overview.md , https://www.helpnetsecurity.com/2026/07/07/apple-container-open-source-linux-mac/ , https://www.opensourceforu.com/2026/06/apple-launches-container-to-run-linux-containers-inside-micro-vms-on-mac/
- https://github.com/apple/containerization , https://developer.apple.com/videos/play/wwdc2025/346/
- https://learn.microsoft.com/en-us/windows/wsl/troubleshooting , https://www.praveentechworld.com/blog/why-wsl2-vmmem-wont-free-ram-auto-memory-reclaim-fix
- https://www.osnews.com/story/145279/macos-27-drops-intel-support-will-be-last-release-with-rosetta-2/
- https://zread.ai/linuxserver/docker-webtop (webtop RAM figure, secondary)

Cloud and moving:

- https://docs.fly.io/sprites/ , https://docs.fly.io/sprites/concepts/lifecycle.md , https://docs.fly.io/sprites/concepts/checkpoints.md , https://docs.fly.io/sprites/concepts/networking.md , https://docs.fly.io/sprites/api/sprites/create-a-sprite.md , https://fly.io/pricing/
- https://fly.io/docs/reference/suspend-resume/ , https://fly.io/docs/reference/machine-migration/ , https://community.fly.io/t/are-arm64-fly-machines-available/5902
- https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- https://www.beam.cloud/blog/e2b-pricing-explained , https://github.com/e2b-dev/e2b
- https://www.docker.com/products/docker-sandboxes/ , https://docs.docker.com/ai/sandboxes/ , https://www.docker.com/blog/introducing-cloud-sandboxes-start-on-your-laptop-finish-in-the-cloud/ , https://www.how2shout.com/ai/docker-cloud-sandboxes-pricing-agents.html , https://collabnix.com/docker-at-wearedevelopers-2026-cloud-sandboxes-open-kits-and-cncf/ , https://www.innoq.com/en/blog/2026/07/trust-but-sandbox/ , https://www.ajeetraina.com/10-things-you-must-know-about-docker-sandboxes/
- https://github.com/kubernetes-sigs/agent-sandbox , https://agent-sandbox.sigs.k8s.io/docs/
- https://criu.org/Podman , https://oneuptime.com/blog/post/2026-03-18-migrate-container-between-hosts-podman-checkpoint/view , https://www.devzero.io/blog/gpu-container-checkpoint-restore

Security:

- https://gvisor.dev/docs/architecture_guide/performance/ , https://northflank.com/blog/how-to-sandbox-ai-agents , https://bex.co/blog/2026/09/22/gvisor-vs-kata-vs-firecracker-agent-sandbox-isolation
- https://github.com/anthropic-experimental/sandbox-runtime
