---
slug: flow-plugin-extraction
number: 266
created: 2026-06-27
status: ideation
linearIssue: DOR-133
---

# Extract /flow into a self-contained external marketplace plugin

**Slug:** flow-plugin-extraction
**Author:** Dorian
**Date:** 2026-06-27

---

## 1) Intent & Assumptions

- **Task brief:** Move `/flow`'s canonical home OUT of this (dorkos) repo into a self-contained, installable plugin that lives as a subdirectory of the `dork-labs/marketplace` repo. dorkos becomes a CONSUMER (dogfood) of that plugin, not its home. This supersedes ADR-0281 (dorkos-`.agents/flow`-canonical) and replaces the just-closed PR #56 / spec #264 (flow-marketplace-package), which made flow package-READY but kept it in dorkos. #56's content is the source material, reusable on kept branch `spec-flow-marketplace-package`.

- **Assumptions (settled by the operator; do not re-litigate):**
  - **One location, external.** 100% of flow content (including the engine source + its tests) lives in ONE plugin directory in `dork-labs/marketplace`; nothing flow-specific stays canonical in dorkos.
  - **Ship the TypeScript, run it directly** (no compile-to-`.mjs` source/artifact split): `node --experimental-strip-types` (already used in-repo at `.claude/scripts/spec-manifest-ops.ts`) or `tsx`. Pure oracles are zero-runtime-dep once types strip; the lone wrinkle is the single zod touch (`validate-config`), kept dependency-free in the shipped path.
  - **dorkos is a consumer.** Dogfood via an INTERIM `claude --plugin-dir` / symlink to a local clone (works today); the blessed install + `dorkos contribute` loop is captured as DOR-172 (blocked-by DOR-146 + DOR-148).
  - **The plugin is a (dev) package.** The plugin dir carries its own `package.json` for dev tooling (vitest, types, zod-for-schema-gen); the shipped runtime needs none of it.

- **Out of scope (anti-scope):** building DOR-146/147/148 (dev-loop tooling), DOR-138 (Harness Sync engine / cross-agent projection), DOR-145 (`dorkos package build`), and any cross-agent (Codex / Cursor / Gemini) projection. v1 is Claude-first, dorkos-dogfooded. We do NOT block on any of those: `--plugin-dir` exists today, and the marketplace scaffolder / validator / installer already exist.

## 2) Pre-reading Log

