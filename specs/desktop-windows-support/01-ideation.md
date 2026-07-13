---
title: Windows desktop support
slug: desktop-windows-support
stage: ideate
created: 2026-07-12
---

# Windows desktop support — ideation

## Problem

The DorkOS desktop app ships today for **macOS / Apple Silicon only**
(`v0.46.0`, signed + notarized, verified by a real end-user install). Windows is
the single largest developer desktop platform, and DorkOS's launch persona (Kai —
a senior dev running many agents) is heavily represented there. The marketing
site already carries a placeholder "Windows" note under "Other ways to install"
but has no artifact behind it. We want a real, installable, auto-updating Windows
build riding the same unified `vX.Y.Z` release train the macOS build already uses.

## Validated assumptions (research, 2026-07-12)

All prior-session assumptions were checked against npm and the codebase before
committing to this plan:

- **Runtime binaries exist.** `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.177`
  and `-win32-arm64@0.3.177` are published; `@openai/codex-win32-x64` (aliased
  `@openai/codex@0.144.1-win32-x64`) exists. The two native addons
  (`better-sqlite3`, `node-pty`) resolve Windows prebuilds through
  `@electron/rebuild` / `prebuild-install` the same way they do on macOS.
- **Main-process platform coupling is small and already partly guarded.**
  `menu.ts` (Dock menu) and `index.ts` (`window-all-closed`) already branch on
  `process.platform`. The one real gap is **deep links**: `dorkos://` is wired
  only through the macOS-only `app.on('open-url')` event; Windows delivers the
  URL via `process.argv` (cold start) and the `second-instance` argv (warm), and
  the current `second-instance` handler ignores argv.
- **The auto-updater is already platform-agnostic.** `auto-updater.ts` uses
  `electron-updater`'s generic `autoUpdater`, which selects `NsisUpdater`
  (reading `latest.yml`) on Windows automatically. The only requirement is that
  the Windows build publish `latest.yml` + the `.exe` alongside the release.
- **The site download path generalizes cleanly.** `lib/desktop-download.ts` +
  `/download/mac/route.ts` already walk GitHub releases for a `.dmg`; a Windows
  route mirrors this for `.exe`.
- **The icon source is present.** `apps/desktop/build/icon.svg` is the vector
  source (macOS uses the derived `icon.icns`); a Windows `icon.ico` is generated
  from it — no new asset design needed.

## Code signing — the one genuine business decision

Windows code signing is the only part of this work that cannot be done
autonomously: it requires spending money and validating a legal entity (Blaze
Ventures, LLC). The signing options, their friction, and the recommendation are
captured in the specification. **The build infrastructure is fully independent
of signing** — an unsigned NSIS installer builds and auto-updates today; signing
is a bolt-on that raises SmartScreen trust later. We therefore ship an
**unsigned alpha first** and track signing as a separate, business-gated
follow-up, exactly mirroring how the platform (not the trust) shipped first.

## Scope decisions

- **x64 only** for the first Windows build (matches the pragmatic "arm64-only"
  stance on macOS; x64 runs under emulation on Windows-on-ARM). `win32-arm64` is
  a tracked follow-up once x64 is proven.
- **NSIS installer** (required for `electron-updater` auto-updates); no portable
  target initially.
- **Unsigned** initially; SmartScreen guidance shown to users; signing tracked
  separately.
- **Honesty gate.** Per the demo-claim gate in AGENTS.md, Windows is described as
  **alpha / unverified** in user-facing copy until a real end-user install is
  confirmed (mirroring how macOS was gated until Dorian's install).
