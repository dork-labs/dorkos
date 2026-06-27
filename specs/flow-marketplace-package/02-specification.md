---
slug: flow-marketplace-package
number: 264
created: 2026-06-26
status: specified
linearIssue: DOR-133
---

# Ship /flow as a portable DorkOS Marketplace plugin

**Status:** Draft
**Author:** Dorian
**Date:** 2026-06-26

## Overview

Convert `/flow` from an in-repo subsystem into an installable DorkOS Marketplace **plugin** any
project can adopt, built from the canonical `.agents/flow/` source (no separate repo, per ADR-0281).
Five content changes make `.agents/flow/` package-ready and portable: (1) the deterministic engine
ships as the plugin's `scripts/` (delete `@dorkos/flow`); (2) the generic stage skills are decoupled
from this tracker instance (G8); (3) the tracker adapter is generated per-adopter from a contract
rather than bundled; (4) a `/flow:init` first-run setup; (5) the Pulse tick becomes a schedulable
skill. A final, dependency-gated phase assembles and installs the package.

## Background / Problem Statement

`/flow` runs only in this repo today. It is already plugin-shaped (11 commands + 8 skills + the
`flow-loop` Stop hook + config + the `@dorkos/flow` package), but it is welded to our Linear +
Composio + `DOR` setup and split across an unused npm package. ADR-0281 (proposed) already commits to
shipping it as a `plugin`-type package built from `.agents/flow/`; the roadmap
(`plans/agent-harness-portability-roadmap.md`) sets the projection direction. This spec defines the
content work that makes that real, portable, and safe, anchored to umbrella **DOR-133**.

## Goals

