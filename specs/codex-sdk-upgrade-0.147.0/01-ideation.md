# Codex SDK Upgrade: 0.144.1 → 0.147.0

## Problem Statement

We are running `@openai/codex-sdk` at `~0.144.1`. Stable 0.147.0 is available
(9 releases ahead). The typed SDK surface barely moved — one additive field
(`Usage.cache_write_input_tokens`); the `ThreadEvent`/`ThreadItem` unions are
byte-identical, so the event-mapper exhaustiveness tripwire does not fire.

## Research

- Changelog: `research/runtime-upgrades/codex-sdk/0.144.1-to-0.147.0/changelog.md`
- Impact assessment: `research/runtime-upgrades/codex-sdk/0.144.1-to-0.147.0/impact-assessment.md`
- Triage decisions: `research/runtime-upgrades/codex-sdk/0.144.1-to-0.147.0/triage-decisions.md`

## Scope

### Must Do

- Bump `~0.144.1` → `~0.147.0` in `apps/server`, `apps/desktop`, `packages/cli`
- Pinned-SDK bump checklist (`contributing/adding-a-runtime.md` § Bumping a pinned SDK): event-mapper exhaustiveness compile, conformance suite (`pnpm vitest run apps/server/src/services/runtimes/codex`), one live smoke turn
- Smoke-turn focus: 0.147.0's new local-project "trust" gating in a non-interactive/exec context (inferred auto-trust is unverified), and 0.146.0's interrupt/replay state preservation

### Should Do

- Update ADR-0309's negative consequence about `logs_2.sqlite` unbounded writes and `NOTES.md` Verdict 4 — both describe a pre-0.143.0 state this bump resolves

## Out of Scope

- `cache_write_input_tokens` surfacing (no cost-visibility UI exists)
- Anything alpha-channel (0.148.0-alpha.2's `.d.ts` is byte-identical to 0.147.0)

## Risk Assessment

Low. Zero typed breaking changes, zero deprecated usage (`--full-auto` removal
touches nothing we call). Rollback: revert the pin.
