# Impact Assessment: @opencode-ai/sdk 1.18.30 → 1.19.3

**Generated**: 2026-10-20
**Codebase root**: `apps/server/src/services/runtimes/opencode/`
**Abstraction boundary**: `AgentRuntime` interface; `@opencode-ai/sdk` import is ESLint-confined to this directory (Hard Rule 2)
**Related ADRs**: 0255 (per-session runtime binding, first-write-wins), 0308 (managed `opencode serve` sidecar), 0310 (runtime-owned session storage)
**Companion**: `changelog.md` in this directory

## Summary

| Category                              | Count | Action Required                                            |
| ------------------------------------- | ----- | ---------------------------------------------------------- |
| Breaking changes (our surface)        | 0     | —                                                          |
| Breaking changes (`/v2`, unreachable) | 2     | None — subpath unused                                      |
| Deprecations                          | 0     | —                                                          |
| Server-side behavioral changes        | 2     | Both confirmed unreachable by grep; no verification needed |
| Features (high relevance)             | 0     | —                                                          |
| Features (medium/low relevance)       | 1     | Informational only; no code change                         |
| Bug fixes touching our surface        | 0     | None of the 9 releases' fixes land in code DorkOS calls    |
| **Required code changes**             | **1** | Manifest pins ×3 + `OPENCODE_PACKAGE_VERSION` (mechanical) |

**Overall upgrade risk**: **Low.** This is the cleanest bump in the three recorded opencode-sdk upgrades (`1.17.13→1.18.15` had a behavioral pump-class fix; `1.18.15→1.18.30` had the still-live B1 subagent-text risk). This range's `.d.ts` diff is two files, both outside DorkOS's reachable surface, and every behavioral release note (ACP boundaries, session sharing, PTY validation, TUI auto-update) maps to a subsystem DorkOS's adapter either doesn't call or has its own separate implementation of.