- `packages/marketplace/src/source-resolver.ts` + `marketplace-json-schema.ts`: the marketplace links a plugin by git URI via five source forms (`relative-path`, `github`, `url`, `git-subdir`, `npm`); install-side resolvers exist for each. A same-repo subdir plugin uses the `relative-path` form (`./plugins/flow`).
- `packages/marketplace/src/scaffolder.ts` + `manifest-schema.ts`: `dorkos package init --type plugin` writes `.dork/manifest.json` + `.claude-plugin/plugin.json` + `README.md` + starter dirs `commands/` `skills/` `hooks/`; `layers` is a `z.enum(['skills','commands','hooks','agents',...])`. `dorkos package validate` exists.
- `/Users/doriancollier/Keep/dork-os/marketplace`: the plugin monorepo (`plugins/<name>/`, registry at `.claude-plugin/marketplace.json`); current entries are stubs.
- `plans/agent-harness-portability-roadmap.md` (workstream C, "Marketplace - Authoring & Contribution"): the canonical-in-external-repo + edit + PR-back dev loop = DOR-146 (`--plugin-dir` documented dev loop), DOR-147 (install provenance), DOR-148 (`dorkos contribute`).
- `.claude/scripts/spec-manifest-ops.ts`: shebang `#!/usr/bin/env -S node --experimental-strip-types` - in-repo precedent for shipping + running `.ts` directly (no build). `tsx` is used across the repo.
- Branch `spec-flow-marketplace-package` (#56): the content source - G8-decoupled stage skills, the scripts engine, the adapter contract + `validate-adapter.mjs` + reference adapters, `/flow:init`, the thinned tick, docs. Engine 413 tests green.

## 3) Codebase Map

- **Flow content is SPREAD across four locations today (the thing the move must gather):**
  - `.agents/flow/` - skills, `scripts/` (oracles), `adapters/` (SPEC + reference + fixtures), `engine/` (TS source + tests), `config*`, `templates/`, docs (CHARTER/README/SPEC).
  - `.claude/commands/flow/` (12 thin stage commands) + `.claude/commands/flow.md` (the orchestrator).
  - `.claude/hooks/flow-loop.mjs` (the `/flow auto` Stop hook).
  - `.dork/tasks/flow-drain/` (the Pulse cron tick).
- **Target plugin skeleton** (from the scaffolder): `plugins/flow/{.dork/manifest.json, .claude-plugin/plugin.json, README.md, commands/, skills/, hooks/, scripts/, adapters/, config/, package.json}`. The four spread locations collapse into this ONE self-contained dir.
- **Marketplace machinery (exists, ready to consume a hand-authored plugin):** scaffolder + validator (`dorkos package init/validate`), the installer (`apps/server/src/services/marketplace/marketplace-installer.ts` + source-resolvers), the registry (`.claude-plugin/marketplace.json`).
- **Consumption surface in dorkos:** `claude --plugin-dir <path>` loads a plugin's commands + skills + hooks for a session (the manual `/flow` dogfood path). The Pulse cron tick is fired by the DorkOS server's task system, which scans task locations - a distinct integration from `--plugin-dir`.
- **Blast radius:** removing flow from dorkos touches `.agents/flow`, `.claude/commands/flow*`, `.claude/hooks/flow-loop.mjs`, `.dork/tasks/flow-drain`, plus the `tracker-confinement` guard (which lives in the engine and scans those roots - it moves with the engine into the plugin). dorkos's daily `/flow` usage is the live dependency that the sequencing must never break.

## 5) Research

- **Home structure - own repo vs marketplace subdir.** (1) Own repo `dork-labs/flow` linked via `github` source: fully independent releases/issues, but another repo to run + the marketplace links out. (2) **Subdir of `dork-labs/marketplace` (`plugins/flow/`)** linked via `relative-path`: matches how every existing plugin already lives, one repo for all marketplace content, simplest. **Recommendation: subdir** (operator-chosen). `git-subdir` remains available if it later wants an independent clone URL.
- **Runtime - ship `.ts` vs keep `.mjs`.** Once flow is one repo, source + build + output coexist, so the `.mjs` "split" pain disappears either way. **Ship `.ts` run directly** is simplest (no build; matches `.claude/scripts` precedent) and keeps full typing. The one zod user (`validate-config`) stays dependency-free in the shipped path by validating against the committed `config.schema.json` (zod remains a dev-only dep for authoring the schema + tests). Node floor: `--experimental-strip-types` needs Node 22.6+ (documented); `tsx` is the fallback for older Node. **Recommendation: ship `.ts`, zero-runtime-dep shipped path, Node 22.6+ documented.**
- **Consumption + sequencing (the risk-bearing part).** dorkos must never lose a working `/flow`. **Recommended order:** (1) stand up `plugins/flow/` in the marketplace repo from #56's content, restructured + `.ts`-ified; (2) prove it standalone (engine tests green, scripts run, `dorkos package validate` passes); (3) wire dorkos to consume it via `claude --plugin-dir <marketplace-clone>/plugins/flow` and verify `/flow` works end-to-end against the external plugin; (4) ONLY THEN remove dorkos's in-repo flow source. The Pulse cron tick consumption (server task system vs plugin location) is the one genuinely-unresolved integration - v1 dogfoods MANUAL `/flow` (commands/skills/hook via `--plugin-dir`); the autonomous tick can interim-stay as a thin `.dork/tasks/flow-drain` in dorkos that points at the plugin, with full plugin-task consumption flagged for the spec.
- **ADRs.** Supersede ADR-0281 (DOR-134 carries it). New ADRs warranted: external-canonical-home; ship-`.ts`-run-directly (retire the esbuild-`.mjs` decision ADR-0294); dorkos-as-consumer (interim `--plugin-dir`, DOR-172 for the blessed loop).
- **CI / tests.** The engine's 413 tests + the conformance + adapter tests move with the plugin and run in the marketplace repo's CI (the plugin's own `package.json test`). dorkos's CI drops the flow engine suite when the source leaves.

**Recommendation:** Proceed as a sequenced migration: build the self-contained `plugins/flow/` in the marketplace repo (from #56's content, `.ts`-shipped), prove it, consume it from dorkos via `--plugin-dir`, then remove dorkos's in-repo flow. Resolve the cron-tick consumption in the spec; manual `/flow` dogfood does not depend on it.

## 6) Decisions

| #   | Decision                    | Choice                                                                                                                                                             | Rationale                                                                                                 |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1   | Canonical home              | A self-contained plugin at `dork-labs/marketplace/plugins/flow/`, NOT in dorkos                                                                                    | Operator-firm: 100% of flow in one external location; matches existing plugin layout; supersedes ADR-0281 |
| 2   | Plugin structure            | `.dork/manifest.json` + `.claude-plugin/plugin.json` + `commands/` + `skills/` + `hooks/` + `scripts/` (`.ts`) + `adapters/` + `config/` + a dev `package.json`    | The scaffolder's canonical plugin shape; collapses today's 4 spread locations into one dir                |
| 3   | Runtime                     | Ship `.ts`, run directly via `node --experimental-strip-types` (tsx fallback); no compiled `.mjs`                                                                  | No source/artifact split; keeps typing; in-repo precedent; once one repo, build-vs-no-build is low-stakes |
| 4   | zod / validate-config       | Shipped runtime is dependency-free (validate against committed `config.schema.json`); zod stays a dev-only dep                                                     | Keeps the whole shipped plugin zero-runtime-dep; no adopter install/build                                 |
| 5   | dorkos consumption          | Consume via `claude --plugin-dir` (interim); remove dorkos's in-repo flow source ONLY after consumption is proven                                                  | Operator-firm dorkos-as-consumer; sequencing guarantees dorkos never loses a working `/flow`              |
| 6   | Pulse cron tick consumption | v1 dogfoods MANUAL `/flow`; the autonomous tick interim-stays as a thin dorkos `.dork/tasks/flow-drain` pointer; full plugin-task consumption deferred to the spec | The server task system vs plugin-location integration is unresolved; manual `/flow` does not depend on it |
| 7   | Migration sequencing        | stand up plugin -> prove standalone -> consume from dorkos via `--plugin-dir` -> remove dorkos's flow                                                              | The only ordering where dorkos is never without a working `/flow`                                         |
| 8   | ADRs                        | Supersede ADR-0281 (DOR-134) + ADR-0294 (esbuild-`.mjs`); add ADRs for external-canonical-home, ship-`.ts`, dorkos-as-consumer                                     | A direction reversal must be auditable; the prior ADRs are now wrong                                      |
| 9   | Tests / CI                  | Engine + conformance + adapter tests move with the plugin and run in the marketplace repo's CI                                                                     | Tests follow their source; dorkos CI sheds the flow suite                                                 |
| 10  | Dependency posture          | Do NOT block on DOR-145/146/147/148 or DOR-138; capture the dev-loop cleanup as DOR-172                                                                            | `--plugin-dir` + the marketplace install path exist today; the rest is ergonomic polish                   |

**Next step:** SPECIFY (`/flow:specify flow-plugin-extraction`). The genuinely-open item the spec must resolve is the Pulse-tick consumption (decision 6); everything else is settled here.
