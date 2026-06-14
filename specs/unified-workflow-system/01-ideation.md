---
slug: unified-workflow-system
number: 257
created: 2026-06-13
status: ideation
---

# Unified Workflow System — the `/flow` engine

**Slug:** unified-workflow-system
**Author:** Claude Code
**Date:** 2026-06-13
**Branch:** preflight/unified-workflow-system

> **One sentence:** Consolidate the three overlapping harness subsystems — ideation/spec/execution, Linear integration, and workspace management — into a single, PM-tool-agnostic **workflow engine** that runs the same stages two ways (manual slash commands _and_ fully-autonomous PM-driven runs), where the agent behaves like a real team member in the tracker.

---

## 1) Intent & Assumptions

### Task brief

Three harness areas have grown independently and now overlap:

1. **Ideation → feature creation** — `/ideate`, `/ideate-to-spec`, `/spec:create|decompose|execute|…`, `/review-recent-work`.
2. **Linear integration** — `/pm`, `/linear:idea`, `/linear:done`, the `linear-loop` skill.
3. **Workspace management** — `/worktree:*`, `working-in-worktrees`, the `Workflow` orchestration tool, the auto-checkpoint and autonomous-loop hooks.

Goals: **consolidate** into one identifiable system; **simplify** (thin commands, work in skills); support **two operating modes** (manual prompting/slash commands _and_ fully-autonomous operation driven entirely through a PM tool); make the system **PM-tool-agnostic** (Linear becomes one swappable adapter); add **config** (a JSON file at the system root); make stages **map cleanly to PM states**; decide **where decomposed tasks live**; **auto-test in the browser** with screenshots/recordings as proof-of-completion; lean on **skills** so behavior triggers without slash commands; and make the whole thing **identifiable as one package** (eventually a Claude Code / DorkOS plugin) with a **README/SPEC at the root**.

### Resolved scope decisions (from clarification — see §6)

- **Harness-first skill pack**, not server code (yet). Core logic written so it can port to a DorkOS server extension later.
- **One engine, two modes.** Execution mode (step vs autonomous) is **orthogonal** to trigger source (manual CLI vs PM-driven). Autonomous is the default when PM-driven; available manually too.
- **Unified `/flow` surface.** One descriptive namespace for the whole system: a `/flow` orchestrator + `/flow:<stage>` jumps; the work lives in auto-invocable gerund skills (hard rename of legacy commands, no aliases).
- **Involvement is uncertainty-gated.** Every stage can run autonomously and is tracked in the PM tool; the human is pulled in only on genuine questions / consequential calls — not by stage.
- **Comms channel inferred from trigger.** CLI → interactive; PM-driven → ticket comments (+ optional Relay/Telegram nudge); overridable.
- **v1 = operator-run draining loop**, sequential (WIP 1) but parallel-ready; **auto-merge after your approval** (CI green) then close + tear down. A server/DorkBot poller for fully-unattended start is v2.
- **Hybrid task decomposition**: `tasks.json` is the source of truth; mirror the active plan into the ticket; promote a task to a sub-issue only when big enough to dispatch independently.
- **Coarse PM states + stage labels.** Keep native tracker states; represent fine-grained stages with `stage/*` labels; match on state _category_, not name.
- **Config**: pack defaults at `.agents/flow/config.json` + optional per-repo `WORKFLOW.md` override.
- **Workspaces stay on the `gtr` worktree flow** (no WorkspaceManager service in v1).
- **The existing "Orchestration Extension" Linear project is Phase 2** — the server edition of _this same engine_, shipped as **one full-stack DorkOS extension** (orchestrator + console dashboard), not a separate effort. P1 (this harness) proves the design; P2 promotes it (§3, §5.9, §5.13).

### Assumptions

- The system targets a **solo operator dogfooding many agents** (Kai/you), not a hosted multi-tenant product — for now.
- **Linear is the first adapter**, but no generic stage skill may call a Linear API directly; all tracker I/O goes through an adapter interface.
- "Run until human review" means: do the work, open a PR with evidence, move to a review state, **assign back to the human**, then stop — and on your approval, **auto-merge + close + tear down the worktree**. Human involvement is **uncertainty-gated** throughout: the agent proceeds on obvious calls and pings you (via the active channel) only on genuine questions or consequential/irreversible decisions.
- We build on the **existing harness sync mechanism** (`.agents/` canonical → `.claude/` synced, declared in `.agents/harness.manifest.json`) rather than inventing a new one.
- This is **mostly unification + extraction + formalization**, not greenfield — the pieces largely exist.

### Out of scope (this ideation)

- Building the DorkOS **server-side** orchestration extension (WorkspaceManager service, server PMClient, webhook listener). Designed-for, not built here.
- **Linear Agent Accounts / webhooks** (blocked by the local-webhook problem) — deferred to a v2; v1 is poll-first.
- Shipping a **second PM adapter** (Jira/GitHub Issues). The _interface_ is defined now; a second implementation proves agnosticism later.
- Changing the **product** (`apps/*`); this is harness (`.claude/`, `.agents/`) work.

---

## 2) Pre-reading Log

Audited via two background `Explore` agents + one `research-expert` agent. Key reads:

- `.claude/commands/ideate.md` (596 LOC), `ideate-to-spec.md`, `spec/{create,decompose,execute,feedback,tasks-sync,…}.md` — the spec command family; mostly thick inline logic.
- `.claude/skills/executing-specs/SKILL.md` (+ 3 reference files) — the **one** command (`/spec:execute`, 39 LOC) that correctly delegates to a skill. The template for everything else.
- `.claude/skills/linear-loop/` — `SKILL.md` (421 LOC) + `config.json` + `conventions/labels.md` + `templates/` (6). The Linear methodology home and the **config-at-skill-root precedent**.
- `.claude/commands/pm.md` (194 LOC) — heavily Linear-coupled; does 7 distinct jobs.
- `.claude/skills/working-in-worktrees/SKILL.md` (132 LOC), `.claude/commands/worktree/*`, `.gtrconfig`, `.claude/scripts/worktree-setup.sh` — workspace isolation + port allocation.
- `.claude/hooks/autonomous-check.mjs` (137 LOC) — a **Ralph-Wiggum Stop-loop** that blocks stop while `roadmap/roadmap.json` has active work (phases ideating→…→releasing). The seed of an autonomous engine, parallel to and unaware of the Linear loop.
- `.claude/hooks/spec-status-sync.sh` (60 LOC) — PostToolUse hook that auto-advances `specs/manifest.json` status when `0N-*.md` artifacts are written. Precedent: **writing an artifact advances the state.**
- `.agents/skills/{running-product-loop,capturing-linear-ideas,closing-linear-loop}` — portable skill twins of the `/pm` and `/linear:*` commands.
- `research/20260611_workspace_strategy_runtimes_symphony.md` — OpenAI Symphony mapped onto DorkOS; the missing piece is a `WorkspaceManager` service. **Most relevant prior report.**
- `research/20260611_linear-agent-accounts.md`, `research/20260329_linear_api_agents_service_accounts.md` — Linear Agent Account model (OAuth `actor=app`, `AgentSession`, `plan`, `externalUrls`, `elicitation`, 5s/10s timing), assignment-vs-delegation, label-as-state-machine durability, the local-webhook problem.
- `research/20260328_linear_workflow_automation.md` — production Linear→agent patterns (Galarza, Huginn label-state-machine, Cyrus mode-switching).
- `research/20260328_looped_me_autonomous_improvement_engine.md` — Karpathy autoresearch loop; stop-criteria-as-spec; "never stop _within_ a session."
- `research/20260611_agent_browser_video_recording.md` + `research/20260225_browser_testing_system.md` — proof-of-completion: `gif_creator` (now), Playwright WebM (`retain-on-failure`, already wired in `apps/e2e`), ProofShot bundles.

---

## 3) Codebase Map

### Three subsystems today

| Subsystem                | Commands                                                                     | Skills                                                                                                                                                                                                                         | Artifacts / State                                                                      | Coupling                                                            |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| **Ideation/Spec/Exec**   | `/ideate`, `/ideate-to-spec`, `/spec:*` (9), `/review-recent-work`, `/adr:*` | `ideating-features`, `executing-specs`, `implementing-specifications`, `managing-specs`, `orchestrating-parallel-work`, `clarifying-requirements`, `verification-before-completion`, `writing-adrs`, `test-driven-development` | `specs/manifest.json`, `specs/<slug>/0{1..5}-*.md`, `03-tasks.json`, built-in Task API | **Optional** Linear breadcrumbs (graceful fallback, copy-pasted ×4) |
| **Linear**               | `/pm`, `/linear:idea`, `/linear:done`                                        | `linear-loop` (+config+templates), `running-product-loop`, `capturing-linear-ideas`, `closing-linear-loop`                                                                                                                     | `linear-loop/config.json`, Linear issues/projects/labels                               | **Hard** (no fallback). Reached via Linear MCP or Composio CLI      |
| **Workspace/Automation** | `/worktree:create                                                            | list                                                                                                                                                                                                                           | remove`                                                                                | `working-in-worktrees`, `orchestrating-parallel-work`               | `~/.dork/workspaces/core/<branch>/`, `.gtrconfig`, ports | Used by `/spec:execute` Phase 0 and `/pm` dispatch gate |

