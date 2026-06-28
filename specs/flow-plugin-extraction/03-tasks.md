# Task breakdown: flow-plugin-extraction (spec #266)

Spec: `specs/flow-plugin-extraction/02-specification.md` (Linear DOR-133)

This breakdown moves `/flow`'s canonical home OUT of dorkos and into a single self-contained plugin at `dork-labs/marketplace/plugins/flow/`. dorkos becomes a consumer. The source material is the dorkos branch `spec-flow-marketplace-package` (the superseded #264 work, engine 413 tests green): that branch already produced the G8-decoupled stage skills, the oracle engine under `.agents/flow/engine/`, the adapter contract plus the `validate-adapter` conformance harness and the two reference adapters, `/flow:init`, the thinned `flow-drain` tick, and the docs. These tasks do not redo that work: they RELOCATE it into the marketplace repo, RESTRUCTURE it into the plugin layout, and `.ts`-ify it (the esbuild `.mjs` build is dropped; the source IS the runtime).

The one sequencing rule that never breaks dorkos's daily `/flow`: stand up the plugin (Phase 1), prove it standalone (Phase 2), wire dorkos to consume it and verify end-to-end (Phase 3), and ONLY THEN remove dorkos's in-repo flow source (Phase 4).

Two repos are in play:

- Marketplace repo: `/Users/doriancollier/Keep/dork-os/marketplace`, plugin at `plugins/flow/`, registry `.claude-plugin/marketplace.json`.
- dorkos repo: `/Users/doriancollier/Keep/dork-os/dorkos`.

Creating and pushing the plugin to the marketplace remote is outward-facing; the EXECUTE stage confirms before any push.

---

## Phase 1 — Stand up the plugin (in the marketplace repo)

### Task 1.1: Scaffold the plugins/flow/ skeleton, manifests, and dev package.json

Create the plugin root and its directory skeleton (`commands/`, `skills/`, `hooks/`, `scripts/`, `engine-tests/`, `adapters/`, `config/`, `docs/`), the package manifest `.dork/manifest.json` (type `plugin`, layers `["commands","skills","hooks"]`), the Claude Code manifest `.claude-plugin/plugin.json`, and the plugin's DEV-only `package.json` (derived from the branch's `@dorkos/flow-engine` package.json with esbuild and the `build` script removed, the `workspace:*` config deps removed, and zod kept dev-only). This is the head of the whole graph: everything else lands into this skeleton.

### Task 1.2: Copy the command surface and the flow-loop Stop hook (verbatim)

Copy the 13 command files (`flow.md` orchestrator plus the 12 stage commands) into `commands/`, and the `flow-loop.mjs` Stop hook into `hooks/`, byte-for-byte from the branch. The hook stays `.mjs` (it is a Stop hook, not an oracle). No oracle-path rewiring here; task 1.8 owns that.

### Task 1.3: Copy the skills surface and fold the flow-drain tick in as an inert skill

Copy all 10 skill directories from `.agents/flow/skills/` into `skills/`, and relocate `.dork/tasks/flow-drain/SKILL.md` into `skills/flow-drain/SKILL.md` preserving its `cron` + `enabled: false` frontmatter (inert in v1, no scheduler wired). No oracle-path rewiring here.

### Task 1.4: Copy the adapters contract, config triad, templates, docs, and README

Copy four disjoint content sets: `adapters/` (SPEC + reference adapters + fixtures), `config/` (config.json, config.schema.json, config.local.example.json, CONFIG.md), `docs/` (the eight `.mdx` guides plus CHARTER.md and SPEC.md), and fill the plugin `README.md` with plugin-relative paths.

### Task 1.5: Port the engine source and oracle CLI wrappers into scripts/ as runnable .ts; drop the esbuild build

The core `.mjs`-to-`.ts` conversion. Move the 19 engine source modules and the CLI wrappers into `scripts/` as `.ts`, convert `validate-adapter.mjs` to `validate-adapter.ts`, fix relative imports for `node --experimental-strip-types`, and drop `build.mjs` and every committed `*.mjs` oracle artifact. The runnable `.ts` files are the shipped runtime. (Largest, trickiest engineering; critical path.)

### Task 1.6: Rework validate-config to a zero-runtime-dependency check against the committed config.schema.json

The source `validate-config` relied on esbuild to bundle zod. Rework `scripts/validate-config.ts` to validate against the committed `config/config.schema.json` with a small embedded structural check, importing no zod at runtime. The zod schema module stays dev-only (schema generation + tests). (Second-trickiest engineering; critical path.)

### Task 1.7: Move the engine vitest suite into engine-tests/, wire it to the .ts scripts, and re-point the tracker-confinement guard

Move all 23 test files into `engine-tests/`, update their imports to the new `scripts/` layout, add `vitest.config.ts` + `tsconfig.json`, point the `scripts-cli` test at the runnable `.ts` entrypoints, and re-point the `tracker-confinement` guard's roots to the plugin's own dirs (with the adapter carve-out covering `adapters/reference/` + `skills/linear-adapter/`). (Critical path.)

### Task 1.8: Rewire every skill, command, and hook oracle invocation to node --experimental-strip-types .ts via the plugin root

