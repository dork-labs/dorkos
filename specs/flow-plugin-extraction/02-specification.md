---
slug: flow-plugin-extraction
number: 266
created: 2026-06-27
status: specified
linearIssue: DOR-133
---

# Extract /flow into a self-contained external marketplace plugin

**Status:** Draft
**Author:** Dorian
**Date:** 2026-06-27

## Overview

Move `/flow`'s canonical home OUT of the dorkos repo into a single, self-contained, installable
plugin that lives as a subdirectory of the `dork-labs/marketplace` repo (`plugins/flow/`). dorkos
stops being flow's home and becomes a **consumer** that dogfoods the external plugin. The plugin ships
its TypeScript and runs it directly (no compiled `.mjs`), so the source IS the runtime and editing the
plugin in one place is the whole story. This supersedes ADR-0281 (dorkos-`.agents/flow`-canonical) and
ADR-0294 (esbuild-`.mjs` build), and replaces the closed PR #56 / spec #264, whose content is the
source material on kept branch `spec-flow-marketplace-package`.

## Background / Problem Statement

Spec #264 made flow package-READY but kept it canonical in dorkos (per ADR-0281), with the engine as a
private dorkos workspace package compiling to shipped `.mjs`. The operator rejected that on two firm
grounds: (1) **100% of flow must live in one location, and that location must not be dorkos** - it must
be a plugin/marketplace repo so the plugin can be modified entirely in one place; and (2) the
source/artifact split (TS source in dorkos, compiled `.mjs` shipped elsewhere) is unacceptable. Both
are resolved by extracting flow into one external plugin that ships runnable TypeScript. The marketplace
already supports linking a plugin by git URI (`relative-path` / `git-subdir` / `github` / `url` source
forms) and already has the scaffolder, validator, and installer, so this needs no new platform tooling.

## Goals

- One self-contained plugin at `dork-labs/marketplace/plugins/flow/` holding 100% of flow content
  (commands, skills, hooks, the engine source + tests, scripts, adapters, config, docs). Nothing
  flow-specific stays canonical in dorkos.
- Ship the TypeScript and run it directly via `node --experimental-strip-types` (tsx fallback); the
  shipped runtime is zero-runtime-dependency (no compile, no install on the consumer side).
- dorkos dogfoods the external plugin via `claude --plugin-dir` (interim), with `/flow` working
  end-to-end before any in-dorkos flow source is removed.
- The plugin validates (`dorkos package validate`) and is registered in the marketplace registry
  (`.claude-plugin/marketplace.json`) via the `relative-path` source.
- ADR-0281 and ADR-0294 superseded; the reversal is auditable.

## Non-Goals

- Building DOR-145 (`dorkos package build`), DOR-146/147/148 (the dev-loop tooling: `--plugin-dir`
  docs, install provenance, `dorkos contribute`), or DOR-138 (Harness Sync engine / cross-agent
  projection). The migration uses what exists today; the blessed dev-loop cleanup is DOR-172.
- Cross-agent (Codex / Cursor / Gemini) projection. v1 is Claude-first, dorkos-dogfooded.
- Autonomous-tick firing inside dorkos (the server task system discovering plugin-shipped tasks). The
  tick SHIPS in the plugin `enabled: false` (inert); wiring a scheduler is the adopter's opt-in
  (bring-your-own-scheduler) and dorkos's autonomous dogfood is a deferred follow-up.
- No time or effort estimates.

## Technical Dependencies

- The marketplace machinery (exists): `packages/marketplace/src/{source-resolver,manifest-schema,
scaffolder,package-validator}.ts`; install runtime `apps/server/src/services/marketplace/`; the
  registry `.claude-plugin/marketplace.json`. Source form for a same-repo subdir: `relative-path`
  (`./plugins/flow`).
- `node --experimental-strip-types` (Node 22.6+; in-repo precedent at
  `.claude/scripts/spec-manifest-ops.ts`) or `tsx` (older Node). The plugin documents a Node floor.
- The `dork-labs/marketplace` repo (local clone at `/Users/doriancollier/Keep/dork-os/marketplace`),
  layout `plugins/<name>/`, registry `.claude-plugin/marketplace.json`.
