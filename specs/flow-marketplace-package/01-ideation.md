---
slug: flow-marketplace-package
number: 264
created: 2026-06-26
status: ideation
linearIssue: DOR-133
---

# Ship /flow as a portable DorkOS Marketplace plugin

**Slug:** flow-marketplace-package
**Author:** Dorian
**Date:** 2026-06-26

> Anchored to the existing umbrella **DOR-133 - Assemble .agents/flow/ into a
> self-contained marketplace package** (Flow Engine - Harness project). This is the
> ideation for that issue, not a new parallel effort. Governing ADR: **ADR-0281**
> (proposed; to be amended via **DOR-134**). Roadmap: `plans/agent-harness-portability-roadmap.md`.

---

## 1) Intent & Assumptions

- **Task brief:** Make `/flow` a portable, installable DorkOS Marketplace **plugin** so any
  project (not just this repo) can adopt the workflow engine. Today `/flow` is a plugin-shaped
  subsystem (11 commands + 8 skills + the `flow-loop` Stop hook + config + the `@dorkos/flow`
  typed package) that only runs in-repo. The package must be a `plugin` type (a skill-pack
  cannot carry the commands or the hook) and is natively installable via `claude plugin install`
  because DorkOS's registry is a strict superset of Claude Code's format.

- **Assumptions (confirmed against ADR-0281 + the roadmap):**
  - **Repo home is settled:** the canonical source stays in this repo at `.agents/flow/`; the
    marketplace package is a **build artifact** assembled by `dorkos package build` (C1 / DOR-145)
    and projected by the Harness Sync engine (B4 / DOR-138). There is **no separate repo**.
    The harness sync engine + package build are exactly what de-risk the source/engine drift concern.
  - The deterministic engine and the prose skills ship as **one unit** from that one source; the
    package is generated, so they cannot drift.
  - Autonomy v1 is **bring-your-own-scheduler** (manual + `/flow auto` + a schedulable tick fired
    by the DorkOS task-scheduler OR OS-cron / CI). The P5 server (DOR-88/90/95) is the **premium**
    autonomy host, not a prerequisite. Claude Code has no native scheduler (plugin "monitors" are
    session-scoped, not crons).
  - `agentskills.io` and Anthropic endorse bundling tested deterministic code in `scripts/`
    ("sorting a list via token generation is far more expensive than running a sorting algorithm").

- **Out of scope (tracked elsewhere, do not absorb):**
  - Cross-agent projection (Codex / Cursor / Gemini): workstream **B / Harness Sync**
    (DOR-131, DOR-137..144). v1 is Claude-first.
  - The P5 server engine (DOR-88 / DOR-90 / DOR-95).
  - Marketplace **platform** tooling this work forces but does not own: `dorkos package build`
    (DOR-145), `--plugin-dir` dev loop (DOR-146), install provenance (DOR-147), `dorkos contribute`
    (DOR-148), the install-time config/first-run convention (DOR-159), package-layers-as-capabilities
    (DOR-160), the tasks-as-skills unification (DOR-150 / DOR-151 / DOR-152).

## 2) Pre-reading Log

- `decisions/0281-ship-flow-as-dorkos-marketplace-plugin-package.md`: proposed; build `.agents/flow/`
  as a `plugin`-type package from P1; v1 layers commands/skills/hooks/templates; `.agents/` stays the
  cross-harness glue; end-state is a self-contained, projected package.
- `plans/agent-harness-portability-roadmap.md`: the through-line is "one canonical source `.agents/<name>`,
  projected to every agent." Projection mechanism per artifact (skills = symlink, hooks/commands = generate).
  Workstreams A (this), B (projection), C (marketplace authoring), D (tasks/skill unification). A4 = DOR-133.
- `.agents/flow/skills/linear-adapter/SKILL.md`: the tracker adapter is a **prose contract** (no code
  adapter exists); it normalizes Linear into the generic `WorkItem` shape via 13 capability verbs and is
  the single audit surface for tracker I/O.
- `packages/flow/src/` (`@dorkos/flow`): the pure oracles (`selectDispatch`, `resolveInvolvement`, gates,
  recovery, dedup) + the Zod config schema; **private, version 0.0.0, imported by nothing**; imports are
  all `import type` (erased), so the decision oracles compile to dependency-free `.mjs`.
- `apps/server/src/services/tasks/` + `.dork/tasks/flow-drain/SKILL.md`: a task is a `SKILL.md` + scheduling
  frontmatter; the scheduler/watcher/UI/API are origin-blind (any task file at a watched path appears);
  the only gap is that the installer does not copy a plugin's task files.
