# Triage Decisions

**Date**: 2026-09-11
**Decided by**: Dorian (interactive /app:runtime-upgrade run)

## Included in Upgrade

- [x] Version bump `~0.153.4` → `~0.154.0` across the whole family in one commit: `@openai/codex-sdk` and the `@openai/codex` CLI in apps/server, apps/desktop, packages/cli; the desktop per-platform npm aliases (`-darwin-arm64`, `-win32-x64`); and `CODEX_PACKAGE_VERSION` in `codex/provision.ts`
- [x] Pinned-SDK bump checklist (`contributing/adding-a-runtime.md`): dist-tag check, `.d.ts` diff, event-mapper exhaustiveness compile, conformance suite, model-picker check, one live smoke turn
- [x] Smoke-turn focus: the workspace-trust hardening (#42324, #42716) against a working directory the resolved CLI has never seen, and which model a session with no explicit `settings.model` resolves to now that defaults moved server-side
- [x] Config corrections in `.claude/config/runtime-deps.json`: split the drifted `sdk_surface_map` entry (`CodexOptions` moved out of `codex-runtime.ts` into `codex-options.ts`), and record the app-server protocol coupling in `upgrade_notes` so the next bump knows `model-catalog.ts` / `model-context-windows.ts` need a live check that no `.d.ts` diff can prompt
- [x] Refresh the stale `0.153.4` version labels and `rust-v0.153.4` permalinks in the adapter's comments and `NOTES.md`. The SDK surface is byte-identical, so every assertion those comments make carries forward; only the number was stale

## Separate Specs

- None. Nothing in the release rises above medium-passive relevance, and the one item with plausible future value — server-advertised permission profiles (#42453), which would replace the hardcoded `MODE_TO_SANDBOX` table in `turn-input.ts` with discovery — needs an app-server protocol extension and is its own spec if ever wanted.

## No Feature Adoption

**Decision: adopt nothing from this release.** The npm package is byte-identical between the two versions (`dist/index.d.ts`, `dist/index.js`, `dist/index.js.map`, `README.md`, `LICENSE` all hash the same; only `package.json`'s `version` and `@openai/codex` pin differ), so there is no new SDK surface to adopt in the first place. The genuinely valuable items — MCP OAuth refresh coordination, MCP tool-catalog freshness and discovery diagnostics, plugin/skill/hook refresh in existing sessions — are **passive**: DorkOS gets them by moving the CLI pin and writing no code. The rest is TUI-only (managed worktrees, inline async questions, Vim mode, voice) or already in our pin (the GPT-6-Astra items were backported to 0.153.1–0.153.4).

## Deferred

- Server-advertised permission profiles (#42453) — would let the adapter discover what the resolved CLI actually supports instead of hardcoding `MODE_TO_SANDBOX`. Revisit if the hardcoded table ever disagrees with a shipped CLI.
- Codex version in turn metadata (#42395) — a second source for a version DorkOS already parses out of the app-server `initialize` `userAgent`. Only interesting if that parse proves fragile.

## Skipped

- `codex mcp-server` subcommand removal (#42993) — zero usage. DorkOS's only direct CLI invocation is `app-server --stdio`; its own `codex-ui-mcp-server.ts` is a config payload, not the removed subcommand.
- Detached review delivery (#42602) and legacy Guardian approval paths (#43462) deprecations — unreachable. Every turn sets `approvalPolicy: 'never'` and the runtime declares `supportsToolApproval: false`.
- Rate-limit usage capabilities (#42358), thread originators (#42458, #42445) — no DorkOS surface consumes either.

## Alpha Channel

Inspected and rejected as a target, on evidence rather than policy. `0.155.0-alpha.3.10` (the `alpha` dist-tag, published 2026-09-11) has a `dist/index.d.ts` and `dist/index.js` **byte-identical to 0.154.0 stable**, which is itself byte-identical to 0.153.4. Its only delta is its `@openai/codex` pin, and all seven `rust-v0.155.0-alpha.*` GitHub releases have empty bodies. **There is nothing alpha-only to weigh**, so the standing rule (never pin an alpha without an explicit decision) is not even under pressure here. Target stable 0.154.0.