**Estimated total effort**: ~20–30 minutes — purely the mechanical pin bump (3 manifests + the sidecar constant) + `pnpm install` + running the existing adapter test suite. No live-sidecar verification is required by anything in this range (contrast the prior bump's B1 item, which needed a live cancel-a-subagent capture).

## Breaking Changes — Detailed Impact

### `/v2` `GlobalUpgradeData.body.target` becomes required

- **What changed**: `dist/v2/gen/types.gen.d.ts` — `target?: string` → `target: string` on the (already-optional-shaped) upgrade-data body.
- **Affected files**: none. `grep -rn "@opencode-ai/sdk/v2"` across `apps/`, `packages/`, `scripts/` returns zero hits.
- **Effort**: none.
- **ADR conflicts**: none.
- **Migration approach**: no action; record here for the next bump's diff-base.

### `/v2` `update` config field description change

- **What changed**: doc-comment only (TSDoc text), no type change. Reflects the v1.19.0 behavior change (auto-update removed from the sidecar's own update checker).
- **Affected files**: none — DorkOS never reads or writes the sidecar's `update`/`autoupdate` config key (confirmed by grep: zero occurrences of `autoupdate` in the opencode runtime directory, and the only `.update(` call sites are `client.session.update(...)` — a different, unrelated route — and unrelated `createHash(...).update(...)` digest calls).
- **Effort**: none.

## Deprecation Migrations

None in this range.

## Server-Side Behavioral Changes (no compiler catches these)

Per the config's own `upgrade_notes` ("most behavior lives in the sidecar, so release notes about the server can matter more than client-visible API changes"), these were checked even though no type changed:

### Session sharing discontinued (v1.19.1)

- **What changed**: public share links, the share/unshare commands, and import-from-share-URL are all removed server-side.
- **DorkOS usage**: none. `grep -rn "\.share(\|session\.share\|\.unshare(\|shareUrl\|share_url"` across the opencode runtime directory returns zero hits — DorkOS never exposed or called this upstream feature.
- **Action**: none.

### PTY connection validation tightened (v1.19.0)

- **What changed**: "Validate PTY connection origins and tickets before checking whether a PTY exists" — a fix to opencode's own built-in terminal/PTY feature.
- **DorkOS usage**: none. Zero `pty`/`PTY` identifiers anywhere in `apps/server/src/services/runtimes/opencode/` (the one `pty` hit is a comment in `event-mapper.ts` listing non-session-scoped event namespaces DorkOS explicitly ignores: `installation, lsp, tui, pty, files, vcs…`). DorkOS's computer-use surface (`computer/` subdirectory) speaks its own distinct PTY/terminal protocol via the `computer` HTTP route, with no shared code path to opencode's TUI-facing PTY feature.
- **Action**: none.

## Recommended Feature Adoptions

### Configurable model reasoning variants (Relevance: Low)

- **What it enables**: a `reasoning_options` config array per provider model (`effort`/`toggle`/`budget_tokens` shapes) that replaces opencode's built-in reasoning-variant catalog with user-configured overrides.
- **Value to DorkOS**: this is a `/v2`-only, config-file-level feature with no corresponding SDK client method — DorkOS doesn't write the sidecar's model config file (it treats the sidecar as a managed process and reads models via `client.config.providers()`/the `ProviderListResponse` type, which is unchanged). Adopting it would mean writing into opencode's own `opencode.json`/config surface, a different (and currently unused) integration seam from the one DorkOS maintains today.
- **Adoption effort**: significant if pursued (new config-write path, new user-facing setting, `/v2` types would need importing) — out of proportion to the value for this bump.
- **Dependencies**: would need a decision on whether DorkOS ever writes opencode's on-disk config at all (currently it does not — ADR-0308's sidecar is treated as a black box driven entirely through the HTTP API).
- **Suggested approach**: no action this bump; revisit only if a user-facing "reasoning effort per provider" feature is independently requested.

## Bug Fixes Resolving Known Issues

None of the nine releases' fixes touch code DorkOS's adapter calls (ACP, Bedrock/Together/Cloudflare/Gemini/xAI provider internals, TUI, macOS code-signing, stats-site formats, PTY, session sharing, auto-update channel logic — all either provider-internal server behavior with no DorkOS-visible contract change, or features DorkOS doesn't use).

## No Action Required

- 2 unreachable `/v2` type changes (see above).
- ~15 provider-internal bug fixes (Bedrock, Together AI, Cloudflare AI Gateway, Gemini, xAI, ACP) — none touch an API DorkOS calls.
- 1 low-relevance feature (reasoning-variant config).
- All TUI/desktop/docs-site/community-docs changes — no server surface.

## Required Code Changes (mechanical bump)

Same 4-site pattern as the prior two opencode-sdk bumps (file-by-file, verify each before editing):

1. `apps/server/package.json` — `"@opencode-ai/sdk": "^1.18.30"` → `"^1.19.3"`
2. `packages/cli/package.json` — same
3. `apps/desktop/package.json` — same
4. `apps/server/src/services/runtimes/opencode/providers/provision.ts:32` — `export const OPENCODE_PACKAGE_VERSION = '1.18.30';` → `'1.19.3'` (pins the sidecar `opencode-ai` binary in lockstep with the SDK, per the file's own TSDoc)
5. `pnpm-lock.yaml` — regenerated by `pnpm install` after the manifest bumps (not hand-edited)

`scripts/__tests__/dependabot-lockstep-families.test.ts` (`holds the opencode sidecar pin at the version the manifests declare for its SDK`, line 353) enforces that (4) matches the `@opencode-ai/sdk` version declared in the manifests — it will fail until both move together, which is the intended tripwire.

No `NOTES.md` or other historical "verified at version X" citations need updating — those are dated, point-in-time verification records (e.g. "shipped 1.18.15 sidecar", "DOR-1147"), not live pins, consistent with how the two prior opencode-sdk bumps treated them.

## Verification Plan

1. Bump the 4 pin sites above.
2. `pnpm install` (updates lockfile + sidecar provision constant takes effect on next sidecar (re-)provision).
3. Run the existing adapter suite (`pnpm vitest run apps/server/src/services/runtimes/opencode`), including `conformance.test.ts`, `provision.test.ts`, and `event-mapper.test.ts` — all should pass unchanged since no type or event-union surface moved.
4. No live-sidecar smoke turn is required by anything in this delta (contrast the 1.18.15→1.18.30 bump's B1 subagent-cancel risk, which did need one) — but running one is still good hygiene before merging, per the package's own `upgrade_notes` bump checklist emphasis on the sidecar being the real source of behavior.