- Source material: branch `spec-flow-marketplace-package` (the #264 content, engine 413 tests green).

## Detailed Design

This work spans **two repos**: the `dork-labs/marketplace` repo (gains the plugin) and dorkos (loses
its flow source, gains a consumption wiring).

- **The plugin directory (`dork-labs/marketplace/plugins/flow/`)** - one self-contained unit:
  - `.dork/manifest.json` - `{ type: "plugin", name: "flow", version, description, layers:
["commands","skills","hooks"], repository }`. `scripts/`, `adapters/`, `config/` are plain plugin
    files referenced by the skills (not Claude Code "layers").
  - `.claude-plugin/plugin.json` - the Claude Code plugin manifest (so `claude --plugin-dir` and
    `claude plugin install` load it).
  - `commands/` - the 12 `/flow:<stage>` commands + the `/flow` orchestrator (from `.claude/commands/flow*`).
  - `skills/` - the stage skills + `linear-adapter` + `building-adapters` + `initializing-flow` (from
    `.agents/flow/skills/`).
  - `hooks/` - the `flow-loop` Stop hook (from `.claude/hooks/flow-loop.mjs`).
  - `scripts/` - the engine source as runnable **`.ts`** (the oracles + their CLI wrappers); skills call
    `node --experimental-strip-types scripts/<oracle>.ts`.
  - `engine-tests/` (or `scripts/__tests__/`) - the 413 vitest tests, run in the plugin's CI.
  - `adapters/` - `SPEC.md` + `reference/` + `fixtures/` (from `.agents/flow/adapters/`).
  - `config/` - `config.json` + `config.schema.json` + `CONFIG.md` + `config.local.example.json`.
  - `package.json` - the plugin's own DEV tooling (vitest, zod for schema authoring, types). The shipped
    runtime needs none of it.
  - `docs/` + `README.md` - the install / adapter / autonomy guides.
- **Runtime (ship `.ts`, run directly):** the pure oracles (dispatch, calibration, gates, recovery)
  strip to zero-runtime-dependency `.ts`; skills invoke `node --experimental-strip-types
scripts/<oracle>.ts`. The single zod touch (`validate-config`) is kept dependency-free in the shipped
  path: it validates a config object against the committed `config.schema.json` with a small embedded
  check; **zod stays a dev-only dependency** used to author `config.schema.json` and run the schema
  tests. There is no build step and nothing for the consumer to install.
- **Consumption by dorkos:** dorkos runs `/flow` against the external plugin via `claude --plugin-dir
<marketplace-clone>/plugins/flow`, which loads the plugin's commands + skills + hooks for the session.
  The `flow-loop` Stop hook loads with the plugin. The Pulse `flow-drain` tick ships in the plugin as a
  skill carrying `cron` + `enabled: false`; it is inert in v1 (no scheduler wired), so manual `/flow`
  dogfood does not depend on the server task system.
- **Sequencing (the one ordering that never breaks dorkos's daily `/flow`):**
  1. Stand up `plugins/flow/` in the marketplace repo from the #264 branch content, restructured into
     the layout above and `.ts`-ified (the oracle `.mjs` build is dropped; the `.ts` source becomes the
     shipped scripts; the `@dorkos/flow-engine` package.json becomes the plugin's dev `package.json`).
  2. Prove it standalone: the 413 engine tests + the conformance/adapter tests pass in the plugin;
     `node --experimental-strip-types scripts/dispatch.ts` runs; `dorkos package validate ./plugins/flow`
     passes.
  3. Register it: add the `relative-path` entry to `.claude-plugin/marketplace.json`.
  4. Wire dorkos to consume it via `claude --plugin-dir` and verify `/flow` works end-to-end against the
     external plugin (commands, skills, the Stop hook, a dry dispatch).
  5. ONLY THEN remove dorkos's in-repo flow source: `.agents/flow/`, `.claude/commands/flow*`,
     `.claude/hooks/flow-loop.mjs`, `.dork/tasks/flow-drain/`, the `@dorkos/flow-engine` workspace
     entry, and the engine tests. The `tracker-confinement` guard moves into the plugin with the engine.
- **What stays in dorkos:** only the consumption wiring (the documented `--plugin-dir` invocation /
  a dev convenience), and references in AGENTS.md / contributing docs pointing at the external plugin.
- **API / data model changes:** none at runtime. The skill -> oracle call changes from
  `node scripts/<oracle>.mjs` to `node --experimental-strip-types scripts/<oracle>.ts`.

## User Experience

- **An adopter** installs flow from the marketplace (`relative-path`/`github` source) or
  `claude plugin install`; first `/flow` routes to `/flow:init` (unchanged from #264). They never build
  or install dependencies: the scripts are runnable `.ts`.
- **A flow maintainer** edits the plugin in ONE place (`dork-labs/marketplace/plugins/flow/`): the `.ts`
  source is the runtime, the skills/commands/hook/adapters/config are all there.
- **dorkos (the dogfooder)** runs `/flow` via `claude --plugin-dir`; the experience is identical to
  today's in-repo `/flow`. Autonomy (the tick) stays off until a scheduler is wired (a later step).

## Testing Strategy

- **Unit:** the engine's 413 tests + the CLI-contract tests + the adapter-conformance test move with the
  source and run in the plugin's CI via `node --experimental-strip-types` + vitest. _Purpose: prove the
  `.mjs` -> `.ts` runtime change preserves behavior._
- **Integration:** `dorkos package validate ./plugins/flow` passes; an install/consume smoke test
  (`claude --plugin-dir ./plugins/flow` -> `/flow` lists, a dry `node --experimental-strip-types
scripts/dispatch.ts` on an empty queue). _Purpose: the plugin loads + runs as an external unit._
- **Regression (dorkos side):** after removal, dorkos's `/flow` (via `--plugin-dir`) still works
  end-to-end; the `tracker-confinement` guard is green in its new plugin home. _Purpose: the consumer
  path is intact and nothing flow-shaped is orphaned in dorkos._
- **Mocking:** the adapter contract uses the fake in-memory tracker fixtures; no live tracker in tests.

## Performance Considerations

`node --experimental-strip-types` strips types at load (no compile, negligible startup cost) and the
oracles run deterministically at near-zero tokens, as in #264. Dropping the esbuild build removes a
build step entirely.

## Security Considerations

Autonomy stays opt-in (`enabled: false` tick + bring-your-own-scheduler). Secrets remain in a gitignored
`config.local.json`, never in the committed plugin. The adapter is still the single tracker-write audit
surface, conformance-gated. The `--plugin-dir` dogfood loads code from a local clone the operator
controls; published installs record provenance later (DOR-147).

## Documentation

- The plugin carries its own `README.md` + the install / build-your-adapter / bring-your-own-scheduler
  guides (moved from `docs/guides/flow/`).
- dorkos: update AGENTS.md + `contributing/flow-engine.md` to point at the external plugin + document the
  `--plugin-dir` dogfood. Write the supersede notes on ADR-0281 + ADR-0294 and the three new ADRs below.

## Implementation Phases

- **Phase 1 - Stand up the plugin (in the marketplace repo):** create `plugins/flow/` with the layout
  above from the #264 branch content; convert the oracle scripts from `.mjs`-build to runnable `.ts`;
  make `validate-config` zero-dep; move the 413 tests; `package.json` becomes the plugin's dev manifest.
- **Phase 2 - Prove standalone:** tests green, scripts run, `dorkos package validate` passes; register in
  `.claude-plugin/marketplace.json` (relative-path).
- **Phase 3 - Wire dorkos as consumer:** `claude --plugin-dir` invocation documented; verify `/flow`
  end-to-end against the external plugin.
- **Phase 4 - Remove flow from dorkos:** delete the in-repo flow source + the workspace entry + tests;
  update AGENTS.md / contributing; supersede ADR-0281 + ADR-0294, add the new ADRs.
- **Cross-cutting:** the spec spans two repos; the marketplace-repo work is outward-facing (creating +
  pushing a plugin), so EXECUTE confirms before pushing.

## Open Questions

- ~~Pulse-tick consumption in dorkos?~~ **(RESOLVED)** _Answer:_ the tick ships in the plugin as a skill
  with `cron` + `enabled: false` and is inert in v1; manual `/flow` dogfood (commands/skills/hook via
  `--plugin-dir`) does not depend on the server task system. _Rationale:_ keeps v1 scoped to Claude-first
  manual dogfood; autonomous-tick firing inside dorkos (server discovery of plugin tasks) is a deferred
  follow-up, not a blocker. (Original context: the server task system is a different integration than
  `--plugin-dir`.)
- ~~Own repo vs marketplace subdir?~~ **(RESOLVED)** _Answer:_ marketplace subdir (`plugins/flow/`).
  _Rationale:_ matches the existing plugin layout, one repo, operator-chosen; `git-subdir` keeps an
  independent-clone-URL path open later.
- ~~Ship `.ts` vs `.mjs`?~~ **(RESOLVED)** _Answer:_ ship `.ts` run directly. _Rationale:_ no
  source/artifact split, keeps typing, in-repo precedent; once one repo, build-vs-no-build is low-stakes.

## Related ADRs

- **ADR-0281** - ship /flow as a plugin built from dorkos `.agents/flow` (governing; **superseded** by
  ADR-0297, external canonical home).
- **ADR-0294** - delete @dorkos/flow, ship oracles as esbuild `.mjs` (**superseded** by ADR-0298, ship
  `.ts` run directly).
- **ADR-0295** - bring-your-own-scheduler (still governing; the tick ships `enabled: false`).
- **ADR-0296** - tracker adapters generated from a contract (still governing).
- **ADR-0297** (new, this spec) - Flow's canonical home is an external marketplace plugin, not dorkos.
- **ADR-0298** (new, this spec) - Ship the engine as runnable TypeScript, not compiled `.mjs`.
- **ADR-0299** (new, this spec) - dorkos consumes flow as an external plugin via `--plugin-dir` (interim).

## References

- `specs/flow-plugin-extraction/01-ideation.md`; the closed PR #56 + branch `spec-flow-marketplace-package`.
- `plans/agent-harness-portability-roadmap.md` (workstream C); DOR-133 (umbrella), DOR-134 (ADR-0281
  supersede), DOR-172 (dev-loop cleanup), DOR-146/147/148 (dev-loop tooling).
- `packages/marketplace/src/{source-resolver,scaffolder,manifest-schema}.ts`; `dork-labs/marketplace`.
