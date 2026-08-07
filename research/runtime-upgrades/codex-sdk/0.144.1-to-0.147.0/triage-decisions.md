# Triage Decisions

**Date**: 2026-08-07
**Decided by**: Dorian (interactive /app:runtime-upgrade run)

## Included in Upgrade Spec

- [x] Version bump `~0.144.1` → `~0.147.0` across apps/server, apps/desktop, packages/cli
- [x] Pinned-SDK bump checklist (`contributing/adding-a-runtime.md`): .d.ts diff done (unions identical, one additive `Usage.cache_write_input_tokens` field), event-mapper exhaustiveness compile, conformance suite, one live smoke turn
- [x] Smoke-turn focus: exercise the new local-project "trust" gating (0.147.0) in a non-interactive context, and the interrupt/replay state preservation (0.146.0)
- [x] Doc updates: ADR-0309's `logs_2.sqlite` negative consequence and `NOTES.md` Verdict 4 describe a pre-0.143.0 state now resolved by this bump — update both

## Separate Specs

- None. No feature rises above medium-passive relevance.

## Deferred

- `cache_write_input_tokens` surfacing — no cost-visibility UI exists yet; revisit when one does

## Skipped

- `codex exec --full-auto` removal — zero usage, nothing to migrate
