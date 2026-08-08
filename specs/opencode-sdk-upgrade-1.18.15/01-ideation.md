# OpenCode SDK Upgrade: 1.17.13 → 1.18.15

## Problem Statement

We are running `@opencode-ai/sdk` at `^1.17.13`. 1.18.15 is available (23
releases ahead). Every type DorkOS imports is byte-identical between the two
versions; the value of the bump is the sidecar fixes it aligns us with (MCP
reliability, session/directory routing, message chronological ordering).

## Research

- Changelog: `research/runtime-upgrades/opencode-sdk/1.17.13-to-1.18.15/changelog.md`
- Impact assessment: `research/runtime-upgrades/opencode-sdk/1.17.13-to-1.18.15/impact-assessment.md`
- Triage decisions: `research/runtime-upgrades/opencode-sdk/1.17.13-to-1.18.15/triage-decisions.md`

## Scope

### Must Do

- Bump `^1.17.13` → `^1.18.15` in `apps/server`, `apps/desktop`, `packages/cli`
- Bump `OPENCODE_PACKAGE_VERSION` in `apps/server/src/services/runtimes/opencode/provision.ts` to `1.18.15` — the lockstep sidecar pin; its own TSDoc requires this on every SDK bump
- Conformance suite (`pnpm vitest run apps/server/src/services/runtimes/opencode`) + one live smoke turn against a 1.18.15 sidecar
- Verify the `EventMessagePartDelta` workaround (`event-mapper.ts:71-88`) still holds — it does at analysis time; keep the manual type

### Should Do

- Update ADR-0308's Status line, which literally pins `@opencode-ai/sdk@1.17.13`
- State the supported sidecar range in the PR: types are identical across 1.17.13–1.18.15, so any sidecar in that window is wire-compatible; outside it is unverified (and ungated — see deferred item)

## Out of Scope

- Sidecar version-range gating in `check-dependencies.ts` (`checkCliBinary()` checks only that `opencode --version` succeeds) — pre-existing gap, future hardening item
- `@opencode-ai/sdk/v2` subpath changes — DorkOS never imports it

## Risk Assessment

Low. Zero type changes on our surface. Rollback: revert both pins together
(SDK + `OPENCODE_PACKAGE_VERSION`) — they move in lockstep by design.
