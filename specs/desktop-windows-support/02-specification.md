---
title: Windows desktop support
slug: desktop-windows-support
id: 260713-014129
stage: specify
created: 2026-07-12
---

# Windows desktop support — specification

Ship a real, installable, auto-updating **Windows x64** desktop build of DorkOS,
riding the existing unified `vX.Y.Z` release train. Unsigned for the pre-launch
alpha; signing is a business-gated follow-up.

## Goals

1. `pnpm --filter @dorkos/desktop dist --win` (and the CI equivalent on
   `windows-latest`) produces a working **NSIS installer** (`.exe`) plus the
   `latest.yml` update manifest and a `.zip`/blockmap as electron-builder emits.
2. The packaged Windows app launches, serves the cockpit over localhost, runs a
   Claude Code session (bundled `claude` binary present + runnable), and the
   embedded terminal (node-pty) and SQLite (better-sqlite3) work.
3. `dorkos://` deep links work on Windows (cold-start argv + warm
   `second-instance` argv), matching macOS behavior.
4. `electron-updater` auto-updates work on Windows (NSIS differential updates via
   `latest.yml`).
5. `dorkos.ai` offers a first-class **Download for Windows** path: a
   `/download/windows` route, an OS-adaptive install hero for Windows visitors,
   and an OS-aware nav Download button — matching the download-first treatment
   macOS already has.
6. Honest copy: Windows is labeled **alpha** until a real end-user install is
   confirmed (demo-claim gate, AGENTS.md).

## Non-goals (tracked follow-ups, not this spec)

- **Code signing** (see decision below) — separate, business-gated.
- **win32-arm64** — x64 first; arm64 once x64 is proven.
- **Portable / MSIX / winget** distribution — NSIS only for now.
- **Linux desktop** — out of scope.

## Decision: signing

**Ship unsigned for the alpha; adopt Azure Artifact Signing (formerly Azure
Trusted Signing) as the follow-up when we move Windows from alpha to public.**

Rationale (research 2026-07-12, see `01-ideation.md` and the full report):

- **EV certificates no longer grant instant SmartScreen reputation** (Microsoft
  removed that in March 2024) — the historic reason to buy EV is gone.
- **OV certs** require a FIPS 140-2 hardware token that **cannot be used on
  GitHub-hosted CI runners**, and only reach parity with a cloud-HSM add-on.
- **Azure Artifact Signing** (GA April 2026): $9.99/mo Basic, no hardware token,
  headless on `windows-latest` via `azure/login` OIDC + the official
  `Azure/trusted-signing-action`, and wired into electron-builder 26.x through
  `win.azureSignOptions`. The prior 3-year org-age eligibility requirement was
  **dropped at GA**; Blaze Ventures, LLC (US) is eligible whenever we invest.
- For the alpha audience (developers who click "More info → Run anyway"), the
  unsigned SmartScreen prompt is tolerable friction, not a credibility blocker;
  even signed builds must earn per-hash SmartScreen reputation through download
  volume, so signing does not remove the warning on day one anyway.

**Follow-up (do not start here):** enroll Blaze Ventures, LLC in Azure Artifact
Signing, wire `win.azureSignOptions` + OIDC into the workflow behind an
`AZURE_SIGNING_CONFIGURED` var (mirroring the existing `APPLE_DEVELOPER_CONFIGURED`
gate), and re-verify. This needs a spend decision from Dorian.

## Decomposition (4 chunks)

Chunks A/B/C are independent — they live in **different top-level directories**
(`apps/desktop`, `.github`, `apps/site`), so they run as parallel isolated
worktrees with no merge conflicts. Chunk D lands after A–C.

### Chunk A — Desktop: Windows packaging + runtime (`apps/desktop`)

The heart of the work. One agent, one worktree.

1. **electron-builder.yml**: add a `win` target block —
   `target: [{ target: nsis, arch: [x64] }]`, `icon: build/icon.ico`. Add an
   `nsis` block: `oneClick: false`, `perMachine: false` (per-user install, no
   admin elevation — best default for a dev tool), `allowToChangeInstallationDirectory: true`,
   `artifactName: DorkOS-${version}-${arch}.exe`. Extend `asarUnpack` with the
   Windows SDK binary glob
   (`**/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**`). Keep the
   existing mac block untouched. Update the header comment that warns about
   per-arch SDK binaries to reflect that win32-x64 is now handled.
2. **build/icon.ico**: generate a multi-resolution `.ico` (16–256px) from
   `build/icon.svg` and commit it. Use a scripted, reproducible conversion (e.g.
   `sharp` SVG→PNG then `png-to-ico`, or `rsvg-convert` + ImageMagick) — document
   the command in `build/README.md`. **Do not hand-wave a binary asset**; it must
   render correctly at small sizes.
3. **package.json**: add `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.177` to
   `optionalDependencies` (version-locked to the SDK, exactly as the darwin-arm64
   entry is). `@openai/codex-win32-x64` is pulled transitively by `@openai/codex`'s
   own optionalDependencies — verify it lands in the packaged tree; add it
   explicitly only if packaging drops it.
4. **scripts/rebuild-natives.ts**: already `process.arch`-parameterized; verify it
   works when invoked on Windows (it fetches per-ABI prebuilds via
   `@electron/rebuild`). Adjust only if a Windows-specific path/shell assumption
   surfaces.