- A `plugin`-type package built from `.agents/flow/`, installable in any repo and via
  `claude plugin install` (the registry is a strict superset of Claude Code's format).
- The deterministic oracles ship as the plugin's `scripts/` (delete `@dorkos/flow`); stage skills
  **call** the scripts instead of re-deriving the ladders in prose (one source of truth, no drift).
- Tracker-agnostic generic layer: the 8 stage skills speak only the `WorkItem` model + verbs (G8);
  the only tracker-aware unit is a per-adopter generated adapter.
- Autonomy works with no DorkOS server (bring-your-own-scheduler) and richer with one.
- The bundled Pulse tick is a schedulable skill, `enabled: false` by default.
- First-run config via `/flow:init`: repo-local committed config + gitignored secrets + env override.

## Non-Goals

- Cross-agent projection (Codex / Cursor / Gemini): workstream B (DOR-131, DOR-137..144). v1 is
  Claude-first.
- The P5 server engine (DOR-88 / DOR-90 / DOR-95).
- Building the marketplace **platform** tooling this work depends on or forces: `dorkos package build`
  (DOR-145), the projection engine (DOR-138), the install-config/first-run convention (DOR-159),
  layers-as-capabilities (DOR-160), the tasks-as-skills unification (DOR-150 / 151 / 152), install
  provenance / `contribute` / dev-loop (DOR-146 / 147 / 148). This spec consumes them.
- No time or effort estimates.

## Technical Dependencies

- **DOR-145** (`dorkos package build` / C1) + **DOR-138** (projection engine / B4) — required for the
  final assembly phase (Phase 6).
- **DOR-150** (tasks-as-skills capability model) — required for the tick's final discovery home.
- **DOR-159** (config / first-run convention) + **DOR-160** (layers as capabilities) — co-evolve.
- `@dorkos/skills` frontmatter schemas (`kind` / task / command), ADR-0229.
- `node` runs the compiled `.mjs` scripts (the pure oracles are dependency-free; the config-schema
  validator self-resolves Zod via bun/deno `npm:` or a bundled copy).
- `agentskills.io` script conventions: JSON in/out, `--help`, meaningful exit codes, diagnostics to
  stderr, no interactive prompts.

## Detailed Design

- **Architecture changes:**
  - **Delete `packages/flow` (`@dorkos/flow`).** Move the oracle TypeScript source + its vitest suite
    into `.agents/flow/engine/` (authoring), and ship compiled, dependency-free `.mjs` in
    `.agents/flow/scripts/`. The pure decision oracles (`dispatch`, `calibration`, `gates`, `recovery`,
    dedup) compile with zero runtime deps (their imports are all `import type`). The config-schema
    validator (the one Zod touch) is a self-contained script.
  - **Stage skills call scripts.** Replace prose re-derivation of the ranking / gating / calibration
    ladders with `node scripts/<oracle>.mjs` calls (JSON in, JSON out). The skills feed the oracle the
    `WorkItem[]` the adapter produced and act on the returned decision.
  - **The Pulse tick is a thin schedulable skill.** `flow-drain` becomes a `SKILL.md` carrying
    `cron` + `enabled: false`, whose body delegates to the canonical single-tick (`runTick`:
    recovery -> inbox/resume -> dispatch one item -> carry to gate -> stop). It is NOT `/flow auto`
    (which loops via the sentinel + Stop hook); the scheduler provides repetition.
  - **The tracker adapter is generated, not bundled.** Ship the **adapter contract** (`SPEC.md` + the
    `WorkItem` schema + the 13 capability verbs + `scripts/validate-adapter.mjs`), a `building-adapters`
    skill, and reference adapters (start with Linear-MCP and Linear-Composio). The adopter's concrete
    adapter is generated into their repo at `/flow:init` and must pass the conformance test
    (generate-and-verify).
  - **G8 decoupling.** Remove the ~64 leaked `Linear` / `Composio` / `DOR` references from the 8 generic
    stage skills so they speak only `WorkItem` + verbs (the audit confirmed: triaging 16, verifying 10,
    capturing 10, closing 9, specifying 8, decomposing 6, tending 5).
  - **`/flow:init`.** A first-run setup skill: scaffold the repo-local config, prompt for tracker /
    identity / project via the calibration ladder, generate + validate the adapter, and add the secrets
    file to `.gitignore`.
  - **Final assembly (Phase 6, gated on DOR-145 + DOR-138):** `.dork/manifest.json` +
    `.claude-plugin/plugin.json` + the layer set (`commands` / `skills` / `hooks` / `templates` +
    `scripts`), assembled by `dorkos package build`, dogfooded by installing it back into dorkos.
- **Code structure & file organization (paths):**
  - `.agents/flow/scripts/*.mjs` — shipped compiled oracles + `validate-adapter.mjs`.
  - `.agents/flow/engine/` — the oracle TypeScript source + vitest (built by `package build`).
  - `.agents/flow/skills/building-adapters/SKILL.md`; `.agents/flow/adapters/reference/`.
  - `.agents/flow/skills/*/SKILL.md` — the decoupled stage skills.
  - `.agents/flow/config.json` + `config.schema.json`.
  - `.claude/commands/flow/init.md` — the new `/flow:init`.
  - the `flow-drain` tick skill (final discovery home per DOR-150).
- **API changes:** the stage-skill -> oracle JSON contract (the input/output shapes for the dispatch,
  calibration, gates, recovery scripts); the adapter contract's 13 verbs + `WorkItem` schema +
  conformance invariants.
- **Data model changes:** none at runtime; the config schema's home moves from the package to `scripts/`.

## User Experience

An adopter installs the flow plugin (DorkOS marketplace or `claude plugin install`). On the first
`/flow` invocation, the orchestrator detects missing config and routes to `/flow:init`, which: asks
which tracker + connection (Linear-MCP / Linear-Composio / Jira / GitHub Issues / other), generates the
adapter from the contract plus the closest reference, runs `validate-adapter.mjs` until green, writes
the committed config, and gitignores the secrets file. Thereafter `/flow:<stage>`, `/flow auto`, and the
optional scheduled tick behave as they do in-repo. For autonomy, the adopter either enables the bundled
tick under a DorkOS server or wires OS-cron / CI to fire `/flow auto`; a headless stop-and-ask parks on
the tracker and nudges (the `comment-and-nudge` channel).

## Testing Strategy

- **Unit:** the oracle scripts retain the existing 388 vitest tests (moved with the source into
  `.agents/flow/engine/`); each script gains a CLI-contract test (JSON in -> expected JSON out + exit
  codes). _Purpose: prove the deterministic logic is unchanged by the package -> scripts move._
- **Conformance:** `validate-adapter.mjs` feeds a generated adapter known fixtures and asserts the
  `WorkItem` invariants (the five state categories, required fields, `blockedBy` resolution, label
  re-namespacing). The `building-adapters` skill's final step runs it until green. _Purpose: a malformed
  generated adapter must fail loudly, not corrupt dispatch silently._
- **Integration:** extend the existing tracker-confinement grep guard to assert the 8 stage skills carry
  no tracker strings (G8); an install smoke test (`package build` -> install into a temp repo ->
  `/flow:init` -> a dry tick). _Purpose: the portability gate and the install path both hold._
- **Mocking:** exercise the adapter contract with a fake in-memory tracker fixture; no live Linear in tests.

## Performance Considerations

Deterministic scripts replace token-heavy prose re-derivation of the ranking ladder: a 7-tier stable
sort runs instantly, at ~0 tokens, identically every time. The bring-your-own-scheduler idle-tick cost
(a full agent boot on an empty queue) is mitigated by a deterministic pre-check (`node
scripts/dispatch.mjs`) before spawning an agent.

## Security Considerations

Autonomous scheduling is opt-in (the `enabled: false` default plus the adopter explicitly wiring a
scheduler); ADR-D's production-gate + leader-lock govern the DorkOS-server path. Secrets (tracker tokens,
the Composio account) never go in committed config: a gitignored `.local` file + env override hold them.
The generated adapter is the single tracker-write audit surface; the conformance test prevents a
malformed adapter from corrupting dispatch.