### State models that already exist (and don't talk to each other)

- **Spec status** (`specs/manifest.json`): `ideation → specified → implemented → superseded`. Auto-advanced by the `spec-status-sync` hook on artifact write.
- **Linear issue states**: `Triage → Backlog → Todo → In Progress → Done`. **Project states**: `Backlog → Planned → In Progress → Completed → Cancelled`.
- **Linear label state-machines**: `type/*` (idea, research, hypothesis, task, monitor, signal, meta), `agent/*` (**ready, claimed, completed, needs-input**), `origin/*`, `confidence/*`.
- **Autonomous-loop phases** (`autonomous-check.mjs` ↔ `roadmap/roadmap.json`): ideating, specifying, decomposing, implementing, testing, committing, releasing.
- **Linear loop** (`linear-loop`): Idea → Research → Hypothesis → Plan → Execute → Monitor → Signal.

> **The central finding:** there are **four** independent notions of "where work is" (spec status, Linear state, Linear labels, autonomous-loop phase) and **two** independent notions of "the loop." Unifying these into **one canonical stage model**, with everything else projected from it, is the heart of this effort.

### Existing related Linear work — reconciled (2026-06-14)

Pulling Linear (read-only) surfaced a whole **"Orchestration Extension (Symphony-style)"** project (DOR-88/89/90/95/102) plus two adjacent projects. **Reconciliation outcome: this ideation is the umbrella; the existing projects become the server/product phases of the same `/flow` engine** — re-anchored from "a Symphony port" to "the `/flow` engine, server edition." Nothing is superseded or deleted. The design source flips from Symphony's SPEC to _this_ one, which **collapses the to-be-researched scope** in the existing issues (they were going to decide things this ideation now decides).

**The `/flow` project family (Linear):**