5. **src/main/server-process.ts**: the SDK binary path currently hardcodes
   `claude-agent-sdk-darwin-arm64`. Make it resolve the correct
   `claude-agent-sdk-<platform>-<arch>` package for the running platform (and the
   `claude`/`claude.exe` executable name). This is what lets the packaged Windows
   app find a runnable Claude Code.
6. **src/main/index.ts + navigation.ts**: add Windows deep-link delivery.
   `app.on('open-url')` is macOS-only. On Windows: parse `process.argv` for a
   `dorkos://` URL at cold start, and parse the `argv` passed to the
   `second-instance` handler (currently ignored) when warm — route both through
   the existing `parseDeepLink` + navigation path. Guard the macOS `open-url`
   wiring so it stays mac-only. `app.setAsDefaultProtocolClient` is already
   cross-platform.
7. **Tests**: extend the existing `__tests__` (navigation/index) with
   Windows-argv deep-link cases; keep the electron mock. `menu.ts` /
   `window-manager.ts` — audit for any remaining mac-only assumption that would
   break a Windows launch; the `window-all-closed` quit branch is already correct.
8. **Changelog fragment** under `changelog/unreleased/`.

### Chunk B — CI: Windows build job (`.github/workflows/desktop-release.yml`)

One agent, one worktree. Add a `build-windows` job alongside `build-macos`:

- `runs-on: windows-latest`, same Node 24 + pnpm setup, same
  `turbo build --filter=@dorkos/desktop`, then the native rebuild step, then
  `npx electron-builder --win --x64 --config electron-builder.yml --publish never`.
- **Unsigned only** for now: no signing env. Leave a clearly-commented seam
  (`if: vars.AZURE_SIGNING_CONFIGURED == 'true'`) mirroring the mac
  `APPLE_DEVELOPER_CONFIGURED` split, so the signing follow-up is a drop-in.
- Upload the `.exe` + `latest.yml` (+ blockmap) as a build artifact, and add the
  same **attach-only** `gh release upload --clobber` step (reusing the existing
  poll-for-release pattern) to attach the Windows assets to the `vX.Y.Z` release.
  `latest.yml` is required or `electron-updater` NSIS update checks 404.
- Preserve the fail-soft/attach-only invariants documented in the workflow
  header; update that header comment to cover both platforms.
- **Note the review caveat**: workflow changes are not auto-reviewed by the bot
  and only take effect after merge to `main` — the reviewer agent must review
  this manually, and verification runs via `workflow_dispatch` post-merge.

### Chunk C — Site: Windows download (`apps/site`)

One agent, one worktree.

1. **lib/desktop-download.ts**: generalize from dmg-only to a per-asset-suffix
   lookup (`.dmg` / `.exe`), or add a sibling `findLatestExeDownloadUrl`. Keep the
   "newest release carrying the asset" semantics and the 5-min revalidation.
2. **app/download/windows/route.ts**: mirror `/download/mac` — 302 to the newest
   `.exe`, 503 with a plain-text body when none exists yet.
3. **InstallMoment.tsx**: Windows visitors get a **Download for Windows** hero
   (mirroring the Mac `DownloadHero` + `TerminalPeerCommand` peer pattern already
   shipped in #263); the terminal path stays a quiet peer; the "Other ways to
   install" disclosure updates so the Windows note becomes a real download link.
   Use `usePlatform()` (extend it to distinguish `windows` if it currently only
   returns `mac`/`other`/`unknown`).
4. **MarketingHeader.tsx**: OS-aware nav button also resolves Windows →
   `/download/windows`.
5. **analytics.ts**: add the Windows download placement to the
   `DownloadPlacement` union + `trackHeroDownload`.
6. **Honesty**: label the Windows download **alpha** until a real install is
   verified (small "alpha" tag / helper line), per the demo-claim gate.
7. Update/extend the existing `__tests__` (InstallMoment, MarketingHeader,
   desktop-download).
8. **Changelog fragment**.

### Chunk D — Docs, AGENTS.md, changelog reconciliation (after A–C merge)

One agent (docs prose — may run in `main` per the worktree rules, or a worktree).

- Docs: any "macOS only" language in `docs/` that should now mention a Windows
  alpha; SmartScreen "Run anyway" guidance for first launch.
- **AGENTS.md** product-state paragraph: note the Windows alpha exists but is
  **unverified** (not yet confirmed by a real end-user install) — do NOT claim it
  works until verified, exactly as the demo-claim gate requires.
- Ensure changelog fragments from A–C read cleanly together.

## Verification

Windows packaging **cannot be verified locally** (no Windows host; the build must
run on `windows-latest`). The proof is:

1. After Chunks A + B merge to `main`, trigger the desktop-release workflow via
   `workflow_dispatch` with `dry_run=true` and confirm the `build-windows` job
   builds + packages the NSIS `.exe` + `latest.yml` green.
2. Full end-to-end (launch, session, terminal, deep link, auto-update) requires a
   Windows machine — tracked as a real-user QA follow-up (mirroring DOR-230 for
   macOS). Until that passes, Windows stays **alpha / unverified** in all copy.

## Review

Every chunk is implemented in an isolated worktree and **reviewed by a separate
agent against `REVIEW.md`** before merge. The workflow chunk (B) gets a manual
REVIEW.md pass since the review bot does not run on workflow-editing PRs.