Rewrite every `node .agents/flow/scripts/<oracle>.mjs` to `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/<oracle>.ts"` (with the `tsx` fallback documented for Node < 22.6) across `commands/flow.md`, the six oracle-calling skills, and the hook. Path-and-extension only; prose semantics and the JSON-in/JSON-out contract unchanged.

---

## Phase 2 — Prove standalone (in the marketplace repo)

### Task 2.1: Prove the plugin standalone — full suite green, oracles run, dorkos package validate passes

With all of Phase 1 assembled, make the 413-test suite green (including the re-pointed guard), smoke-run each oracle (a dry `dispatch.ts` on an empty queue, `validate-config.ts` against the committed config, both adapter fixtures pass/fail correctly), and make `dorkos package validate ./plugins/flow` pass. Fix all relocation fallout here.

### Task 2.2: Register the flow plugin in the marketplace registry via the relative-path source

Add the `flow` entry to `.claude-plugin/marketplace.json` with `source: "./plugins/flow"`, matching the existing entries' shape. JSON valid, diff scoped to the new entry. Pushing the registry change is outward-facing (EXECUTE confirms).

---

## Phase 3 — Wire dorkos as consumer (in the dorkos repo)

### Task 3.1: Wire dorkos to consume the external plugin via claude --plugin-dir and document the dogfood invocation

Add the repeatable `claude --plugin-dir <marketplace-clone>/plugins/flow` dogfood invocation (a dev convenience plus a doc note that this is the interim path, ADR-0299). Do NOT touch the in-repo `.agents/flow` source yet.

### Task 3.2: Verify /flow works end-to-end against the external plugin (the gate that authorizes removal)

Start a session with `--plugin-dir` and verify the external path: commands list from the plugin, a stage skill runs an oracle via `${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.ts`, the Stop hook loads, and a dry dispatch returns cleanly. Capture evidence. This green result is the explicit precondition for Phase 4; do not proceed on a red gate.

---

## Phase 4 — Remove flow from dorkos (in the dorkos repo)

### Task 4.1: Remove dorkos's in-repo flow source, the engine workspace entry, and the engine tests; confirm dorkos stays green

Delete `.agents/flow/`, `.claude/commands/flow*`, `.claude/hooks/flow-loop.mjs`, `.dork/tasks/flow-drain/`; remove the `.agents/flow/engine` entry from `pnpm-workspace.yaml` and any flow-specific turbo/tsconfig reference; purge stray `@dorkos/flow` references. Make `pnpm install`, `pnpm typecheck`, and `pnpm test -- --run` all green. Use an isolated worktree (multi-file, multi-commit tracked-source change).

### Task 4.2: Repoint dorkos docs at the external plugin and write the supersede + new ADRs

Rewrite the AGENTS.md `/flow` section and `contributing/flow-engine.md` to point at the external plugin and the `--plugin-dir` dogfood; supersede ADR-0281 (by ADR-0297) and ADR-0294 (by ADR-0298); add ADR-0297 (external canonical home), ADR-0298 (ship runnable `.ts`), ADR-0299 (dorkos consumes via `--plugin-dir`), and register the three new ADRs in `decisions/manifest.json`. Docs/decision-records only, so this runs in parallel with task 4.1.

---

## Dependency tree & parallelism

Critical path (longest chain, the engine spine through the gates):

`1.1 -> 1.5 -> 1.6 -> 1.7 -> 2.1 -> 2.2 -> 3.1 -> 3.2 -> 4.1`

Independent head: `1.1` is the only zero-dependency task (it stands up the plugin root + manifests). Everything fans out from it.

Phase 1 parallel fan-out (all depend only on `1.1`): `1.2`, `1.3`, `1.4`, `1.5` run concurrently. `1.2`/`1.3`/`1.4` are the independent verbatim-copy heads (disjoint file sets: commands+hook, skills, adapters+config+docs); `1.5` is the engine port on the critical path.

Phase 1 second wave: once `1.5` (and, for `1.6`, `1.4`) lands, `1.6` (validate-config), `1.7` (tests + guard), and `1.8` (rewire) proceed. `1.8` is independent of `1.6` and `1.7` (it edits commands/skills/hook prose, not the engine or tests), so `1.8` runs in parallel with `1.6` and `1.7`. `1.7` waits on `1.6` (the config-schema test must pass once validate-config is reworked).

The Phase 2/3 spine is strictly sequential (`2.1 -> 2.2 -> 3.1 -> 3.2`): the standalone proof gates registration, which gates consumption wiring, which gates the end-to-end verification.

Phase 4 fan-out: `3.2` (the never-break-dorkos gate) unblocks both `4.1` (source removal) and `4.2` (docs + ADRs), which run in parallel because they share no files (`4.1` deletes flow source and workspace wiring; `4.2` edits AGENTS.md, contributing docs, and decisions/).

The cross-repo boundary: tasks 1.1 through 2.2 act in the marketplace repo; tasks 3.1 through 4.2 act in the dorkos repo. The two outward-facing pushes (the plugin content, the registry entry) are confirmed by EXECUTE before they leave the local clone.