| Project (target name)       | Was                                | Phase      | Role                                                                                                                                                                      |
| --------------------------- | ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flow Engine — Harness**   | _(new)_                            | **P1**     | This skill pack (spec #257). One umbrella hypothesis issue now; `/spec:decompose` fills tasks later.                                                                      |
| **Flow Engine — Extension** | Orchestration Extension (Symphony) | **P2**     | The **single full-stack DorkOS extension** — server orchestrator **and** console dashboard in one package (§5.9). Promotes the harness-proven design to a server service. |
| **Flow Console (v0)**       | Linear Loop Extension              | shipped    | The already-shipped console surface (all issues Done). Renamed for family consistency; de-Linear-ifying it is one new `type/idea`.                                        |
| **Workspaces**              | _(unchanged)_                      | dependency | The server execution substrate Phase 2 dispatches into — the `WorkspaceManager` our `gtr` flow graduates into (Decision #16). A dependency, **not** part of `/flow`.      |

**Per-issue disposition** (rewrite-in-place — preserve the "Agent Action" audit trail each issue accumulated):

| Issue       | Becomes                                                                                                                                                      | Relationship                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **DOR-88**  | Umbrella, re-anchored to the `/flow` SPEC; `depends on` P1 + DOR-84. Keeps the component-mapping table + runtime-agnostic angle.                             | downstream umbrella                       |
| **DOR-89**  | **Shrinks** to the server residue: Pulse/Tasks-vs-own-scheduler · SQLite runtime state · session-locking vs concurrency caps · stall/restart reconciliation. | its 6 deltas → absorbed into §5.4/§5.5    |
| **DOR-90**  | "Server consumes the shared `/flow` config contract" (same Zod schema + `WORKFLOW.md`) + Symphony hook-name interop.                                         | contract design → absorbed into §5.7/§5.9 |
| **DOR-95**  | The **unattended/server** variant of the `/flow` VERIFY stage (headless `recordVideo` → automated Linear attachment).                                        | interactive VERIFY → §5.8                 |
| **DOR-102** | Unchanged scope — the v2-identity decision; cross-links Decision #5 as the v1 baseline.                                                                      | already _is_ Decision #5's v2             |

A 6th issue — server `PMClient` Linear adapter — folds into DOR-88 (the interface is defined in P1; the server implements it). The Linear writes to enact this (renames, rewrites, dependency links) are the next execution step after this doc.

---

## 4) Research

### Transferable patterns (full report cited in §2)

- **OpenAI Symphony** — the model to imitate: a repo-owned `WORKFLOW.md` policy doc with hooks (`after_create`/`before_run` fatal; `after_run`/`before_remove` logged), workspace-per-unit-of-work keyed by a sanitized issue id, a poll loop with eligibility + concurrency caps, and a Linear adapter as one swappable layer. The only DorkOS gap is a `WorkspaceManager` service — a quality-of-life upgrade, **not** a v1 blocker (the `gtr` flow works today).
- **Linear Agent model** — _agent as team member_: OAuth `actor=app` identity, `AgentSession` lifecycle (`pending → active → awaitingInput → complete/error/stale`), `plan` field as native checklist, `**externalUrls`** as the native evidence attachment point, `**elicitation**` as the needs-input protocol, assignee = human notification channel. **Labels are more durable than the `plan` field** (survive thread archive) → use `agent/`\* labels as the state machine. The **local-webhook problem** (localhost unreachable; 10s AIG timing) ⇒ **poll-first v1\*\*, webhook v2 via a `dorkos.ai` relay.
- **Karpathy autoresearch** — separate _what to optimize_ (policy doc) from _the evaluator_ (immutable) from _the mutable work_; **stopping criteria are human-authored specs, not agent judgments**; "never stop _within_ a session, stop _between_ units at gates." Validates our "autonomous until review" posture and the circuit-breaker as the stop criterion.
- **Production Linear→agent loops** (Huginn/Galarza/Cyrus) — `planning → approved → executing` label gates; fresh context per unit; the well-specified issue (acceptance criteria) as the atomic unit; custom webhook agents beat native automations.
- **Task decomposition** — leading systems split between sub-issues (max visibility, max churn), native plan checklist (visible, ephemeral), and external artifacts (durable, invisible). **Hybrid wins.**
- **Proof-of-completion** — three tiers by fidelity/setup: `gif_creator` (instant, annotated, works now), Playwright library WebM (`retain-on-failure`, already wired), ProofShot bundle (video+screenshots+logs → PR comment). Attach to the ticket via `externalUrls` and/or the PR.
- **Packaging** — a single source of truth generating harness-native artifacts; auto-discovery from directory structure; `SKILL.md` is already the de-facto portable unit. The system should be a **skill pack / plugin**.
- **Crash & stall recovery** (`research/20260614_agent_crash_stall_recovery_session_association.md`) — across Symphony, Temporal, LangGraph, GitLab Duo, Sidekiq, OpenHands, Copilot: tracker + durable claim = source of truth (local state is a cache); the checkpoint is the git commit + the agent's session log (⇒ **resume, not restart**); and "parked on a human" must be a _distinct state_ the stall sweep never reclaims. v1 sequential needs no lease; v2 concurrency adds heartbeat + fencing token. Drives §5.12.

---

## 5) Proposed Architecture

### 5.1 The spine: one stage model, two trigger doors, two execution modes

```
                    ┌──────────────────── THE /flow ENGINE ───────────────────────┐
 manual trigger ─▶  │  CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE → │
 (/flow, /flow:…)   │          VERIFY → ⟦HUMAN REVIEW⟧ → DONE → (MONITOR → SIGNAL) │  ─▶ tracker
                    │  each stage = one generic "stage skill" (the actual work)    │     (via adapter)
 PM trigger     ─▶  │  involvement is uncertainty-gated, not stage-gated:          │
 (state/label/      │  proceed on obvious calls, ask the human only on real Qs     │
  assign/@mention)  └──────────────────────────────────────────────────────────────┘
                              ▲ adapter (PMClient): Linear today, swappable
```

- **Stage** = the canonical unit of "where work is." Everything else (spec status, PM state, labels, loop phase) is **projected** from the stage via the adapter.
- **Stage skill** = a generic, PM-agnostic skill that does the work of one stage. The thin `/flow:<stage>` command and the PM transition are just two **triggers** for the same skill — the "1:1 command↔state" intuition, realized at the _trigger_ level without bespoke tracker config.
- **Trigger source** (manual CLI vs PM-driven) and **execution mode** (step vs autonomous) are **orthogonal** — and _every_ stage can run autonomously; the human is pulled in by uncertainty, not by which stage it is:

|                        | **Step** (run one stage, stop)                         | **Autonomous** (run to a gate)                                                |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Manual** (CLI/slash) | `/flow:specify`, `/flow:execute` — one stage at a time | `/flow auto` — drain the ready queue from the terminal                        |
| **PM-driven**          | rare; explicit single-stage advance                    | **default** — assign/label an issue; the engine carries it to the review gate |

### 5.2 Stages ↔ existing pieces (what each stage _is_)

| Stage                   | Generic stage skill (new home for logic)    | Absorbs today's…                                                                                                          | PM projection (Linear)            |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **CAPTURE**             | `capturing-work`                            | `/linear:idea`, `capturing-linear-ideas`                                                                                  | `type/idea`, Triage               |
| **TRIAGE**              | `triaging-work`                             | `/pm` triage/intake, complexity routing                                                                                   | type label set, Backlog/Todo      |
| **IDEATE**              | `ideating-features` (exists)                | `/ideate`                                                                                                                 | `stage/ideate`                    |
| **SPECIFY**             | `specifying-work`                           | `/ideate-to-spec`, `/spec:create`                                                                                         | `stage/specify`                   |
| **DECOMPOSE**           | `decomposing-work`                          | `/spec:decompose`, `/spec:tasks-sync`                                                                                     | `stage/decompose`, plan checklist |
| **EXECUTE**             | `executing-specs` (exists)                  | `/spec:execute`, worktree setup/teardown                                                                                  | In Progress, `agent/claimed`      |
| **VERIFY**              | `verifying-work`                            | `/review-recent-work`, `browser-testing`, `requesting-code-review`, `verification-before-completion`, proof-of-completion | evidence on issue/PR              |
| **REVIEW** (human gate) | — (engine parks here)                       | `/linear:done` precondition                                                                                               | **In Review + assigned to human** |
| **DONE**                | `closing-work`                              | `/linear:done`, `closing-linear-loop`                                                                                     | Done, `agent/completed`           |
| **MONITOR/SIGNAL**      | `monitoring-work` (optional post-DONE loop) | `linear-loop` tail; SIGNAL = an emitted observation that **re-enters at CAPTURE** (closes the loop)                       | `type/monitor`, `type/signal`     |

Thin `/flow:<stage>` slash commands just invoke the stage skill (no logic inline). **Target: every command ≤ ~40 LOC**, mirroring `/spec:execute` today. CAPTURE / TRIAGE / IDEATE are the question-heavy stages where the agent most often pauses for you (§5.5); the rest typically run clean to the review gate.

**MONITOR/SIGNAL are PM-agnostic, not Linear-coupled — and out of v1 scope.** Mechanically they need nothing Linear-specific: MONITOR is a time/event-triggered follow-up (`comment` + `attachEvidence`), and SIGNAL is a `createWorkItem` + `link` that re-enters the spine at CAPTURE — both already in the adapter verbs (§5.3); the `type/monitor`/`type/signal` labels are just the Linear projection, like every other row. What makes them a **loop tail** rather than core spine is the **temporal/event trigger** (they fire on an outcome window, not on dispatch readiness), so they sit outside the CAPTURE→DONE delivery spine — shown as the optional `(MONITOR → SIGNAL)` tail in §5.1. **v1 does not automate them**: the existing `linear-loop` tail continues to serve this need; generic automated monitoring (a temporal trigger feeding `monitoring-work`) is documented future scope. This is a scope boundary, not an agnosticism exception.

### 5.3 The work model + adapter (PMClient)

The adapter normalizes every tracker into one `**WorkItem`\*\* shape, so generic stages and the dispatch policy never touch a tracker-specific field directly:

```
WorkItem {
  id, identifier, title, description
  type             // idea | research | hypothesis | task | monitor | signal | meta  (from type/* or tracker issue type)
  stateCategory    // backlog | unstarted | started | completed | canceled   (matched on CATEGORY, never name)
  stateName        // raw, for display only
  priority         // 0–4  (none | low | medium | high | urgent)
  size             // points / t-shirt  (drives sub-issue promotion + ranking)
  project          // { id, name, stateCategory, lead }                        ← projects & project status (lead = project-level owner)
  parent           // parent WorkItem id (sub-issue)
  relations        // { blocks[], blockedBy[], children[], relatedTo[], duplicateOf? }   ← issue relationships
  labels[]         // includes stage/* and agent/*
  assignee         // → classifyOwnership(): mine | reviewer | other | unassigned (vs identity.agent / identity.reviewer)
  agentDisposition // ready | claimed | completed | needs-input
}
```

A small capability interface; Linear implements it, future trackers implement it. Generic stages and the dispatch policy only know these verbs:

```
interface PMClient {
  // identity / discovery / triggers
  getCurrentUser(): User                      // the agent's authenticated account; resolves identity.agent: "auto"
  getProjects(filter): Project[]              // projects + their stateCategory + lead
  getEligibleWork(filter): WorkItem[]         // filter by project, type, state, label, priority…
  getInbox(agent): InboxItem[]                // assigned-to-me + @mentions + new comments since last tick;
                                              //   each carries { item, comment: { author, mentions[], body } } ← comment-response rules (§5.5)
  getRelations(item): Relations              // blocks / blockedBy / children / related
  // mutation
  claim(item): void                          // durable: write claim label + move state (survives restart)
  transition(item, stageOrCategory): void
  comment(item, body, evidence[]): void
  assignToHuman(item, human): void           // handoff
  attachEvidence(item, urls[]): void         // Linear externalUrls / PR comment
  needsInput(item, question): void           // elicitation: label + comment + assign-to-human + stop
  // relationships
  link(item, relation, other): void          // blocks | blockedBy | related | duplicate
  createSubIssue(parent, fields): WorkItem   // decomposition → promoted task
}
```

> **`PMClient` is a Phase-2 (server) artifact — it does not exist yet** (no code references it; confirmed by grep). In the **v1 harness**, "the adapter" is a **single `adapters/linear/` skill** that owns every `mcp__linear__*` / Composio call (**Linear MCP primary, Composio `--account personal` fallback** — exactly how `linear-loop` reaches Linear today) and fulfils the verbs above as a **documented prose contract**; generic stage skills call that skill instead of touching tracker strings. The typed TypeScript `interface` above is what the **server build** promotes it into. So the agnosticism win — "all Linear lives in one place" — is real in v1 with **no new infrastructure**.

- **Identity (v1):** ideally a **dedicated tracker account** for the agent (e.g. a `flow`/DorkBot Linear user), distinct from the human reviewer — the agent comments, assigns, and transitions **as itself**, attributable in the tool. Inbox via **polling**. Identity, ownership, and comment-handling are modelled below.
- **Identity (v2):** full Linear **Agent Account** (OAuth `actor=app`, webhooks, `AgentSession`, native `plan`/`elicitation` UI) once the local-webhook problem is solved via a `dorkos.ai` relay. Additive; nothing in v1 is torn out.
- **State machine = labels**, not the ephemeral `plan` field (durability lesson from Huginn).
- **PM-agnostic caveat:** not every tracker exposes `project.stateCategory`, `priority`, or `size` natively (e.g. GitHub Issues). The adapter supplies what exists; the dispatch policy (§5.4) treats missing fields as neutral and degrades gracefully — it never hard-requires a Linear-only concept.

**Identity & ownership — who the agent is, what it may touch.** The governing principle: **ownership and authorship live in labels + a comment marker (durable, always present); a dedicated agent account is a cleaner enhancement signal on top when it exists.** This lets one mechanism serve two worlds:

- **Two-account (ideal, default):** the agent has its own tracker account (`identity.agent`), the human has theirs (`identity.reviewer`). Assignee/lead is unambiguous; authorship is unambiguous (different authors).
- **Shared-account (fallback):** the agent acts _as_ the human's account. Assignee can't tell "agent claimed it" from "human wants it," and authorship collapses — so it falls back to claiming via the `agent/claimed` **label** only, recognizing its own comments by **marker**, and handing off review by **label + nudge** (no separate account to assign to).

**The mode is _detected_, not configured:** `identity.reviewer` unset or equal to `identity.agent` ⇒ shared mode; otherwise two-account. You set a reviewer (or don't) and the engine adapts.

**One classification primitive, two consumers:** `classifyOwnership(item) → mine | reviewer | other | unassigned` compares `issue.assignee` (and `project.lead`, for project-granularity) against `identity.agent` / `identity.reviewer`. Both **dispatch eligibility** (§5.4) and **comment-handling** (§5.5) consume it — the "one policy, two consumers" pattern (`dispatch-priority.md`). The `ownership` config block (§5.7) declares which classes the agent may claim — assigned-to-agent and/or unassigned, never the reviewer's or others' — applied to **issues and projects** alike. In shared mode it never auto-claims items merely "assigned to the shared account" (could be the human's own work) — only `unassigned` or explicitly `agent/claimed`.

### 5.4 Dispatch policy (choosing what to work on)

When more than one item is eligible, the engine ranks candidates with a config-driven policy (the `dispatch` block in §5.7). Two passes:

**Eligibility — filter out** an item if: its `stateCategory` isn't dispatchable · it lacks `agent/ready` (in PM-driven mode) · it is `blockedBy` any open item · its `project.stateCategory` is `completed`/`canceled` · the per-project or global **WIP cap** is reached · its `classifyOwnership` class isn't in the `ownership` claim policy (§5.3/§5.7) — i.e. it's assigned to the reviewer or a teammate, or (shared mode) merely on the shared account without `agent/claimed`.

**Ranking — order the survivors** (each tier is a configurable weight; later tiers break ties):

```
1. unblockers      — items that `blocks` others rank first (clear the chain)
2. priority        — urgent → high → medium → low → none
3. project status  — issues in `In Progress` projects before `Planned`
4. type            — optional per-type weighting (e.g. signal/bug before idea)
5. size            — small-first (flush quickly) or large-first — config knob
6. age             — oldest `created` first
7. identifier      — deterministic final tiebreak (Symphony-style)
```

Every axis you'd sort by in Linear — **type, status, project status, priority, size, blocking relations** — is a tier here, and the weights live in config so re-prioritizing never touches code. Relations (§5.3) feed tier 1 and the blocked-by eligibility filter directly. This is where the dispatch ladder worked out in `research/20260611_work-sequencing-linear-method.md` lives (condensed here to 7 tiers).

### 5.5 Human involvement — uncertainty gates, review & the comms channel

**Involvement is uncertainty-gated, not stage-gated.** Every stage can run autonomously; at each decision point the agent proceeds when the answer is obvious / low-risk / reversible, and pulls you in only when it's ambiguous / consequential / irreversible. CAPTURE/TRIAGE/IDEATE simply raise more such questions (IDEATE most), so the agent pauses there more often — but a trivially-obvious item can flow straight through untouched. **All stages are tracked in the PM tool regardless.** This makes the agent's _question-asking judgment_ the single most important behavior in the system — too eager is noise, too confident ships wrong calls. The **calibration ladder** below makes that judgment concrete.

**The calibration ladder — how the agent decides to proceed vs ask.** At every decision point the agent walks this top-down and acts on the first row that matches (same "ordered rules, first match wins" shape as the dispatch ladder, §5.4):

| #   | Condition                                                                                                          | Behavior                                                    | Blocks loop?    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------- |
| 0   | **Floor** — irreversible/destructive · outward-facing/published · secrets/spend/production · material scope change | **Stop & ask** (`needsInput()`) — _even at full confidence_ | yes             |
| 1   | **Reversible + confident**                                                                                         | Proceed silently                                            | no              |
| 2   | **Sticky + not-confident**                                                                                         | Stop & ask                                                  | yes             |
| 3   | **Reversible + not-confident** (the ambiguous middle)                                                              | **Routed by stage bias** (below)                            | stage-dependent |
| 4   | **Sticky + confident**                                                                                             | Proceed, but **announce** (prominent note / ticket comment) | no              |

Two **evidence-based** definitions carry the weight (deliberately not mood-based):

- **Confident** = the answer is determined by **the frozen spec, an ADR/decision, a strong codebase convention, or a prior human answer** — not a hunch. If resolving it requires guessing intent or choosing between materially-different approaches with no steer, it is **not** confident.
- **Reversible** = cheap to undo inside the loop (a code edit, a worktree file, a draft comment). **Sticky** = costly or visible to undo.

**Stage bias routes row 3 — the frozen spec is the cut line.** Row 3 is the only cell whose behavior depends on the stage, and the boundary is principled: before the spec is frozen the human's input _is_ the deliverable; after it, the agent executes a contract.

- **Intent-gathering stages** (CAPTURE / TRIAGE / IDEATE / **SPECIFY**) → row 3 = **ask**.
- **Execution stages** (DECOMPOSE / EXECUTE / VERIFY) → row 3 = **proceed on the best default + log the assumption** (DECOMPOSE is proceed-biased because the plan-approval gate already gives you a look; the assumption surfaces at the review gate).

This yields "IDEATE asks freely, EXECUTE asks rarely" as an _emergent_ property of one rule, not a hand-tuned per-stage table. Net effect: only **three** behaviors exist — proceed-silently, proceed-with-a-trail, stop-and-ask — and the only things that block the autonomous loop are the floor (row 0), sticky uncertainty (row 2), and uncertainty in the intent-gathering stages (row 3-ask).

**Every non-obvious call leaves a trail (honest by design).** Rows 3-proceed and 4 write an **assumption note** — into the stage artifact, and as an `agent/assumption` ticket comment in PM-driven mode — so every guess the agent made is auditable at the human-review gate. Nothing is hidden behind false simplicity.

**Answers become memory, with no new machinery.** When you answer a question, the resolution is written where row 1's evidence-test will find it next time — the spec's decisions table, an ADR, or `config.json` — so the _same_ question is never asked twice. "Learning from past answers" is just the externalize-state principle (Decision #17) applied to involvement: no model, no separate store.

**How the agent reaches you — the comms channel (your "where are we communicating" requirement):** the channel is **inferred from the trigger**, overridable by config —

- triggered from the **CLI** with a live session → ask **interactively** (the usual prompt / `AskUserQuestion`);
- **PM-driven** or you're away → post the question as a **ticket comment**, apply `agent/needs-input`, **assign the issue to you**, and resume when you reply there (`getInbox` picks up your comment);
- optional **Relay/Telegram nudge** so you know a question is waiting ("get a Telegram message when your agent needs you").

**Reading the channel back — when does a comment deserve a response?** The agent polls `getInbox()` and decides per new comment: respond / act / ignore. **Hard rules first (deterministic), then a conservative soft zone:**

1. **Never answer its own comments** — author is the agent _or_ the comment carries the `identity.marker`. (In shared-account mode the marker is the _only_ signal.) This breaks self-reply loops.
2. **Always respond when directly addressed** — an @mention of the agent's account, or (shared mode) an explicit `/flow` / `@flow` token in the text. Explicit address **overrides ownership** — even on a teammate's issue.
3. **Resume when an open question is answered** — the item has `agent/needs-input` and a non-agent comment arrives → that's the answer the agent parked for; continue.
4. **Stay out of others' threads** — the item is `other`-owned (`classifyOwnership`, §5.3) and the agent isn't mentioned → ignore.
5. **Soft zone — lean quiet.** A comment on an _agent-owned_ item that isn't an explicit mention → respond only when the calibration ladder above says it's confidently a directive _to the agent_ and actionable; otherwise stay silent. Over-responding is the worse failure (noise, looks broken), so silence is the safe default.

**The hard gates (where autonomous mode stops by policy):**

1. **Question / soft-escalation** (any stage, dynamic) — driven by the calibration ladder above: `needsInput()` on the floor (row 0), sticky uncertainty (row 2), or uncertainty in an intent-gathering stage (row 3-ask).
2. **Plan-approval gate** (after DECOMPOSE, before EXECUTE) — _configurable_; auto-pass when `gates.planApproval=false`. A label you clear (Huginn `planning → approved`).
3. **Human-review gate** (after VERIFY) — **always on**. Open a PR with evidence → move to In Review → **assign to you** → stop. On your **approval** (and CI green), the agent **auto-merges, closes the issue, and tears down the worktree**. This is the "run until human review" boundary, with a hands-off tail.
4. **Circuit breaker** — stop + escalate if a unit exceeds `estimate × N` wall-clock or a token budget (Karpathy-style human-authored stop criterion).

**When the merge can't complete cleanly (the recovery ladder).** Your approval authorizes merging **one specific state**: this diff, green, cleanly mergeable. If that exact state can't be reproduced automatically at merge time, the agent does **not** merge — it checks three preconditions and handles each failure, then either proceeds or returns the item to the loop with a clear reason. Conflict resolution is itself a decision point, so it routes through the **calibration ladder** (§5.5) rather than a separate rule:

| Precondition                                  | Pass                                                                                                                                | Fail → disposition                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Mergeable?** (no conflict with base)     | clean replay onto new main → continue, **announce** the rebase                                                                      | conflict → **route through the calibration ladder**: mechanical / no-functional-risk (both add an import, append to a changelog/list, lockfile) → agent **resolves + announces**; a real decision/tradeoff (overlapping edits to the same logic) → **bounce** (`agent/needs-rebase`, In Progress, comment the conflict, re-assign to you) |
| **2. CI green?** (on the to-be-merged commit) | green → continue                                                                                                                    | red → **retry once** (flake guard); still red → re-enter EXECUTE→VERIFY to fix (reversible exec work), regenerate evidence                                                                                                                                                                                                                |
| **3. Functionally unchanged since approval?** | mechanical-only changes (clean rebase, mechanical conflict resolution, lint) → **merge + close + teardown** (announce what changed) | a change that alters approved **behavior** (a CI-fix that touches logic, a conflict resolution that changes a result) → **re-request approval** (re-assign, fresh evidence) before merging                                                                                                                                                |

The line in all three rows is the same calibration test — _is there a real decision the human would want to weigh in on?_ Mechanical → proceed + leave a trail; functional → bounce. **Circuit-breaker tie-in:** if an item bounces fix→review→red more than `gates.review.maxMergeAttempts`, stop and escalate (`agent/blocked` + nudge) rather than loop forever (reuses gate 4).

All gates are config-driven, extending the existing `linear-loop/config.json` `approvalGates` precedent.

### 5.6 Task decomposition, artifacts & provenance

> **Sub-issues are the rare exception, not the rule.** The default home for a task is a **checklist line in `03-tasks.json`** (mirrored into the ticket for at-a-glance progress). A task is promoted to its own tracker sub-issue **only** when it's large enough to dispatch independently (`size ≥ decomposition.subIssueThreshold`, default "large"/≥3). **The vast majority of tasks never become sub-issues** — promoting them would spam the tracker and fragment the spec. The expected shape is **one umbrella issue + a handful (often zero) of promoted sub-issues**, never one-issue-per-task.

- **`specs/<slug>/03-tasks.json` = single source of truth** for decomposition (existing schema: `id`, `dependencies`, `parallelWith`, `size`, …). Durable across session/thread archives.
- **Schema gap to close:** add an optional per-task **`issue`** (and **`parentIssue`**) field — currently absent — so a _promoted_ sub-issue has a canonical home in the artifact. This is the only place the task→issue mapping lives.
- **Mirror** the active phase into the ticket as a checklist (Linear `plan` field in v2, or a markdown checklist comment/section in v1) for at-a-glance progress. The mirror is **generated from `03-tasks.json`, never hand-edited.**
- **Collapse the dual task system** (audit Finding 7): `03-tasks.json` is canonical; the built-in Task API becomes a _projection_ for live display, not a second source. Removes a whole class of sync bugs.

**Link cardinality — 1:1 at the anchor, 1:many through structure (never a flat list):**

```
spec ──(1:1)──▶ ONE tracker "home"          ← anchor: issue (small spec) OR project (large spec)
  └─ 03-tasks.json
       ├─ task ─(1:1)─▶ sub-issue            ← 1:many lives HERE, normalized; MOST tasks have none
       └─ task  (checklist only)
  └─ relations ─(typed, rare)─▶ related / supersedes   ← via adapter link(), not frontmatter
```

- **Anchor stays 1:1.** Each spec has exactly one authoritative tracker home — its identity and the single target for status-sync. Generalize today's scalar `linear-issue:` frontmatter into a **PM-agnostic provenance block** that names one **issue _or_ project** (small spec → umbrella issue; large spec → project). A flat `issues: [...]` list is **rejected** — it would duplicate the task→issue mapping `03-tasks.json` owns and re-create the drift we're killing, and it's ambiguous about which issue carries the spec's state.
- **Multiplicity is normalized** into `03-tasks.json` (per-task `issue`) + typed `relations` (§5.3) — not a multi-value frontmatter field.

**Filesystem is canonical; the tracker holds pointers + state + conversation — never a second copy of prose.** Research (`research/`), specs (`specs/<slug>/`), and ADRs (`decisions/`) live **once** on disk. The tracker stores a **link + the work's state** (stage, labels, assignee), and **state is derived from artifact events** (the `spec-status-sync` hook precedent), so the two can't disagree on content — there is only one copy. **Back-links are bidirectional but ID-only:** the canonical doc carries a one-line provenance block (`tracker` / `issue` / `project`) pointing back at its tracker home — extended to ADRs and research, not just specs. An ID is stable and low-churn, so a two-way link never reintroduces drift; only duplicated prose does.

### 5.7 Configuration (`config.json` at the system root)

```jsonc
{
  "$schema": "./config.schema.json",
  "tracker": "linear", // adapter selection — the only PM-specific knob
  "identity": {
    "agent": "auto", // the agent's tracker account; "auto" = the adapter's authenticated user (getCurrentUser)
    "reviewer": null, // the human to hand reviews/questions to; a handle/id, or null ⇒ shared-account mode (detected)
    "marker": "— 🤖 /flow", // signature on every agent comment; how it recognizes its own authorship (load-bearing when shared)
  },
  "ownership": {
    // which work the agent may claim, by classifyOwnership class (§5.3); applies to issues AND projects
    "claimAssignedToAgent": true, // pick up items assigned to me
    "claimUnassigned": true, // pick up unassigned items (two-account: self-assign on claim; shared: via agent/claimed only)
    "claimAssignedToHuman": false, // never take the reviewer's items
    "claimAssignedToOthers": false, // never take teammates' items
    "scope": ["issues", "projects"],
  },
  "comments": {
    "respondWhen": "addressed", // hard-yes: @mention of agent · answer to my needs-input · explicit /flow token
    "ambiguousBias": "quiet", // soft zone leans silent; own comments (marker) are always ignored
  },
  "stages": {
    // stage → { command, label, optional stateCategory }
    "capture": { "command": "/flow:capture", "label": "stage/capture" },
    "triage": { "command": "/flow:triage", "label": "stage/triage" },
    "ideate": { "command": "/flow:ideate", "label": "stage/ideate" },
    "specify": { "command": "/flow:specify", "label": "stage/specify" },
    "decompose": { "command": "/flow:decompose", "label": "stage/decompose" },
    "execute": { "command": "/flow:execute", "label": "stage/execute", "stateCategory": "started" },
    "verify": { "command": "/flow:verify", "label": "stage/verify", "stateCategory": "started" },
    "review": { "stateCategory": "started", "humanGate": true },
    "done": { "command": "/flow:done", "label": "stage/done", "stateCategory": "completed" },
    // MONITOR/SIGNAL are the optional post-DONE loop tail (§5.2) — PM-agnostic but temporally triggered, not automated in v1
  },
  "autonomy": {
    "default": "auto", // when PM-driven; CLI can opt in too
    "concurrency": "sequential", // v1; flip to "parallel" later
    "wipCap": { "global": 2, "perProject": 1 },
  },
  "involvement": {
    "comms": "infer-from-trigger", // cli → interactive; pm-driven → ticket comments
    "calibration": {
      // the ladder of §5.5; proceed silently only when BOTH hold
      "proceedSilentlyWhen": ["reversible", "confident"],
      // hard floor — ALWAYS stop & ask, even at full confidence
      "alwaysAsk": [
        "irreversible-or-destructive",
        "outward-facing",
        "secrets-or-spend",
        "scope-change",
      ],
      // routes the ambiguous middle (reversible + not-confident); default cut at the frozen spec
      "stageBias": { "intake": "ask", "execution": "proceed-and-log" },
      // non-obvious calls leave an auditable trail for the review gate
      "assumptionLog": { "artifact": true, "ticketComment": "pm-driven" },
    },
    "nudge": { "relay": false, "telegram": false },
  },
  "dispatch": {
    "rank": ["unblockers", "priority", "projectStatus", "type", "size", "age"],
    "sizeOrder": "small-first",
    // claim/ownership policy moved to the top-level "ownership" block (§5.3 classifyOwnership)
  },
  "gates": {
    "planApproval": true,
    "review": {
      "mergeOnApproval": true,
      "requireCiGreen": true,
      "teardownWorktree": true,
      "onConflict": "resolve-if-mechanical", // calibration ladder: mechanical → resolve+announce; real tradeoff → reassign
      "ciRetries": 1, // flake guard before treating red as real
      "reapproveOnFunctionalChange": true, // mechanical-only changes (rebase/conflict/lint) proceed+announce; behavior changes re-request approval
      "maxMergeAttempts": 3, // circuit-breaker: stop bouncing fix→review→red, escalate
    },
    "circuitBreaker": { "estimateMultiplier": 2, "tokenBudget": 2000000 },
  },
  "context": {
    "perIssue": "fresh-session", // loop re-invokes per issue; orchestrator state lives on disk
    "perStage": "fresh-subagent", // each stage runs in an isolated context, returns a summary
    "compactionTrigger": 0.65, // effective window, not the hard limit
    "stageBudgets": {
      "specify": 40000,
      "decompose": 40000,
      "execute": 80000,
      "verify": 40000,
      "review": 30000,
    },
    "externalize": ["flow-state.json", "execution.log.jsonl", "flow-history.tsv"],
  },
  "workspace": { "isolation": "worktree", "flow": "gtr", "autoTeardown": true },
  "recovery": {
    "maxRetries": 2, // adopt+resume → restart-clean → escalate to agent/blocked
    "onExhausted": "block", // agent/blocked + comment + nudge; never silently drop
    "staleAfter": "5m", // v2 (concurrent) only: heartbeat-expiry window; v1 sequential needs no lease
  },
  "decomposition": { "mode": "hybrid", "subIssueThreshold": "large" },
  "evidence": {
    "ui": "auto", // interactive → gif_creator (needs your live Chrome); unattended loop → Playwright WebM (headless)
    "temporal": "video",
    "logic": "test-summary",
    "attachTo": ["pr", "tracker"],
  },
}
```

Validated with a Zod schema → `config.schema.json` (mirrors the project's `conf` + `z.toJSONSchema` pattern; see `reference_conf_and_config`).

### 5.8 Browser proof-of-completion (the VERIFY stage)

- Run Playwright (`apps/e2e`) for the touched surface; capture per `evidence` config: UI → annotated GIF (`gif_creator`, works now) or WebM (`retain-on-failure`, already wired); temporal → video; logic → test-pass summary.
- Attach via the adapter: PR comment (ProofShot-style bundle) and/or tracker `externalUrls`.
- Encodes the existing "Evidence on Close" convention; aligns with the planned evidence-class schema (DOR-90).

### 5.9 Packaging, templates & identity (the README/SPEC + "one system")

`.agents/flow/` is the **logical/canonical root** that makes the system one identifiable unit. But a ground-truth correction to the original plan: **the existing `.agents/harness.manifest.json` is custom to this repo and today syncs _skills only_** (symlink `.agents/skills/X → .claude/skills/X`). Per the sync spec, **commands stay Claude-native in `.claude/commands/`** ("no repo-local command format" for Cursor/Codex) and **hooks stay in `.claude/settings.json`** (`hookPolicies: projection none`). So a fully-self-contained, fully-synced `.agents/flow/` is the _plugin end-state_, not v1. The honest v1 layout:

```
.agents/flow/                  # logical root — the "this is the system" registry
  README.md         ← the manual: stages, modes, command↔state map, gates, adapter interface
  SPEC.md           ← the contract: stage model, PMClient interface (Phase 2), config schema
  config.json + config.schema.json   ← pack-default policy (§5.7)
  manifest.json     ← declares every member + where it projects
  skills/           ← stage skills (generic, gerund) + adapters/linear/   →  SYNCED to .claude/skills/ (symlink)
  templates/        ← the system's templates (below)                      →  loaded by skills (no sync needed)
.claude/commands/flow/          ← thin /flow + /flow:<stage> triggers     (Claude-native; NOT under .agents/)
.claude/settings.json           ← the unified loop hook                   (Claude-native)
<consuming repo>/WORKFLOW.md     ← optional per-repo override (Symphony-style): gates, dispatch, tracker
```

**Templates the system owns** (formalizing emergent conventions; generalized + PM-agnostic, the adapter fills tracker specifics — following the `dispatch-priority.md` "one policy, two consumers" precedent shared by `/pm` _and_ the extension):

- **`templates/records/`** — PM records **by type** (issue: idea/research/hypothesis/task…; project) with the canonical `## Validation criteria` / `## On Completion` sections. _Generalizes_ `linear-loop/templates/` (triage-_, plan-_, dispatch-priority, audit) and de-Linear-ifies them. _New: explicit per-type record bodies (don't exist today)._
- **`templates/docs/`** — ideation / specification / `03-tasks.json` / ADR scaffolds. _These exist today but are inline in the `/ideate` command_; externalize them so commands stay thin.
- **`templates/pr.md`** — the PR template the REVIEW stage fills (linked issue · validation/test summary · browser-proof links). _None exists today._

**Packaging target — decided: dogfood `/flow` as a DorkOS marketplace package from P1 (Q3 option A).** Build `.agents/flow/` _as_ a DorkOS marketplace **`plugin`-type package** from the start — which (via `requiresClaudePlugin()`) **embeds a `.claude-plugin/plugin.json`** + a DorkOS sidecar manifest, so it's simultaneously a Claude Code plugin and a marketplace entry. The **v1 package contributes only `commands`/`skills`/`hooks`/`templates` — no `extensions` layer** (that server layer is P5, the Extension project). Keep `.agents/` as the **cross-harness glue** (skills + `AGENTS.md`) that plugins don't cover. The three standards _layer_ rather than compete; extracting the product extension later is then **additive, not a rewrite**, and the shared `/flow` prefix keeps the system identifiable in the command list. _Rationale: DorkOS **is** a marketplace, so dogfooding our own package format is on-mission, and "one identifiable installable unit" is true on day one._

**No personal identity ships in the package.** The runtime identity & ownership model is §5.3; the package defaults (`identity.agent: "auto"`, `identity.reviewer: null`) resolve at runtime from the installer's own authenticated tracker account — nothing about the operator is baked into the distributable.

### 5.10 What gets simplified / removed

- **Unified command surface**: legacy `/ideate`, `/ideate-to-spec`, `/pm`, `/spec:*`, `/linear:*`, `/review-recent-work` → one `/flow` orchestrator + `/flow:<stage>` jumps (hard rename, no aliases).
- 9 thick spec commands (250–590 LOC each) → thin triggers + stage skills.
- `/pm`'s 7 jobs → split into `triaging-work` (stage skill) + the loop engine + an `audit` skill.
- Breadcrumb logic copy-pasted ×4 → one adapter call.
- **Two loops → one engine** (generalize `autonomous-check.mjs` from `roadmap.json` to the canonical stage state).
- Duplicate skills (`.claude/` vs `.agents/`) → single canonical + sync (fixes audit Finding 1).
- Dual task system → `03-tasks.json` canonical (fixes Finding 7).
- All Linear strings out of generic stages → into `adapters/linear/`.

### 5.11 Context strategy (keeping autonomous runs sharp)

For a loop that drains many issues over hours, **the best context management is architectural — not a compaction feature.** Every mature autonomous system converges here (Karpathy `results.tsv`+git, Galarza "fresh context per issue + `PROGRESS.md`", Slack's zero-history structured memory, Anthropic's own harness). The evidence against letting one session grow is strong: frontier models suffer **context rot** well before the window fills (~30% accuracy loss from lost-in-the-middle; a 200K model degrades by ~50K tokens; ~65% of agent failures trace to context drift), and goal fidelity erodes across repeated lossy compactions. Anthropic found pre-4.6 models needed full **context resets** between phases ("context anxiety" — rushing to wrap up near the limit); Opus 4.6+ can rely on compaction alone, but only for a _single_ multi-hour project — **not** a multi-issue orchestrator like this one.

So `/flow` externalizes state and starts fresh, in four tiers:

- **Tier 0 — the orchestrator is code, not an LLM session.** The poll → pick → dispatch → collect → advance loop is deterministic state-machine logic. v1: a thin script/hook reading state from disk each tick (no accumulating Claude context). v2: real TypeScript in the server. The orchestrator has ~no context window.
- **Tier 1 — fresh context per unit of work.** A fresh session per issue (the loop re-invokes) and a fresh subagent per stage. Each gets a **compact brief** (issue title/AC + ~200-token summaries of prior stages + the one input artifact + pointers), typically 5–25K tokens — **never** prior raw tool outputs or other issues' state. Subagents return a 200–400-token summary, then are discarded (the canonical Claude Code isolation pattern).
- **Tier 2 — externalized durable memory.** `flow-state.json` (the handoff artifact: current stage + artifact pointers + per-stage summaries), per-stage artifact dirs, `04-implementation.md`, an `execution.log.jsonl`, and a cross-issue `flow-history.tsv` (Karpathy's `results.tsv` analog) — plus the PM tool (comments, labels, plan, evidence). Filesystem + tracker are ground truth; the model is amnesiac by design.
- **Tier 3 — per-stage token budget + circuit breaker.** Each stage has a ceiling (`context.stageBudgets`); at ~65% of the _effective_ window bias to brevity, and on breach write a partial artifact, mark `needs-input`, and escalate (`gates.circuitBreaker`).

**Auto-compaction is the seatbelt, not the driver.** Claude Code's auto-compact is on-by-default and **un-tunable** (no `settings.json` knob) — so the architecture must carry the load; we can't lean on a threshold we can't set. Leave it on as a within-stage safety net and add a **"Compact Instructions" block to `AGENTS.md`** so that _if_ it fires it preserves the current item, stage, gate state, and artifact pointers. The v2 server build swaps in the Agent SDK's explicit `context_management` compaction (per-unit token trigger) — a clean upgrade, same shape as the webhook/poller story.

**"Is it OK to not manage context ourselves?"** Manual CLI sessions: yes, lean on auto-compact. The autonomous loop: you don't _build_ a compaction system — you get context discipline for free from the stateless, fresh-per-unit architecture already chosen (durable `04-implementation.md`, no in-memory state, subagent-per-batch). The only explicit knob is the per-stage token budget.

### 5.12 Crash & stall recovery (sessions, claims, resume)

Sessions are ephemeral; the **work** is durable. When a scheduled tick claims an issue and the session later crashes or quits mid-flight (circuit breaker / token budget), the **next tick must adopt the orphaned work and resume it** — never restart from scratch, never leave it stranded In-Progress. Three field-tested principles (full survey: `research/20260614_agent_crash_stall_recovery_session_association.md`):

1. **Tracker + durable claim = source of truth; local state is a cache.** Our `agent/claimed` label + In-Progress state survives any process death — already better than Symphony, which claims _in-memory_ and loses it on restart (it re-derives everything from Linear + the on-disk workspace each boot).
2. **The checkpoint is the git commit + the agent's own session log**, so recovery **resumes** (re-attach to the worktree at `HEAD`, replay the Claude JSONL session via `resume`) rather than restarting. (Temporal event-replay / LangGraph `thread_id` / OpenHands event-sourcing / Copilot PR-as-checkpoint all converge here; our JSONL session already _is_ an event log.)
3. **"Parked on a human" is a _distinct state_, not a flag** — the stall sweep must never reclaim a `needs-input` item, or it would steal a task that's legitimately waiting on you. (Temporal Signal-wait vs heartbeat; LangGraph `interrupt()`.)

**The durable run record** — the session↔issue association. Keyed by issue, written to `flow-state.json` (v1, disk) and graduating to server SQLite (v2):

```ts
FlowRun {
  issueId, identifier        // tracker id + "DOR-123" (worktree/branch key)
  sessionId                  // Claude SDK JSONL id — for resume
  worktreePath, branch       // ~/.dork/workspaces/<project>/<key>/ , dork/<key>
  status                     // queued | running | waiting_for_review | complete | failed
  attemptCount               // increments on each reclaim
  workerPid                  // v1 liveness check
  heartbeatAt                // v2 (concurrent) liveness check
  startedAt, completedAt
}
```

**What the next tick does (the recovery ladder)** — driven by the item's _disposition_, not by whether a comment exists (a `needs-input` comment parks; a progress/quit comment is informational):

| Orphan signal                                                        | Action                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/needs-input` (parked on human)                                | **Skip** — resumes only when you reply (`getInbox`); never reclaimed by the stall sweep.                                                                                                |
| `agent/claimed`, In-Progress, **no live worker**                     | **Adopt + resume** if `worktreeExists AND sessionLogIntact AND attemptCount < recovery.maxRetries`; else **restart-clean** (reset to base, fresh worktree + session); `attemptCount++`. |
| over `recovery.maxRetries`                                           | **Escalate** — `agent/blocked` + comment + nudge; stop reclaiming.                                                                                                                      |
| Tracker says In-Progress but **no local run record** (other machine) | **Re-derive** the record from tracker + workspace (tracker-as-truth fallback, Symphony's model).                                                                                        |

**v1 (sequential, single machine, WIP 1) needs no heartbeat or lease.** On a fresh tick, any `agent/claimed` + In-Progress + not-`needs-input` item is orphaned **by definition** (sequential ⇒ the prior session is dead), so a `workerPid` check — or simply "any `running` record seen at startup is stale" — suffices. v1 = durable claim (have it) + the run record + the disposition distinction + a startup/tick **sweep** that adopts orphans.

**v2 (server poller, concurrent) adds exactly what concurrency forces, and only then:** a **heartbeat** (`heartbeatAt`, ~60 s, replacing the PID check across machines), a **fencing token** (`attemptId` written on every status update so a half-recovered ghost worker's writes are rejected), **atomic multi-claim** (`BEGIN IMMEDIATE` / `SKIP LOCKED`), and a dedicated **stall-detector tick**. This is precisely the "session-locking · stall/restart reconciliation" earmarked as the server-edition residue (DOR-89, §3); the run record graduates `flow-state.json` → SQLite (the ADR-0043 file-first + reconciler precedent).

### 5.13 Phasing (for `/ideate-to-spec` to formalize)

- **P0 — Scaffold** (reconciliation done — see §3): create the **Flow Engine — Harness** Linear project + umbrella issue; stand up `.agents/flow/` **as a DorkOS marketplace `plugin`-type package** (README/SPEC/config/schema/manifest + `templates/`, embedding a `.claude-plugin/plugin.json`; no `extensions` layer yet) and the harness-sync wiring (extend the manifest to register the `flow` bundle: skills synced, commands Claude-native, hook in settings.json).
- **P1 — Extract & thin** (no behavior change): legacy commands → `/flow` + `/flow:<stage>` thin triggers over gerund stage skills; define the **`adapters/linear/` adapter skill** (the v1 `PMClient`); move Linear logic into it; collapse the dual task system; add `issue`/`parentIssue` to the `03-tasks.json` schema + the PM-agnostic provenance block. Pure refactor; everything still works manually.
- **P2 — Unify the loop**: generalize the autonomous Stop-hook into the operator-run draining loop reading canonical stage state; implement mode orthogonality, uncertainty-gated involvement + comms routing, and config-driven gates (incl. auto-merge-on-approval).
- **P3 — Agent-as-team-member v1**: service-account identity, inbox polling, comment/assign/handoff, soft-escalation, durable label claims.
- **P4 — Proof-of-completion**: VERIFY stage browser automation + evidence-class attachment.
- **P5 — Later = the Flow Engine — Extension project (DOR-88…)**: promote this proven harness into the **single full-stack DorkOS extension** (server orchestrator + console dashboard, one package) — server `PMClient`, webhook/`dorkos.ai` relay + full Linear Agent Accounts, the server-side `WorkspaceManager` (graduating the `gtr` flow), unattended evidence pipeline; a second PM adapter proves agnosticism. This is the next phase, tracked in Linear (§3), not built here.

---

## 6) Decisions

| #   | Decision                 | Choice                                                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                                                                                                              |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | System structure         | **Harness-first skill pack**                                                                                                                                                                                                                                | Fast, dogfoodable today; matches "eventually a plugin"; core logic written to port to a server extension later.                                                                                                                                                                                        |
| 2   | Manual vs autonomous     | **One engine, two modes**; mode ⟂ trigger                                                                                                                                                                                                                   | No drift between the two ways of working. Autonomous default when PM-driven; available in CLI too.                                                                                                                                                                                                     |
| 2a  | Autonomous stop behavior | **Planned gates + dynamic soft-escalation**                                                                                                                                                                                                                 | Beyond the review gate, the agent stops + comments + assigns-to-human any time it's genuinely stuck.                                                                                                                                                                                                   |
| 3   | Where tasks live         | **Hybrid: `03-tasks.json` source of truth + ticket mirror + selective sub-issues**                                                                                                                                                                          | Durability + richness without tracker spam; sub-issues only when independently dispatchable.                                                                                                                                                                                                           |
| 4   | Stage↔state mapping      | **Coarse PM states + `stage/`* labels; match on state *category\***                                                                                                                                                                                         | Clean 1:1 at the trigger level; PM-agnostic; no brittle per-team state config.                                                                                                                                                                                                                         |
| 5   | Agent identity (default) | **v1 service-account + polling; v2 Linear Agent Accounts + webhooks**                                                                                                                                                                                       | Local-webhook problem + 10s AIG timing make Agent Accounts infeasible until a `dorkos.ai` relay exists.                                                                                                                                                                                                |
| 6   | Proof channel (default)  | `**gif_creator` now + Playwright WebM; attach via PR + tracker `externalUrls*`\*                                                                                                                                                                            | Zero-setup today; WebM already wired in `apps/e2e`; URL fits both PR and tracker.                                                                                                                                                                                                                      |
| 7   | Packaging mechanism      | **Extend `.agents/harness.manifest.json` for a `flow` bundle** — skills synced (symlink); commands/hooks stay Claude-native (registered, not synced)                                                                                                        | Ground truth: the manifest syncs skills only. Keeps one identifiable unit without fighting Claude Code discovery; see §5.9 for the honest layout and #24 for the package target.                                                                                                                       |
| 8   | Command surface          | **Unify under `/flow`** — orchestrator + `/flow:<stage>`; work in gerund skills; side-effect gates via `disable-model-invocation`                                                                                                                           | Research: industry converges on skills-do-work + thin commands; one prefix = one identifiable system; PM-agnostic. Hard rename, no aliases.                                                                                                                                                            |
| 9   | System name              | **Descriptive ("the `/flow` engine")**                                                                                                                                                                                                                      | Your call; plain + self-explanatory; identity carried by the prefix + README, not a coined word.                                                                                                                                                                                                       |
| 10  | Involvement model        | **Uncertainty-gated, not stage-gated**                                                                                                                                                                                                                      | Every stage auto-capable + PM-tracked; human pulled in only on real questions. Makes question-asking the key behavior.                                                                                                                                                                                 |
| 11  | Comms channel            | **Infer from trigger, overridable** (CLI interactive / PM comments; +Relay/Telegram nudge)                                                                                                                                                                  | The trigger encodes where you are; no new plumbing; matches the "Telegram when done" vision.                                                                                                                                                                                                           |
| 12  | Autonomous trigger (v1)  | **Operator-run draining loop**; server/DorkBot poller is v2                                                                                                                                                                                                 | Matches harness-first; ships now; poller is an additive upgrade for truly-unattended start.                                                                                                                                                                                                            |
| 13  | Git boundary             | **Branch + PR + evidence → auto-merge on approval (CI green) → close + teardown**, with a **recovery ladder** when the approved state goes stale (§5.5)                                                                                                     | PR is the observable review boundary; approval is the one human gate; merge automated once trusted — but approval authorizes one specific state, so conflict/CI/drift route back through the calibration ladder.                                                                                       |
| 14  | Concurrency              | **Sequential (WIP 1), parallel-ready**                                                                                                                                                                                                                      | Parallel multiplies cost/conflict/review load; prove sequentially, raise the cap by config later.                                                                                                                                                                                                      |
| 15  | Config scope             | **Pack defaults (`.agents/flow/config.json`) + optional per-repo `WORKFLOW.md`**                                                                                                                                                                            | Single source now, clean portability when it's a plugin used elsewhere.                                                                                                                                                                                                                                |
| 16  | Workspaces               | **Keep the `gtr` worktree flow** (no WorkspaceManager service in v1)                                                                                                                                                                                        | Works today; WorkspaceManager is a later quality-of-life upgrade, not a v1 blocker.                                                                                                                                                                                                                    |
| 17  | Context strategy         | **Externalize state + fresh context per unit; orchestrator is code; auto-compact = backstop**                                                                                                                                                               | Context rot + compaction drift degrade long multi-issue runs; every mature autonomous system externalizes memory + resets per unit. Falls out of the stateless design already chosen.                                                                                                                  |
| 18  | DOR reconciliation       | **Existing "Orchestration Extension" project = Phase 2 (server edition) of `/flow`; rewrite-in-place, nothing superseded**                                                                                                                                  | Re-anchor Symphony→`/flow` collapses redundant research scope; preserves each issue's audit trail (§3).                                                                                                                                                                                                |
| 19  | Server vs console        | **One full-stack DorkOS extension** (orchestrator + dashboard), not two                                                                                                                                                                                     | Marketplace packages contribute multiple layers; the existing `linear-issues` extension already spans server + client. Two would fragment one product.                                                                                                                                                 |
| 20  | Artifacts & drift        | **Filesystem canonical; tracker = pointers + state + conversation; bidirectional ID-only back-links**                                                                                                                                                       | One copy of prose ⇒ no drift; state is derived from artifact events; an ID back-link is stable and low-churn.                                                                                                                                                                                          |
| 21  | Link cardinality         | **Anchor 1:1 (spec → one issue _or_ project); 1:many normalized via `03-tasks.json` per-task `issue` + typed relations**                                                                                                                                    | A flat `issues:[…]` list duplicates the task→issue map and drifts; multiplicity belongs where decomposition is canonical.                                                                                                                                                                              |
| 22  | Sub-issue promotion      | **Exception, not rule — only `size ≥ large`; most tasks stay checklist lines**                                                                                                                                                                              | One umbrella + a handful (often zero) of sub-issues; per-task issues would spam the tracker and fragment the spec.                                                                                                                                                                                     |
| 23  | Templates                | **System owns record-by-type, PR, and doc templates at the root** (generalized, PM-agnostic)                                                                                                                                                                | Formalize emergent conventions; "one policy, two consumers" (the `dispatch-priority.md` precedent shared by `/pm` + the extension).                                                                                                                                                                    |
| 24  | Packaging (Q3 — decided) | **Dogfood `/flow` as a DorkOS marketplace `plugin`-type package from P1** (embeds a CC plugin via `requiresClaudePlugin()`); v1 contributes commands/skills/hooks/templates, **no `extensions` layer** (that's P5); `.agents/` stays the cross-harness glue | Option (A): DorkOS _is_ a marketplace, so dogfooding our package format is on-mission; "one identifiable installable unit" true on day one; product-extension extraction is then additive, not a rewrite.                                                                                              |
| 25  | MONITOR/SIGNAL           | **Generalize the framing (PM-agnostic `monitoring-work`; SIGNAL re-enters at CAPTURE; labels are projection), defer the automation** — out of v1 scope; existing `linear-loop` tail serves it                                                               | They're not Linear-coupled (only the labels were); removing the asterisk keeps the PM-agnostic claim clean, while the temporal trigger they need is genuinely future scope, not v1.                                                                                                                    |
| 26  | Identity & ownership     | **Dedicated agent account ideal, shared-account fallback (mode _detected_); ownership/authorship via labels + comment marker, account-identity as enhancement; `classifyOwnership` drives both dispatch & comment-handling; conservative comment-response** | The agent operates in a shared human tracker — it must know what's its / the human's / others' / unassigned, recognize its own comments, and respond only when addressed. Labels+marker make one mechanism serve both account modes; "auto" bakes no personal identity into the distributable package. |
| 27  | Crash & stall recovery   | **Durable run record (issueId↔sessionId↔worktree) + adopt-and-resume on orphaned claims; parked (`needs-input`) ≠ crashed; v1 sequential needs no lease, v2 server adds heartbeat + fencing token (DOR-89 residue)**                                        | Sessions are ephemeral, the work is durable; checkpoint = git commit + JSONL session ⇒ resume, not restart; the stall sweep must never reclaim an item parked on a human. Field-validated against Symphony, Temporal, LangGraph, GitLab Duo (§5.12, research 2026-06-14).                              |

---

## 7) Open Questions (for `/ideate-to-spec`)

1. ~~**DOR-89/90/95 reconciliation**~~ — **RESOLVED 2026-06-14 (§3).** Existing "Orchestration Extension" project becomes Phase 2 (server edition) of `/flow`; rewrite-in-place; nothing superseded. _Remaining: enact the Linear renames/rewrites/links (next execution step)._
2. ~~**Question-asking calibration**~~ — **RESOLVED 2026-06-14 (§5.5).** The **calibration ladder**: a hard always-ask floor + a reversible×confident test → three behaviors (proceed-silent / proceed-with-trail / stop-and-ask); per-stage sensitivity is emergent (the frozen spec is the cut line — intent stages ask, execution stages proceed-and-log); "learning" = answers written to decisions/ADR/config so the evidence-test finds them next time. Config: `involvement.calibration` (§5.7).
3. **Poller seat in v1** — the operator-run loop polls the tracker, but via which mechanism: the generalized `autonomous-check` Stop-hook, a `/loop`-driven tick, or a tiny local watcher? All poll; pick the cleanest.
4. **Plan-approval gate default** — `gates.planApproval` on or off by default? On = you approve the decomposition before any code; off = more hands-off.
5. ~~**Auto-merge safety path**~~ — **RESOLVED 2026-06-14 (§5.5).** The **recovery ladder**: approval authorizes one specific state (this diff, green, cleanly mergeable); at merge time three preconditions are checked (mergeable / CI-green / functionally-unchanged), and each failure routes through the calibration ladder — mechanical issues (clean rebase, mechanical conflict resolution, CI flake retry) → resolve + announce; real tradeoffs (functional conflict, behavior-altering fix) → bounce + re-assign / re-request approval; runaway bounce → circuit-breaker. Config: `gates.review` (§5.7).
6. **Sub-issue promotion threshold** — hybrid promotes at `size ≥ "large"`/≥3; confirm the cut and whether parent size also gates it.
7. **Context tuning (§5.11)** — fresh `claude` session per issue vs `/clear` between issues in v1; confirm the per-stage token budgets and the ~65% compaction trigger; what the `AGENTS.md` "Compact Instructions" block should preserve.

---

## 8) Next Steps

1. Review this document.
2. ✅ **Reconciliation done** (§3); **Q3 packaging confirmed** — dogfood `/flow` as a DorkOS marketplace package from P1 (Decision #24). **Enact the Linear changes** — rename the project family (Harness / Extension / Console-v0), rewrite-in-place DOR-88/89/90/95/102, add the dependency links, position Workspaces.
3. Run **`/ideate-to-spec specs/unified-workflow-system/01-ideation.md`** to produce `02-specification.md` (formalize the stage model, the `adapters/linear/` adapter skill / Phase-2 `PMClient`, the config schema + templates + provenance, and the P0–P5 phasing into concrete acceptance criteria).
4. Then `/spec:decompose` → `/spec:execute`, starting with **P1 (extract & thin)** as a pure, low-risk refactor that proves the structure before any behavior change.
