# Triage Decisions

**Date**: 2026-08-07
**Decided by**: Dorian (interactive /app:runtime-upgrade run)

## Included in Upgrade Spec

- [x] Version bump `^1.17.13` → `^1.18.15` across apps/server, apps/desktop, packages/cli
- [x] Bump `OPENCODE_PACKAGE_VERSION` in `apps/server/src/services/runtimes/opencode/provision.ts` to `1.18.15` (lockstep sidecar pin — the one required code change)
- [x] Update ADR-0308's Status line (literally pins `@opencode-ai/sdk@1.17.13`)
- [x] Conformance suite + one live smoke turn; verify the `EventMessagePartDelta` workaround in `event-mapper.ts:71-88` still holds (confirmed still necessary at analysis time)

## Separate Specs

- None. All three new features (code-mode MCP adapter, `subagent_depth`, Modal auto-discovery) are low/none relevance.

## Deferred

- Sidecar version-range gating: `check-dependencies.ts` `checkCliBinary()` enforces no version range for configured/PATH binaries (pre-existing gap, not introduced here). Worth a future hardening item.
- Watch-item: opencode's "legacy vs v2 server" migration — re-check on the next bump; DorkOS never imports `@opencode-ai/sdk/v2` today.

## Skipped

- None. No breaking changes, no deprecations.