## Documentation

- `docs/guides/flow/` gains an "install in your project", a "build your adapter", and a
  "turn on autonomy (bring-your-own-scheduler)" page. The adapter `SPEC.md` + the `building-adapters`
  skill are the authoring docs.
- Amend **ADR-0281** (via DOR-134) and **ADR-0229** (via DOR-150). Seed the three new draft ADRs below.

## Implementation Phases

- **Phase 1 — Scripts engine:** move oracles to `.agents/flow/engine/`, compile to `scripts/`, rewire
  the stage skills to call them, delete `packages/flow`. _Independent of the deps._
- **Phase 2 — G8 decoupling:** strip the ~64 leaked references from the 8 stage skills; extend the
  tracker-confinement guard. _Independent._
- **Phase 3 — Adapter-builder:** the contract (`SPEC.md` + `WorkItem` schema + 13 verbs) +
  `validate-adapter.mjs` + the `building-adapters` skill + reference adapters.
- **Phase 4 — `/flow:init` + config:** first-run setup, repo-local config + gitignored secrets, the
  adapter-generation hook.
- **Phase 5 — Capability-model tick:** the thin `flow-drain` schedulable skill (lands with DOR-150's
  discovery model; interim it can stay a thinned `.dork/tasks/flow-drain`).
- **Phase 6 — Assembly (gated on DOR-145 + DOR-138):** `.dork/manifest.json` + `.claude-plugin/plugin.json`
  - `package build` + dogfood install.
- **Cross-cutting:** the ADR amendments (0281 via DOR-134, 0229 via DOR-150) + the three new draft ADRs.

## Open Questions

- ~~Repo home?~~ **(RESOLVED)** Canonical `.agents/flow/`, package built + projected; no separate repo.
  Answer per ADR-0281 + the roadmap. Rationale: the projection engine + `package build` de-risk drift.
- **Oracle source + build location.** Where do the oracle TS source + tests live and how does
  `package build` compile them? _Recommendation:_ `.agents/flow/engine/` (TS + vitest), compiled to
  `.agents/flow/scripts/*.mjs` by `dorkos package build`; the config-validator script self-resolves Zod
  (bun/deno) or bundles it. Confirm at SPECIFY review / DECOMPOSE.
- **Tick shape timing.** Ship the tick in the new capability shape (needs DOR-150) now, or interim
  `.dork/tasks/`? _Recommendation:_ build in the new shape as DOR-150 lands; interim keep a thinned
  `.dork/tasks/flow-drain` so autonomy is not blocked.
- **Phase 6 boundary.** Keep the assembly phase in this spec (dependency-gated) or split it to a
  follow-up once DOR-145/138 land? _Recommendation:_ keep it in-spec but gated.

## Related ADRs

- **ADR-0281** — Ship /flow as a DorkOS Marketplace plugin-type package (governing; amended by DOR-134).
- **ADR-0229** — SKILL.md `kind` discriminator (amended by DOR-150 to the capability model: scheduling
  via `cron` + `enabled`, not `kind`).
- **ADR-0294** (new, this spec) — Delete `@dorkos/flow`; ship the oracles as the plugin's `scripts/`.
- **ADR-0295** (new, this spec) — `/flow` autonomy is bring-your-own-scheduler (pluggable scheduler).
- **ADR-0296** (new, this spec) — Tracker adapters are generated from a contract, not bundled.

## References

- `specs/flow-marketplace-package/01-ideation.md`; `plans/agent-harness-portability-roadmap.md`.
- DOR-133 (umbrella), DOR-134, DOR-150 / 151 / 152, DOR-159, DOR-160, DOR-145 / 146 / 147 / 148,
  DOR-138, DOR-88 / 90 / 95, DOR-131.
- `research/20260626_plugin_config_and_iteration_patterns.md`; `agentskills.io` (scripts, progressive
  disclosure); `contributing/marketplace-registry.md`.
