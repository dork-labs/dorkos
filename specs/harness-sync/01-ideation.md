---
slug: harness-sync
number: 267
created: 2026-06-29
status: ideation
linearIssue: DOR-154
---

# Harness Sync — project one canonical agent source to every harness

**Slug:** harness-sync
**Author:** Dorian
**Date:** 2026-06-29

> Anchored to **DOR-154 - Ideation: Harness Sync scope, personas, cross-agent UX,
> discovery model** (project **Harness Sync**, `bc4e663f`). This is workstream **B**
> of `plans/agent-harness-portability-roadmap.md` (the B1 ideation gap the roadmap
> flagged as unfilled). DOR-135 was the terse first draft of this same step and is
> closed as a duplicate of DOR-154. Governing ADR drafts: **ADR-A** (canonical
> `.agents/` + hybrid projection) and **ADR-B** (instructions scaffolded, not
> generated), roadmap §8 — to be formalized via `/adr:from-spec` once the spec exists.
> Prior design: `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md`.

---

## 1) Intent & Assumptions

- **Task brief:** Productize **Harness Sync** — the capability that takes one
  canonical source of agent files (`.agents/<name>`: skills, instructions, hooks,
  commands) and **projects it to every harness** a developer runs (Claude Code,
  Codex, Cursor, Gemini, Copilot). DorkOS already abstracts the agent _runtime_
  (the `AgentRuntime` interface — how the server drives Claude Code / Codex). The
  missing complement is abstracting the _files each agent reads_. That complement
  is Harness Sync, and the roadmap's through-line is that it is a **core platform
  capability, not a script**: "author once, run in Claude, Codex, or Cursor."

- **Personas (the jobs to shape against):**
  - **Kai (primary) — author once, run anywhere.** Runs many agents across many
    projects and harnesses. He should write a skill/hook/command once in `.agents/`
    and have it appear, correctly transformed, in whichever harness he opens — with
    zero hand-copying and no silent format drift.
  - **Priya (secondary) — reads source before adopting.** She must be able to see
    _why_ a given asset is shared, projected, or tool-only, and trust that the
    projector never lies about what an agent actually supports. Honesty over false
    parity is her adoption gate.

