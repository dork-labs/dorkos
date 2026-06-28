# Agent Harness Portability — Roadmap (post-/flow review)

**Status:** Draft for review · **Created:** 2026-06-16 · **Owner:** Dorian
**Origin:** This plan captures the decisions and follow-on work that emerged from the pre-wrap-up review of the `/flow` engine (spec `unified-workflow-system`). Without this document the reasoning lives only in a single chat session — capturing it is the point.

> **Note on provenance:** Everything below was derived by exploring the harness (code, ADRs, specs) and the external ecosystem (rulesync, ruler, AGENTS.md / AAIF, Codex/Cursor/Gemini/Windsurf hook + skill conventions), not from memory. Library/source findings reference cloned repos at `/tmp/osrc-rulesync` and `/tmp/osrc-ruler` as they were on 2026-06-16.

---

## 1. The through-line

A single idea connects everything we discussed: **one canonical source of truth (`.agents/<name>`), projected to every agent.** DorkOS already abstracts the _runtime_ (the `AgentRuntime` interface — how the server drives Claude Code / Codex / etc.). The missing complement is abstracting the _files each agent reads_ — skills, commands, hooks, instructions. That complement is **Harness Sync**, and it is a core platform capability, not a script: it is what makes agents genuinely swappable ("author once, run in Claude, Codex, or Cursor").

## 2. Guiding principles

1. **Capture decisions before building.** This document + ADRs + tracker issues are the insurance.
2. **Don't reinvent.** Adopt `AGENTS.md` (already done); borrow rulesync's _formats + cross-agent maps_ (vendored, MIT); build only the DorkOS-specific glue. Do **not** adopt rulesync-the-tool wholesale (hardcoded `.rulesync` dir, no plugin API, copy-only output).
3. **Less, but better.** Engine/CLI before UI. One canonical source, project everywhere. Retire subsystems (the dedicated tasks dir) rather than add.
4. **Wrap-up isn't hostage to new scope.** Land the `/flow` harness independently of the new architecture.
5. **Safety first.** The dev/preview task-execution gap can take _autonomous outward action_ (the `/flow` Pulse seat could claim Linear issues / open PRs from a dev server). Gate it early.
6. **Dogfood.** `/flow` is the first package to be assembled + projected; it proves the harness sync engine.

## 3. Key external findings (the "don't reinvent" basis)

