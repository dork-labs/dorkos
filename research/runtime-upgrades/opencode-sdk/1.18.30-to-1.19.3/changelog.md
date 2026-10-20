# @opencode-ai/sdk Changelog: 1.18.30 → 1.19.3

**Generated**: 2026-10-20
**Sources**: npm registry (`registry.npmjs.org/@opencode-ai/sdk`, `.dist-tags`/`.versions`), GitHub Releases (`sst/opencode`, `gh api repos/sst/opencode/releases`), packed-tarball `.d.ts` diff (1.18.30 vs 1.19.3)
**Releases covered**: 9 (v1.18.31 .. v1.19.3); the repo ships no `CHANGELOG.md`, so GitHub Releases is the only prose source (matches `runtime-deps.json`'s note)

Current resolved version (`pnpm-lock.yaml`): **1.18.30** (declared `^1.18.30` in `apps/server`, `packages/cli`, `apps/desktop`). Target: **1.19.3**, the `latest` dist-tag for both `@opencode-ai/sdk` and the sidecar package `opencode-ai` (confirmed equal — no drift between the two channels). Every other active npm dist-tag is a `0.0.0-snapshot-*`/`beta`/`next`/`dev`/`ci` channel; per the config's standing rule, none of those is ever a resolution target.

## Breaking Changes 🔴

**None reachable.** A full `.d.ts` diff of the packed 1.18.30 tarball against 1.19.3 touches exactly two files out of 79: `package.json` (version bump only) and `dist/v2/gen/types.gen.d.ts` (the `/v2` subpath DorkOS does not import — see below). Every file reachable from a bare `@opencode-ai/sdk` import — `index.d.ts`, `client.d.ts`, `server.d.ts`, `process.d.ts`, `error-interceptor.d.ts`, `gen/types.gen.d.ts`, `gen/sdk.gen.d.ts`, `gen/client.gen.d.ts`, everything under `gen/core/` and `gen/client/` — is byte-for-byte identical. The `Event` union is unchanged, `Part` is unchanged, and all 17 named types DorkOS imports (`OpencodeClient`, `Event`, `GlobalEvent`, `AssistantMessage`, `SessionStatus`, `Todo`, `ToolPart`, `FilePart`, `Session`, `Message`, `Part`, `SessionMessagesResponse`, `ProviderListResponse`, `McpStatus`, `McpLocalConfig`, `McpRemoteConfig`, plus `createOpencodeClient`) are unchanged.

### `/v2` type changes (unreachable)

- `GET /v2/.../config` schema gains an optional `reasoning_options` array (model reasoning-variant controls: `effort`/`toggle`/`budget_tokens` shapes) — new field only, additive.
- The `update` config field's TSDoc description changed from "Automatically update to the latest version..." to "Check for new versions and show an update notice. Updates are never installed automatically..." — reflects the v1.19.0 behavior change below, but the field itself and its type (`boolean | 'notify'`) are unchanged.

Confirmed zero imports of `@opencode-ai/sdk/v2` (or any subpath) anywhere in `apps`, `packages`, or `scripts`; DorkOS provisions the sidecar itself via `npm install opencode-ai@<pin>` (`providers/provision.ts:121`) and never calls `global.upgrade` or any v2-only route. No action.

## Deprecations 🟡

None.

## New Features 🟢

### v1.19.0 — `opencode upgrade --major` (OpenCode 2 opt-in)

- A new explicit major-upgrade path exists (`opencode upgrade --major`, and a "2.0 offer" surfaced through `/update`). **Opt-in only** — confirmed by v1.19.2's own fix note: "OpenCode 1 now stays on the 1.x release line: update checks use only the npm `opencode-ai` latest version, so 1.x installs are never offered a 2.x build as a regular update." The `opencode-ai` `latest` dist-tag itself still resolves to `1.19.3` (verified live), not a 2.x build. DorkOS provisions an explicit exact version via `npm install opencode-ai@<pin>` (never `opencode upgrade`/`latest`-tracking auto-update), so this path is not reachable by the provisioned sidecar regardless.

### v1.19.0 — Automatic updates removed from the TUI

- "Use `/update` to install OpenCode updates... updates are no longer installed automatically." This is the shipped sidecar's own self-update behavior (irrelevant to DorkOS, which never runs the TUI and provisions/pins its own sidecar copy outside any auto-update mechanism).

### v1.19.3 — Configurable model reasoning variants

- "Configure model reasoning options to generate reasoning variants, replacing catalog variants while preserving your configured variant overrides." Config-file feature (`reasoning_options`, the new `/v2` field above); no SDK client method changed. Relevance: low (see impact assessment).

## Bug Fixes 🔧

- **v1.18.31**: Restored ACP session model/effort/mode/reasoning chunk boundaries on load/resume/fork. (ACP = Agent Client Protocol, a separate integration surface DorkOS doesn't use — opencode's IDE-extension protocol, not the HTTP API.)
- **v1.18.31**: TUI shows remote-config auth errors at startup and exits non-zero. TUI-only.
- **v1.18.31**: Extensions — adaptive thinking requested for GitHub Copilot models (provider-specific, server-side).
- **v1.18.32**: Bedrock image attachments now only hoisted for Claude/Nova/Llama 4 models; Together AI streaming usage reporting fixed.
- **v1.18.33**: Cloudflare AI Gateway timeouts honored; MCP browser-launch failures now reported (DorkOS doesn't use opencode's own MCP browser launcher — it registers its own managed MCP servers via `client.mcp.add`); debug output redacts credentials; Gemini thinking-effort defaults fixed.
- **v1.18.34**: Namespaced session/parent-session identity headers sent with model requests (server-internal); macOS binary re-signing/signing fixes (desktop/CLI distribution, not the SDK).
- **v1.18.35**: Agent-readable stats gain canonical redirects + JSON/Markdown formats (docs-site feature, not API); xAI tool-result image handling fixed.
- **v1.19.0**: OpenAI `ultrafast` service tier allowed; PTY connection origin/ticket validated before PTY existence check (opencode's own terminal feature — DorkOS's `computer/` directory speaks its own PTY surface via a separate `computer` HTTP route, not this one; no shared code path, confirmed by grep — no `pty`/`PTY` identifiers anywhere in `apps/server/src/services/runtimes/opencode/`).
- **v1.19.1**: **Session sharing discontinued** — existing public share links and the share/unshare commands no longer work, and importing from a share URL is unsupported. Confirmed zero calls to `client.session.share`/`.unshare`/any `shareUrl`/`share_url` identifier anywhere in the opencode runtime directory — DorkOS never exposed this upstream feature. No action.
- **v1.19.2**: 1.x install channel stays pinned to 1.x for update checks (see Features above); yarn-managed upgrade fix; Homebrew Core/tap/Chocolatey update-check fixes; install script refuses 2.x. All self-update mechanics DorkOS's provisioning never invokes.
- **v1.19.3**: (listed under Improvements above — the reasoning-variant config feature.)

## Performance ⚡

None noted in this range.

## Internal ⚪

- Numerous community-contributed docs additions (model catalog entries for Zen/Go), a `gitlab-ai-provider` dependency bump, a `@ai-sdk/gateway` bump, a `@ai-sdk/xai` bump — all server-internal provider plumbing with no DorkOS-visible surface.

## Companion

See `impact-assessment.md` in this directory for the codebase-impact analysis.