- `packages/skills/src/schema.ts`: `SkillFrontmatterSchema` already has an optional `kind` field
  (ADR-0229) + `TaskFrontmatterSchema` (`cron`/`timezone`/`enabled`) + `CommandFrontmatterSchema`
  (`disable-model-invocation`).
- `contributing/marketplace-registry.md` + `marketplace-packages.md`: 4 package types (plugin/agent/skill-pack/
  adapter); the `marketplace.json` + `dorkos.json` sidecar superset; layer taxonomy.
- `agentskills.io` (overview, using-scripts, best-practices): `scripts/` is a first-class skill folder;
  progressive disclosure (SKILL.md < ~500 lines, push depth to `references/`); calibrate prescriptiveness.
- `research/20260626_plugin_config_and_iteration_patterns.md`: per-project config patterns (cosmiconfig /
  Terraform: committed config + gitignored `.local` + env); Raycast as the "fork installed extension + PR back"
  precedent (enabled by a central monorepo + recorded upstream URL).
- Marketplace clone at `/Users/doriancollier/Keep/dork-os/marketplace`: same-repo monorepo; 10 stub plugins;
  no install-time config or update conventions yet.

## 3) Codebase Map

- **Primary components / modules:**
  - `.agents/flow/` - the canonical source (skills, `config.json` + `config.schema.json`, templates, manifest).
  - `.claude/commands/flow*` + `.claude/commands/flow/` - the 11 commands (Claude-native, registered not synced).
  - `.claude/hooks/flow-loop.mjs` - the autonomous-drain Stop hook (already portable: only `node:fs`/`node:path`).
  - `packages/flow/src/` - `@dorkos/flow`, the to-be-deleted typed engine (becomes `scripts/`).
  - `.agents/flow/skills/linear-adapter/SKILL.md` - the tracker adapter (to become a generated, user-owned adapter).
  - `apps/server/src/services/tasks/` - the task scheduler (the `flow-drain` host where DorkOS runs).
  - `packages/marketplace/` + `apps/server/src/services/marketplace/` - the package schema + install runtime.
- **Shared dependencies:** `@dorkos/skills` (frontmatter schemas + the `kind`/task/command extensions); the
  `WorkItem` contract; the config Zod schema (`generate-config-schema`).
- **Data flow:** `linear-adapter` (MCP / Composio) -> normalized `WorkItem[]` -> the oracle (`scripts/`) ->
  ranked pick -> stage skills act. Fetch is agentic; rank/gate/dedup is deterministic.
- **Feature flags / config:** `.agents/flow/config.json` (per-repo, committed) + a future gitignored
  `.local` for secrets + env override; the bundled tick is `enabled: false` by default.
- **Potential blast radius:** delete `packages/flow` (move oracles to `scripts/`, update the never-yet-built
  server consumers DOR-88/90/130); decouple ~64 leaked Linear/`DOR` references out of the 8 generic stage
  skills (G8); the task system (capability model, DOR-150); marketplace `layers` (DOR-160); the install
  pipeline (config + tasks-layer handlers, DOR-159 + DOR-152).

## 5) Research

**Potential solutions considered (with the path chosen):**

1. **The deterministic engine: keep `@dorkos/flow` as a package, vs collapse into the plugin's `scripts/`.**
   The package is unused (imported by nothing) and its decision oracles are dependency-free once compiled.
   Keeping it as a separate npm artifact reintroduces the prose/engine drift the charter forbids and splits
   the unit across two homes. **Chosen: collapse into `scripts/`, delete the package** (D1). Stage skills
   call `node scripts/dispatch.mjs` instead of re-deriving the ladder in prose: deterministic, ~0-token,
   no drift. The future server shells out to / vendors the same scripts.

2. **Autonomy: requires the DorkOS server, vs bring-your-own-scheduler.** The only reason autonomy "needs the
   server" today is that the `flow-drain` tick happens to be fired by the server's task-scheduler. A scheduler
   is a commodity: OS-cron / CI can fire the same server-free `/flow auto`/tick. **Chosen: BYO-scheduler**
   (D2); the server is the premium host (token-efficient idle ticks via a deterministic pre-check, live cockpit).