- **`AGENTS.md` is a real Linux Foundation / AAIF standard** (backed by Anthropic, OpenAI, Google, MS, AWS) — but it standardizes only the _instructions file_, not skills/commands/hooks/directories.
- **`.agents/` is NOT a universal standard directory.** It is OpenAI Codex's native skills path (`.agents/skills/`), which several AGENTS.md-family tools also adopt. Claude uses `.claude/`, Cursor `.cursor/`, Gemini `.gemini/`. Our `.agents/` canonical choice is well-aligned with Codex (Codex reads it natively → zero projection for Codex) but is a convention, not a standard.
- **rulesync vs ruler:** rulesync wins for our use case (commands + hooks + per-agent `targets`, a real bidirectional IR). Ruler has no hooks, no commands, and broadcasts identical rule text to every agent. Ruler is more popular because it nails the simple "sync my rules" case; we are the uncommon case.
- **rulesync constraints:** source dir name `.rulesync` is hardcoded (only the parent is configurable via `--input-root`); no plugin API (new target/feature/field = fork); **output is always a written copy, never a symlink** (one open issue #902 floats an ephemeral `run` mode, no commitment, no watch mode); its valuable maps (`CANONICAL_TO_*_EVENT_NAMES`, per-tool path constants) are **module-internal, not exported** → borrowing = vendor/copy the constants (MIT, plain static data) or fork.
- **Instruction files:** rulesync _inlines_ content and has **zero awareness of Claude's `@path` import syntax**; enabling both `agentsmd` + `claudecode` targets duplicates content into `AGENTS.md` and `CLAUDE.md`. Our `.claude/CLAUDE.md = @../AGENTS.md` is exactly Anthropic's recommended zero-duplication pattern — rulesync would _regress_ it. **Guardrail: instruction files are scaffolded, never generated.**

## 4. The projection model (the core decision)

Choose the projection **mechanism per artifact type**, by whether the output format is identical to the source:

| Artifact                     | Format across agents                          | Mechanism                          | Notes                                                                                                          |
| ---------------------------- | --------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Skills** (`SKILL.md`)      | identical                                     | **symlink**                        | Live, single source, zero re-sync. Codex reads `.agents/skills/` natively → no projection at all.              |
| **Instructions** (AGENTS.md) | standard / import                             | **scaffold + `@import`**           | AGENTS.md canonical; CLAUDE.md imports it; Codex/Cursor read AGENTS.md directly. Excluded from generators.     |
| **Hooks**                    | differs per agent (event names + JSON schema) | **generate** (using vendored maps) | 5-event portable core (PreToolUse/PostToolUse/SessionStart/Stop/UserPromptSubmit); honest per-agent drop list. |
| **Commands**                 | differs per agent (frontmatter)               | **generate**                       | Claude-native today; generation for other agents is new work.                                                  |

Because **we own the projector**, we keep symlinks where the format is identical (the thing rulesync can't do) and generate only where transformation is required. This preserves our current live-edit propagation for skills while adding cross-agent hooks/commands.

## 5. CLI ↔ client ↔ scaffolding findings

- **Shared service layer exists:** `createAgentWorkspace` (`apps/server/src/services/core/agent-creator.ts`) is called by the client UI (`POST /api/agents/create`) and the MCP `create_agent` tool. **The CLI has no agent-creation command** (`dorkos init` = config wizard; `dorkos package init` = marketplace package scaffold).
- **Standard for new shared logic:** put it in `services/core/`; client calls it directly, CLI calls it via the server API (the `dorkos install` pattern).
- **Agent templates ARE marketplace packages (correction to an earlier claim):** the client "Create Agent → From Template" flow (`agent-creation/` → `TemplatePicker`) lists marketplace `agent`-type packages and passes `template: <pkg.source>` to `createAgentWorkspace`, which `giget`-clones it; the install-agent flow also applies the package's `agentDefaults`. So agent templating is real and marketplace-integrated (an arbitrary git URL is the Advanced fallback). There is still no generic _repo/project_ starter beyond agent templates.
- **AGENTS.md/CLAUDE.md are not scaffolded** except DorkBot's AGENTS.md. → Instruction scaffolding (B8) is net-new and has two homes: (a) defaults in `createAgentWorkspace` for blank agents, and (b) the canonical agent _templates_ (which are packages) should bundle AGENTS.md + `@import` CLAUDE.md so every templated agent inherits the best-practice setup.

## 6. Workstreams → Linear projects

| Workstream                                                                              | Linear project                                   | Status                                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **A. Flow harness wrap-up + ship-as-plugin**                                            | **Flow Engine — Harness** (`89b5b613…`)          | EXISTING — add issues                                                                  |
| **B. Harness Sync** (the cross-agent file-projection feature + instruction scaffolding) | **Harness Sync**                                 | NEW — create                                                                           |
| **C. Marketplace authoring, dev loop & contribution**                                   | **Marketplace — Authoring & Contribution**       | NEW — create (verify no existing marketplace project)                                  |
| **D. Tasks execution safety + skill unification**                                       | **Tasks — Execution Safety & Skill Unification** | NEW — create (note: "Tasks System Redesign" / spec-211 is the _completed_ predecessor) |

**Created 2026-06-16:** Harness Sync (`bc4e663f`), Marketplace — Authoring & Contribution (`98f7aabd`), Tasks — Execution Safety & Skill Unification (`276af021`); 20 issues filed across these + the existing Flow Engine — Harness project. No existing "Marketplace" project was found (full project list checked).

**Adjacency:** "Universal Command Interface" (existing) owns _runtime-neutral command behavior inside DorkOS chat_ (DOR-109 cross-agent aliases, DOR-110 operation-progress, DOR-111 context channel). Harness Sync (B) is the _static file generation_ complement. They must coordinate on the command-translation maps but are distinct projects.

## 7. Issues per project (high level)

### A · Flow Engine — Harness (existing)

- A1. Merge `origin/main` into the branch (5 behind, low conflict), then land the branch: push + open the PR (DOR-129)
- A2. Run the deferred shared-Linear read-only dry run (DOR-90 / P3 acceptance)
- A3. Merge + tear down the worktree
- A4. Assemble `.agents/flow/` into a real package (`.dork/manifest.json`, `.claude-plugin/plugin.json`, self-contained) — _depends on C1 + B engine_
- A5. Amend/supersede ADR-0281 to reflect the assembled-package + projection direction

### B · Harness Sync (new) — sequenced ideate → spike → spec → design → build

- B1. Ideation: scope, personas, "works in every agent" UX, discovery model
- B2. **Spike (time-boxed):** vendor vs submodule vs fork for rulesync maps; prototype the hybrid projector against **Codex** (cheapest — near-zero for skills); decide the fate of `.agents/harness.manifest.json` (add schema & keep vs retire in favor of per-file `targets`)
- B3. Spec + design (the "Harnesses" UI/UX surface)
- B4. Core harness sync engine library (symlink identical-format; generate transformed-format)
- B5. Vendor rulesync maps (hook event tables + per-tool path constants) + documented re-vendor/update process
- B6. `.agents/harness.manifest.json` → Zod schema OR retirement (outcome of B2)
- B7. `dorkos harness sync --check/--fix` (or `generate --check`) — outcome of B2
- B8. Instruction scaffolding: AGENTS.md + `@import` CLAUDE.md + per-agent pointers, hooked into `createAgentWorkspace` (shared service → all surfaces)
- B9. Per-agent generators, by payoff: Codex → Cursor → Gemini → Copilot (honest per-agent drop list; no silent omission)
- B10. "Harnesses" UI surface: target selection, per-artifact status, drift indicator + re-sync, marketplace integration
- B11. **Integrate projection into agent creation:** on "Create Agent" (especially _From Template_), run harness projection so the template's skills/commands/hooks land in the user's enabled harnesses, and ensure instruction scaffolding (B8). The create-agent flow is also the natural home for the "which harnesses?" selection (ties to B10). _Builds on the existing marketplace agent-template picker._

### C · Marketplace — Authoring & Contribution (new)

- C1. `dorkos package build` (assemble `.agents/<name>/` → installable; reuse `scaffolder.createPackage` + `validatePackage`)
- C2. Adopt `claude --plugin-dir` as the documented Claude dev loop + per-harness dev-loop docs
- C3. Record install **provenance** (source repo + ref + tree SHA) at install time — small; prereq for C4
- C4. `dorkos contribute <package>` (gh fork + diff vs installed baseline + PR, from point of use)

### D · Tasks — Execution Safety & Skill Unification (new)

- D1. **Execution safety guard (urgent):** production-gated firing by default (dev/preview servers don't fire) + `dorkHome`-keyed leader lock + dispatch idempotency keyed on `(taskId, scheduledFireTime)`
- D2. Tasks unification: discover tasks via the skill scan; schedule iff explicit `kind: task` (not mere presence of `cron`); retire the dedicated tasks watcher as a separate subsystem
- D3. `dorkos tasks list` (the effective scheduled set, for auditability)
- D4. flow-drain ships inside the flow plugin (folds into A4 once unification lands)

## 8. Decisions to formalize (ADR drafts)

> These are drafted here for review. Formalize via the ADR tooling (`/adr:from-spec` once the Harness Sync spec exists, or `/adr:create`) so `decisions/manifest.json` stays 1:1 with files (avoid the orphan-drift class of bug). Numbers shown are indicative (next free is 283 after the merge; our flow-unify ADR was renumbered 273→282 to resolve a collision with main's runtime-neutral-context ADR).

**ADR-A · Canonical `.agents/` + hybrid projection; borrow rulesync formats/maps, don't adopt the tool.**

- _Context:_ Skills/commands/hooks/instructions must work across Claude Code, Codex, Cursor, etc. rulesync/ruler can't read `.agents/`, have no plugin API, and only copy (no symlink). Their cross-agent maps are the hard-to-rebuild IP.
- _Decision:_ Keep `.agents/<name>` as the canonical source. Project per artifact type — **symlink** identical-format artifacts (skills), **generate** transformed ones (hooks, per-tool commands) using **vendored** rulesync maps. Do not adopt rulesync-the-tool. Own the projector.
- _Consequences:_ + live-edit propagation for skills, control over targets/fields, no fork burden. − we maintain vendored maps (manual periodic re-vendor) and the projector itself.

**ADR-B · Instruction files are scaffolded, not generated.**

- _Context:_ `AGENTS.md` is the standard; Claude reads `CLAUDE.md` and supports `@path` imports; rulesync would inline-duplicate and destroy the import.
- _Decision:_ `dorkos`/`createAgentWorkspace` scaffolds `AGENTS.md` (canonical) + `.claude/CLAUDE.md` (`@../AGENTS.md`) + per-agent pointers. Any generator excludes `claudecode`/`agentsmd` instruction targets by default.
- _Consequences:_ + zero-duplication, Anthropic-recommended pattern, every DorkOS repo gets it. − one more scaffolding responsibility.

**ADR-C · Tasks unify into skills via `kind: task`; retire the dedicated tasks subsystem.**

- _Context:_ `TaskFrontmatterSchema extends SkillFrontmatterSchema` — a task _is_ a skill + schedule metadata. The dedicated `.dork/tasks/` watcher is a parallel subsystem; bundled-package tasks aren't discovered there.
- _Decision:_ Discover tasks via the skill scan (bounded to existing scan roots); schedule **iff `kind: task`** is explicitly set; retire the separate tasks watcher; keep one user drop location for standalone tasks.
- _Consequences:_ + one model, no symlink-into-tasks machinery, foolproof classification. − widens the "what fires here" surface → **requires ADR-D**; needs `dorkos tasks list` for auditability.

**ADR-D · Pulse scheduling is production-gated + singleton-locked.**

- _Context:_ Today there is no `NODE_ENV` gate, no leader election, no lock — dev/preview servers fire crons, and N servers sharing a `dorkHome` fire N times. The `/flow` Pulse seat makes this consequential (autonomous outward action from dev).
- _Decision:_ Default firing to production only (dev discovers/displays but doesn't fire unless `DORKOS_TASKS_ENABLED=true`); add a `dorkHome`-keyed leader lock; add dispatch idempotency on `(taskId, scheduledFireTime)`.
- _Consequences:_ + closes the Vercel-cron-style multi-fire risk. − one config gate + a lock file to manage.

**ADR-E · Amend/supersede ADR-0281** — flow ships as an assembled, self-contained package projected via the Harness Sync engine (not the dogfood-scattered layout). _Write once A4/B are scoped._

**ADR-F · Marketplace install records provenance; `dorkos contribute` upstream flow.** _Write with C3/C4._

## 9. Sequencing (phases + why)

- **Phase 0 — Capture & plan (now):** this doc; ADR drafts; create Linear projects + issues. _Cheapest insurance._
- **Phase 1 — Safety + wrap-up (parallel, independent):** D1 (urgent safety guard); A1–A3 (merge main, land flow PR, dry run, teardown). _Both unblocked today; don't let new scope hold them hostage._
- **Phase 2 — The big bet (spike → spec):** B1–B3 (ideation, spike, spec/design); C1 + C3 (package-build design, provenance). _Decide the projection model deliberately before building._
- **Phase 3 — Build on decisions:** B4–B6 + B9(Codex) → A4 (assemble flow as a plugin, dogfood the engine); D2–D3 (tasks unification, needs D1 + B); C1 impl; B8 (instruction scaffolding).
- **Phase 4 — Enhancements:** C4 (`dorkos contribute`, needs C3); B10 (Harnesses UI); B9 broaden (Cursor/Gemini/Copilot).

## 10. Open questions / spikes

- B2 outcome decides whether `harness.manifest.json` survives (schema'd) or is replaced by per-file `targets`, and whether `harness sync` is needed or replaced by `generate --check`.
- Vendoring strategy for rulesync maps: copy constants vs pinned submodule vs fork (lean: vendor the constants, MIT, with attribution + a re-vendor checklist).
- Whether Harness Sync should fold into / coordinate tightly with "Universal Command Interface" for the command-translation maps.