- **Assumptions (validated against the code + roadmap §4, §5, ADR drafts):**
  - **Canonical source = `.agents/<name>`** (Codex-native; a convention, not a
    standard — see §3). ~30% of the substrate already exists: `.agents/skills/`
    (17 canonical skills), per-skill symlinks into `.claude/skills/`, and
    `.agents/harness.manifest.json` (a hand-maintained, **unschema'd** 340-line JSON
    registry).
  - **Projection mechanism is chosen per artifact type, by whether the output format
    is identical to the source** (roadmap §4 / ADR-A) — this is already-settled
    direction, not an open question:

    | Artifact         | Format across agents           | Mechanism    |
    | ---------------- | ------------------------------ | ------------ |
    | **Skills**       | identical                      | **symlink**  |
    | **Instructions** | standard / `@import`           | **scaffold** |
    | **Hooks**        | differs (event names + schema) | **generate** |
    | **Commands**     | differs (frontmatter)          | **generate** |

  - **Borrow, don't adopt (ADR-A).** rulesync's value is its cross-agent _maps_
    (hook-event name tables, per-tool path constants) and _formats_, which are
    MIT-licensed static data. We **vendor** those and own the projector. We do **not**
    adopt rulesync-the-tool (it can't read `.agents/`, has no plugin API, and only
    copies — never symlinks, so it would regress our live skill-edit propagation).
  - **Instructions are scaffolded, never generated (ADR-B).** Preserve
    `.claude/CLAUDE.md = @../AGENTS.md` (Anthropic's zero-duplication pattern). Any
    generator excludes the `claudecode`/`agentsmd` instruction targets by default.
  - **Honesty over false parity.** Every projection emits a per-agent **drop list**:
    where an artifact has no home in a harness, say so explicitly — never silently omit.
  - We are the **uncommon case** (commands + hooks + per-agent targets + bidirectional
    awareness), which is exactly why ruler is insufficient and rulesync needs forking
    or vendoring rather than adoption.

- **Out of scope (this ideation — explicitly deferred, not dropped):**
  - **Resolving the B2 spike decisions.** The discovery model (per-file `targets`
    vs `harness.manifest.json`), the vendor-vs-submodule-vs-fork choice for the
    rulesync maps, and the fate of `harness.manifest.json` (schema-and-keep vs retire)
    are **framed as open decisions below** and are the explicit job of the spike
    (**DOR-136**). Deciding them now would pre-empt the prototype that should decide them.
  - **The "Harnesses" UI/UX surface** (B10 / DOR-144) — its own spec+design lives in
    **DOR-137**. This ideation shapes only the _conceptual_ UX (target selection,
    per-artifact status, drift, drop list), not the visual design.
  - **Adjacent workstreams:** Tasks execution-safety + skill unification (workstream
    D) and Marketplace authoring/contribution (workstream C) are separate projects.
  - **Building anything.** This is shape-only; the engine is B4 (DOR-138).

## 2) Pre-reading Log

- `plans/agent-harness-portability-roadmap.md` (§1 through-line, §4 projection model,
  §6 workstream→project map, §7.B issues B1–B11, §8 ADR drafts A–F, §9 sequencing,
  §10 open questions): the authoritative source. Harness Sync is workstream B; the
  projection-mechanism-per-artifact decision and the "borrow not adopt" basis are made
  here.
- `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md` (299 lines):
  the existing proto-design. Defines the canonical/tool-native location tables, asset
  **Class A/B/C** taxonomy (shared / projected / tool-only), per-artifact projection
  strategy, the manifest field concepts, conflict-resolution rules, a 3-phase rollout,
  and its own open questions. Harness Sync productizes this internal-tooling design.
- `.agents/harness.manifest.json`: the live registry — `version: 1`, with
  `sharedSkills`, `claudeOnlySkills`, `skillWrappers`, `commandMappings`,
  `instructionProjections`, `hookPolicies`, `skillBundles` (the flow bundle). Hand-JSON,
  no Zod schema, no validator.
- `apps/server/src/services/core/agent-creator.ts` (`createAgentWorkspace`): the shared
  agent-creation service (called by the client `POST /api/agents/create` and the MCP
  `create_agent` tool). Scaffolds `SOUL.md`/`NOPE.md`/`.dork/agent.json`, and AGENTS.md
  **only for DorkBot**. Net-new instruction scaffolding (B8) hooks here.
- `specs/flow-plugin-extraction/01-ideation.md` (#266, **implemented**): the `/flow`
  plugin was already assembled + extracted by hand. It is the **worked example** Harness
  Sync generalizes — proof the assemble-and-project pattern works, done once manually.

## 3) Codebase Map

- **Canonical substrate (`/.agents/`):**
  - `.agents/skills/` — 17 canonical skill dirs (source of truth).
  - `.agents/flow/` — the assembled flow bundle (`manifest.json`, 8 skills, templates,
    `config.json` + `config.schema.json`).
  - `.agents/harness.manifest.json` — the registry (unschema'd JSON; **B6** decides its fate).
- **Existing projection (the 30% that's built):** per-skill **symlinks**
  `.claude/skills/<name> → ../../.agents/skills/<name>` (created manually / ad hoc; no
  engine). Codex reads `.agents/skills/` natively → zero projection for Codex skills.
- **The design prose:** `syncing-agent-skills` skill + its `sync-harnesses-spec.md`
  references (Class A/B/C taxonomy, conflict rules). No implementation code.
- **Instruction-scaffolding hook point:** `services/core/agent-creator.ts`
  (`createAgentWorkspace`) — the one shared service all surfaces (client UI, MCP) route
  through. B8 + B11 land here. Today it scaffolds AGENTS.md only for DorkBot.
- **Distribution surfaces:** `packages/cli` (home of a `dorkos harness sync --check/--fix`
  or `generate --check` command, **B7**); the React client (home of the "Harnesses" UI,
  **B10**); `services/core/` (the standard home for shared engine logic the CLI reaches
  via the server API — the `dorkos install` pattern).
- **Potential blast radius:** anything that reads agent files — `.claude/`, `.cursor/`,
  `.gemini/`, `.github/`; the marketplace install/scaffold path (a package's skills/hooks
  must project on install); `createAgentWorkspace` (every new agent). Generation must be
  **idempotent and drift-checkable** (a `--check` mode that never writes) because it
  rewrites tracked files across many directories.

## 5) Research

### 5.1 The projection model (settled direction)

Because **we own the projector**, we keep symlinks where the format is identical (the
thing rulesync structurally cannot do) and generate only where a transform is required.
This preserves today's live skill-edit propagation while adding cross-agent hooks/commands.
The per-artifact mechanism table (Intent §) is the spine of the engine (B4).

### 5.2 Per-harness support matrix + the honest drop list

The "works in every agent" UX rests on a matrix that is deliberately **incomplete** —
the gaps _are_ the drop list, surfaced, never hidden. (Cells marked _verify_ are to be
confirmed during the per-agent generators work, B9 / DOR-143.)

| Artifact         | Claude Code                                     | Codex (native)                        | Cursor                                 | Gemini                      | Copilot                                    |
| ---------------- | ----------------------------------------------- | ------------------------------------- | -------------------------------------- | --------------------------- | ------------------------------------------ |
| **Skills**       | `.claude/skills/` symlink                       | `.agents/skills/`                     | optional `.cursor/` _or_ rely on rules | _drop_ (no skill primitive) | _drop_ (no skill primitive)                |
| **Instructions** | `CLAUDE.md` `@import` AGENTS.md                 | `AGENTS.md` native                    | `AGENTS.md` native / `.cursor/rules`   | `GEMINI.md` _verify_        | `.github/copilot-instructions.md` _verify_ |
| **Hooks**        | `.claude/settings.json` (5-event portable core) | _drop_ (no repo hook primitive)       | _drop_                                 | _drop_                      | _drop_                                     |
| **Commands**     | `.claude/commands/`                             | _drop_ → map to skill/AGENTS workflow | _drop_                                 | _drop_                      | _drop_                                     |

The portable hook core is the five events shared across harnesses where they exist
(PreToolUse / PostToolUse / SessionStart / Stop / UserPromptSubmit); anything outside
that core is an honest per-agent drop.

### 5.3 Vendoring the rulesync maps (options, decided in the spike)

The cross-agent maps (`CANONICAL_TO_*_EVENT_NAMES`, per-tool path constants) are
module-internal in rulesync — not exported — so borrowing means one of:

1. **Vendor the constants** (copy the MIT static data into the repo + attribution + a
   documented re-vendor checklist). _Lean per roadmap §10._ Pro: zero runtime coupling,
   we control fields/targets. Con: manual periodic re-vendor.
2. **Pinned git submodule.** Pro: traceable upstream. Con: submodule friction; still no
   export surface, so we'd reach into internals.
3. **Fork.** Pro: full control. Con: ongoing fork-maintenance burden for data that
   rarely changes.

### 5.4 Discovery model (the central open question)

How does the projector know which artifacts project where?

- **(A) Per-file `targets`** — each artifact declares its own targets in frontmatter
  (rulesync-style). Pro: co-located, no central registry to drift. Con: must scan every
  file; harder to get a global view.
- **(B) Central `harness.manifest.json`** (schema'd) — one registry lists shared skills,
  wrappers, command mappings, instruction projections, hook policies. Pro: single global
  view, already partially built. Con: a second source of truth that can drift from the files.
- **(C) Hybrid** — manifest for cross-cutting policy (hook policies, command mappings,
  exceptions) + per-file `targets` for the common per-artifact case.

This is **B2/B6** and is left open here on purpose; the spike prototypes against Codex
(cheapest — skills are near-zero) and lets the prototype decide.

### 5.5 Recommendation (direction, not the spike's verdict)

Build the **engine library (B4)** as the core deliverable: a pure, idempotent,
`--check`-capable projector that symlinks identical-format artifacts, scaffolds
instructions, and generates transformed ones from vendored maps, emitting an explicit
drop list per run. Sequence the harness generators by payoff (Codex → Cursor → Gemini →
Copilot). Gate the spec (B3 / DOR-137) on the spike (B2 / DOR-136), because the discovery
model and vendoring choice materially change the engine's shape. Do **not** jump straight
to spec.

## 6) Decisions

Settled here (carried from the roadmap's reviewed direction) versus explicitly deferred to
the spike. **Open** rows are not unresolved ambiguity in _this_ ideation — they are scoped
to **DOR-136** by design.

| #   | Decision                                                   | Choice                                                              | Status / Rationale                                              |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Canonical source location                                  | `.agents/<name>`                                                    | **Settled** — Codex-native, already the substrate (ADR-A).      |
| 2   | Projection mechanism                                       | Per-artifact: symlink / scaffold / generate                         | **Settled** — roadmap §4 / ADR-A; preserves live skill edits.   |
| 3   | rulesync relationship                                      | Borrow formats + maps (vendored, MIT); do **not** adopt the tool    | **Settled** — ADR-A; the tool can't read `.agents/` or symlink. |
| 4   | Instruction files                                          | **Scaffold**, never generate; keep `CLAUDE.md = @../AGENTS.md`      | **Settled** — ADR-B; zero-duplication, Anthropic-recommended.   |
| 5   | Parity philosophy                                          | Honesty over false parity — explicit per-agent drop list            | **Settled** — no silent omission; Priya's adoption gate.        |
| 6   | First generator target                                     | **Codex** (skills near-zero), then Cursor → Gemini → Copilot        | **Settled** — sequence by payoff (B9).                          |
| 7   | Instruction-scaffolding home                               | `createAgentWorkspace` (shared service) + canonical agent templates | **Settled** — one service, all surfaces (B8/B11).               |
| 8   | Discovery model (per-file `targets` vs manifest vs hybrid) | —                                                                   | **OPEN → DOR-136 spike** (§5.4).                                |
| 9   | `harness.manifest.json` fate (schema-and-keep vs retire)   | —                                                                   | **OPEN → DOR-136 spike** (B6); follows #8.                      |
| 10  | Vendoring strategy (constants vs submodule vs fork)        | Lean: vendor constants                                              | **OPEN → DOR-136 spike** (§5.3); lean recorded, not decided.    |
| 11  | `harness sync` CLI vs `generate --check`                   | —                                                                   | **OPEN → DOR-136 spike** (B7); follows #8.                      |

## 7) Risks & Open Questions

- **Generation safety.** The projector rewrites tracked files across many dirs; it must
  be idempotent with a write-free `--check` mode, or it will fight git and other agents.
- **Manifest drift.** If the manifest stays (B6 = keep), it is a second source of truth;
  without a `--check` gate it silently desyncs from the files. (Argues for #8 → hybrid/per-file.)
- **Upstream map churn.** Vendored rulesync maps go stale when harnesses rename hook
  events / move paths; the re-vendor checklist must be real, not aspirational.
- **Gemini/Copilot specifics unverified** (matrix _verify_ cells) — confirm exact
  instruction filenames + any skill/command primitives during B9.
- **Coordination with "Universal Command Interface"** (roadmap §6 adjacency): that project
  owns runtime-neutral command _behavior_ inside DorkOS chat; Harness Sync owns the static
  _file_ generation. They must share the command-translation maps but stay distinct.

## 8) Recommended Next Step

**Move to the spike, not to spec.** The next `/flow` action on this project is the
time-boxed **DOR-136 spike** (B2): prototype the hybrid projector against Codex, decide
the discovery model (#8), the manifest fate (#9), and the vendoring strategy (#10). The
spec+design (**DOR-137** / B3) is gated on that spike's verdict. Concretely:

1. Ready **DOR-136** (`agent/ready`) as the project's next dispatch — it is now the
   critical-path root.
2. After the spike resolves decisions #8–#11, run **SPECIFY** on DOR-137 and seed ADR-A /
   ADR-B via `/adr:from-spec`.
3. Keep workstream A4 (assemble `/flow` as a plugin, which depends on the B4 engine) and
   the marketplace package work informed — Harness Sync is their upstream dependency.