3. **Task model: `kind: task` discriminator, vs additive capabilities from frontmatter.** A single skill can be
   agent-invoked AND a slash command AND scheduled at once; a single `kind` forces one and loses the others.
   The safety concern behind `kind: task` (don't auto-schedule on a stray `cron`) is better served by the
   `enabled` gate (a structured `cron` field + `enabled: true`, default false). **Chosen: capabilities, not
   `kind`** (D3/D5); this supersedes the roadmap's ADR-C and amends ADR-0229. Marketplace `layers` likewise
   become capability labels one skill lights up several of (DOR-160).

4. **Tracker adapter: ship our Linear adapter, vs an adapter-builder.** We have exactly one adapter, welded to
   our MCP + Composio + `DOR` setup; most adopters need their own (Jira, GitHub Issues, a different Linear
   wiring). **Chosen: ship the contract + a builder** (D4): an adapter contract (`SPEC.md` + the `WorkItem`
   schema + the 13 verbs + a `scripts/validate-adapter.mjs` conformance test), a `building-adapters` skill, and
   reference adapters. The concrete adapter is generated into the consuming repo at `/flow:init`, and must pass
   the conformance test (generate-and-verify). One plugin; the adapter is user-owned code.

5. **The scheduled tick's content: re-describe the loop, vs a thin delegating trigger.** A scheduled tick is one
   `runTick` pass (recovery -> inbox -> dispatch one item -> carry to gate -> stop), not the continuous
   `/flow auto` loop (which loops in one session via the sentinel + Stop hook). **Chosen: a thin schedulable
   skill** (D6) that delegates to the canonical single-tick procedure; the scheduler provides repetition.

**Recommendation:** the six decisions in section 6, assembled into a single `plugin`-type package built from
`.agents/flow/` (no separate repo), Claude-first, manual + BYO-scheduler-autonomy in v1, with the P5 server as a
later premium host. Progressive disclosure throughout (thin `SKILL.md`s, depth in `references/`).

## 6) Decisions

| #   | Decision                           | Choice                                                                                                                                                                                           | Rationale                                                                                                                                                             |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Fate of the `@dorkos/flow` package | **Delete it; move the pure oracles to the plugin's `scripts/` as compiled, dependency-free `.mjs`** (authoring stays TS + tests in `.agents/flow/`)                                              | Unused package; deterministic + ~0-token vs prose re-derivation; kills drift; one unit. Server consumers (DOR-88/90/130) shell-out / vendor, not `import`.            |
| D2  | How autonomy runs                  | **Bring-your-own-scheduler:** one tick SKILL.md fired by the DorkOS task-scheduler (premium) OR OS-cron / CI (server-free)                                                                       | CC has no native scheduler; a scheduler is a commodity; unblocks autonomy without the P5 server. ADR-D's production-gate + leader-lock still governs the server path. |
| D3  | Task / skill / command model       | **Additive capabilities derived from frontmatter, not a single `kind`;** scheduling gate = structured `cron` + `enabled: true` (default false)                                                   | One skill can be agent-invoked + slash command + scheduled simultaneously; `enabled` is the safety opt-in. Supersedes ADR-C; amends ADR-0229. (DOR-150)               |
| D4  | Tracker adapter                    | **Ship an adapter-builder triad** (contract + `building-adapters` skill + reference adapters + a conformance-test script); generate the concrete adapter into the consuming repo at `/flow:init` | We have one bespoke adapter; adopters need their own. Generate-and-verify keeps the generic engine safe. One plugin, adapter is user code.                            |
| D5  | Marketplace `layers`               | **Capability / effect labels derived from frontmatter, one skill lights up several** (a scheduled skill = `skills` + `tasks`); not separate content buckets                                      | Same file type; `tasks` survives as a distinct _risk_ label (autonomous execution), not a directory. (DOR-160)                                                        |
| D6  | `/flow:drain` content              | **A thin schedulable skill** that delegates to the canonical single-tick (`runTick`) procedure; NOT `/flow auto` (which loops)                                                                   | One tick per cron fire; the scheduler repeats; no duplicated reconciler logic. (DOR-152)                                                                              |
| D7  | Repo home                          | **Canonical source stays in `.agents/flow/` (this repo); the package is assembled (C1) + projected (B4); no separate repo**                                                                      | Settled by ADR-0281 + the roadmap; the harness sync engine + `package build` de-risk drift; dorkos dogfoods as source + consumer.                                     |

**Recommended next step:** SPECIFY (`/flow:specify flow-marketplace-package`). The specification should formalize
the six-plus-one decisions, the dependency/sequencing map (DOR-133 needs C1 + B4 for final assembly; the scripts
refactor, adapter-builder, capability tick, and `/flow:init` can land in `.agents/flow/` first), the G8
Linear-decoupling work item, and seed the ADR amendments (ADR-0281 via DOR-134; ADR-0229 via DOR-150).
