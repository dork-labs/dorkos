---
slug: unified-workflow-system
number: 257
created: 2026-06-14
status: specified
---

# Unified Workflow System — the `/flow` engine

**Status:** Specified
**Authors:** Claude Code, 2026-06-14
**Spec:** #257
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [workspace strategy / Symphony](../../research/20260611_workspace_strategy_runtimes_symphony.md) · [crash/stall recovery](../../research/20260614_agent_crash_stall_recovery_session_association.md) · [Linear agent accounts](../../research/20260611_linear-agent-accounts.md) · [work sequencing](../../research/20260611_work-sequencing-linear-method.md) · [browser video recording](../../research/20260611_agent_browser_video_recording.md)

---

## Overview

Consolidate the three overlapping harness subsystems — ideation/spec/execution (`/ideate`, `/spec:*`), Linear integration (`/pm`, `/linear:*`, `linear-loop`), and workspace management (`/worktree:*`, hooks) — into a single, PM-tool-agnostic **workflow engine** (`/flow`). The engine runs one canonical stage model two ways: **manually** via slash commands, and **autonomously** driven entirely through a PM tool, where the agent behaves like a real team member in the tracker. v1 ships as a DorkOS marketplace `plugin`-type package whose manual mode is server-free and portable, and whose autonomous loop is seated on the existing DorkOS **Pulse** scheduler.

This is primarily **unification + extraction + formalization** of pieces that already exist, not greenfield. It is the harness (P1) that the server-side **Flow Engine — Extension** project (P2, Linear DOR-88…) later promotes into a full-stack DorkOS extension.

## Background / Problem Statement

Three harness areas grew independently and now overlap and conflict:

- **Four independent notions of "where work is"** — spec status (`specs/manifest.json`), Linear issue state, Linear `stage/*`/`agent/*` labels, and the autonomous-loop phase (`roadmap.json`) — plus **two** independent "loops" (the `autonomous-check` Stop-hook and the `linear-loop` skill) that don't know about each other.
- **Thick commands.** Nine spec commands carry 250–590 LOC of inline logic each; only `/spec:execute` (39 LOC) correctly delegates to a skill. Breadcrumb logic is copy-pasted ×4.
- **Hard Linear coupling.** `/pm` and `linear-loop` reach Linear directly with no adapter seam, so the system can't target another tracker.
- **No single autonomous path.** "Run it through Linear unattended until human review" isn't expressible: there's no uncertainty-gated involvement model, no config contract, no auto-merge boundary, and no crash/stall recovery.

The fix is **one canonical stage model**, with spec status, PM state, labels, and loop phase all _projected_ from it through a tracker adapter — and a thin command surface over generic, auto-invocable stage skills.

## Goals

- **One identifiable system** under a single `/flow` command prefix: a `/flow` orchestrator + `/flow:<stage>` jumps, with the work living in gerund stage skills (hard rename of legacy commands, no aliases).
- **One engine, two modes.** Execution mode (step vs autonomous) is orthogonal to trigger source (manual CLI vs PM-driven). Autonomous is the default when PM-driven.
- **PM-tool-agnostic.** No generic stage skill touches a tracker API directly; all tracker I/O flows through an adapter (`adapters/linear/` first).
- **Uncertainty-gated involvement.** Every stage can run autonomously and is PM-tracked; the human is pulled in only on genuine questions / consequential calls — codified by the **calibration ladder**.
- **Autonomous-until-review.** Do the work, open a PR with browser/test evidence, move to a review state, assign back to the human, stop; on approval (CI green) auto-merge + close + tear down — with a **recovery ladder** when the approved state goes stale.
- **Config at the system root** (`.agents/flow/config.json` + optional per-repo `WORKFLOW.md`), Zod-validated.
- **Durable, drift-free artifacts.** Filesystem is canonical; the tracker holds pointers + state + conversation; back-links are ID-only and bidirectional.
- **Browser proof-of-completion** at the VERIFY stage, attached to the PR and tracker.
- **Crash/stall recovery** — adopt-and-resume orphaned claims; never restart from scratch; never reclaim work parked on a human.

## Non-Goals

- Building the server-side **Flow Engine — Extension** (server `PMClient`, webhook listener, `WorkspaceManager` service, unattended evidence pipeline). Designed-for, tracked in Linear (DOR-88…), **not built here**.
- **Full Linear Agent Accounts / webhooks** (blocked by the local-webhook problem) — v2; v1 is poll-first (Pulse cron).
- A **second PM adapter** (Jira/GitHub Issues). The interface is defined now; a second implementation proves agnosticism later.
- Changing the **product** (`apps/*`) beyond the Pulse-seat integration touchpoints; this is harness (`.claude/`, `.agents/`) + a marketplace package.
- **Automated MONITOR/SIGNAL.** Generalized in the model (PM-agnostic `monitoring-work`; SIGNAL re-enters at CAPTURE) but the temporal-trigger automation is out of v1 scope; the existing `linear-loop` tail serves it (Decision #25).

## Technical Dependencies

- **Harness sync:** `.agents/harness.manifest.json` (syncs **skills** via symlink; commands stay Claude-native in `.claude/commands/`; hooks stay in `.claude/settings.json`). See `project_dual_harness_skills`.
- **DorkOS Pulse / Tasks** (`apps/server/src/services/tasks/`): `TaskSchedulerService` (croner, `protect:true`, `maxConcurrentRuns`), `TaskFileWatcher` (chokidar), file-first `SKILL.md` task definitions in `~/.dork/tasks/` (global) and `<project>/.dork/tasks/` (project), `pulseSchedules`/`pulseRuns` SQLite cache. Used as the v1 autonomous poller seat.
- **`gtr` worktrees** (`.gtrconfig`, `.claude/scripts/worktree-setup.sh`): per-issue isolation with unique `DORKOS_PORT`/`VITE_PORT`/`SITE_PORT`. Worktrees live at `~/.dork/workspaces/core/<key>/`.
- **Linear access:** Linear MCP primary; Composio CLI v0.2.31 (`composio execute LINEAR_*`, personal/DorkOS account) fallback. See `reference_linear_composio_access_dorkos`.
- **Config pattern:** Zod schema → `z.toJSONSchema` (the `conf` precedent, `reference_conf_and_config`).
- **Evidence:** Playwright library `recordVideo` (WebM, already wired in `apps/e2e`, headless); `gif_creator` (claude-in-chrome, interactive only).
- **Marketplace packaging:** `@dorkos/marketplace` `plugin`-type package + `requiresClaudePlugin()` (embeds `.claude-plugin/plugin.json`).
- **Decomposition artifact:** existing `specs/<slug>/03-tasks.json` schema (extended with `issue`/`parentIssue`).

## Detailed Design

### 1. The spine: one stage model

```
 manual ─▶  CAPTURE → TRIAGE → IDEATE → SPECIFY → DECOMPOSE → EXECUTE →
 PM-driven ─▶        VERIFY → ⟦HUMAN REVIEW⟧ → DONE → (MONITOR → SIGNAL)
                     ▲ adapter (PMClient): Linear today, swappable
```

- **Stage** = the canonical unit of "where work is." Spec status, PM state, labels, and loop phase are all **projected** from the stage via the adapter — never authored independently.
- **Stage skill** = a generic, PM-agnostic, gerund-named skill that does one stage's work. A thin `/flow:<stage>` command and a PM transition are two **triggers** for the same skill (realizing the "1:1 command↔state" intuition at the _trigger_ level).
- **Match on state _category_** (`backlog | unstarted | started | completed | canceled`), never on a tracker's state _name_ — so the system is portable across teams/trackers.

| Stage               | Generic skill                     | Absorbs today's…                                  | PM projection (Linear)            |
| ------------------- | --------------------------------- | ------------------------------------------------- | --------------------------------- |
| CAPTURE             | `capturing-work`                  | `/linear:idea`, `capturing-linear-ideas`          | `type/idea`, Triage               |
| TRIAGE              | `triaging-work`                   | `/pm` triage/intake                               | type-label set, Backlog/Todo      |
| IDEATE              | `ideating-features` (exists)      | `/ideate`                                         | `stage/ideate`                    |
| SPECIFY             | `specifying-work`                 | `/ideate-to-spec`, `/spec:create`                 | `stage/specify`                   |
| DECOMPOSE           | `decomposing-work`                | `/spec:decompose`, `/spec:tasks-sync`             | `stage/decompose`, plan checklist |
| EXECUTE             | `executing-specs` (exists)        | `/spec:execute`, worktree setup/teardown          | In Progress, `agent/claimed`      |
| VERIFY              | `verifying-work`                  | `/review-recent-work`, browser proof, code review | evidence on issue/PR              |
| REVIEW (human gate) | — (engine parks)                  | `/linear:done` precondition                       | In Review + assigned to human     |
| DONE                | `closing-work`                    | `/linear:done`, `closing-linear-loop`             | Done, `agent/completed`           |
| MONITOR/SIGNAL      | `monitoring-work` (optional tail) | `linear-loop` tail                                | `type/monitor`, `type/signal`     |

Each `/flow:<stage>` command is ≤ ~40 LOC (mirrors `/spec:execute` today) and only invokes the stage skill.

### 2. Trigger doors × execution modes (orthogonal)

|                        | **Step** (run one stage, stop)      | **Autonomous** (run to a gate)                                          |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| **Manual** (CLI/slash) | `/flow:specify`, `/flow:execute`    | `/flow auto` — drain the ready queue from the terminal                  |
| **PM-driven**          | rare; explicit single-stage advance | **default** — Pulse tick claims an issue, carries it to the review gate |

Every stage is autonomous-capable and PM-tracked; the human is pulled in by **uncertainty**, not by stage (§5).

### 3. The work model + the `adapters/linear/` skill (the v1 PMClient)

The adapter normalizes every tracker into one `WorkItem` shape so generic stages and the dispatch policy never touch a tracker-specific field:

```
WorkItem { id, identifier, title, description,
  type,            // idea|research|hypothesis|task|monitor|signal|meta
  stateCategory,   // matched on CATEGORY, never name
  stateName,       // display only
  priority,        // 0–4
  size,            // points/t-shirt (drives sub-issue promotion + ranking)
  project,         // { id, name, stateCategory, lead }
  parent, relations { blocks[], blockedBy[], children[], relatedTo[], duplicateOf? },
  labels[],        // includes stage/* and agent/*
  assignee,        // → classifyOwnership(): mine|reviewer|other|unassigned
  agentDisposition // ready|claimed|completed|needs-input
}
```

The capability interface (verbs the generic layer knows): `getCurrentUser`, `getProjects`, `getEligibleWork`, `getInbox`, `getRelations`, `claim`, `transition`, `comment`, `assignToHuman`, `attachEvidence`, `needsInput`, `link`, `createSubIssue`.

**v1 realization:** `PMClient` does **not** exist as code. The v1 adapter is a **single `adapters/linear/` skill** that owns every `mcp__linear__*` / Composio call (Linear MCP primary, Composio `--account personal` fallback) and fulfils the verbs above as a **documented prose contract**. Generic stage skills call that skill instead of touching tracker strings. The typed TypeScript `interface PMClient` is what the **P5 server build** promotes it into — so the agnosticism win ("all Linear in one place") is real in v1 with no new infrastructure.

- **State machine = `agent/*` labels**, not the ephemeral `plan` field (Huginn durability lesson).
- **Graceful degradation:** trackers lacking `project.stateCategory`/`priority`/`size` (e.g. GitHub Issues) supply what exists; the dispatch policy treats missing fields as neutral.

### 4. Dispatch policy (choosing what to work on)

Two passes, both config-driven (`dispatch` block):

**Eligibility — filter out** an item if: `stateCategory` not dispatchable · lacks `agent/ready` (PM-driven mode) · `blockedBy` any open item · its `project.stateCategory` is completed/canceled · per-project or global **WIP cap** reached · its `classifyOwnership` class isn't in the `ownership` claim policy (never the reviewer's or others' items; in shared-account mode never an item merely on the shared account without `agent/claimed`).

**Ranking — order survivors** (ordered tiers, later tiers break ties): `1 unblockers → 2 priority → 3 project status → 4 type → 5 size → 6 age → 7 identifier`. Weights live in config; re-prioritizing never touches code.

### 5. Human involvement — calibration ladder, gates, comms

**Involvement is uncertainty-gated, not stage-gated.** At each decision point the agent walks the **calibration ladder** top-down, acting on the first matching row:

| #   | Condition                                                                                          | Behavior                                                  | Blocks loop?    |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------- |
| 0   | **Floor** — irreversible/destructive · outward-facing · secrets/spend/prod · material scope change | **Stop & ask** (`needsInput()`) — even at full confidence | yes             |
| 1   | Reversible + confident                                                                             | Proceed silently                                          | no              |
| 2   | Sticky + not-confident                                                                             | Stop & ask                                                | yes             |
| 3   | Reversible + not-confident (the ambiguous middle)                                                  | **Routed by stage bias**                                  | stage-dependent |
| 4   | Sticky + confident                                                                                 | Proceed, but **announce**                                 | no              |

- **Confident** = the answer is determined by the frozen spec, an ADR/decision, a strong codebase convention, or a prior human answer — not a hunch.
- **Reversible** = cheap to undo inside the loop (code edit, worktree file, draft comment).
- **Stage bias routes row 3, frozen spec is the cut line:** intent stages (CAPTURE/TRIAGE/IDEATE/**SPECIFY**) → **ask**; execution stages (DECOMPOSE/EXECUTE/VERIFY) → **proceed on the best default + log the assumption**. Yields "IDEATE asks freely, EXECUTE asks rarely" as an emergent property of one rule.
- **Every non-obvious call leaves a trail** (`agent/assumption` comment + stage-artifact note), auditable at the review gate.
- **Answers become memory** by being written where row 1's evidence-test will find them next time (decisions table / ADR / `config.json`) — no separate store.

**Comms channel — inferred from trigger, config-overridable:** CLI with a live session → ask interactively (`AskUserQuestion`); PM-driven/away → post a comment, apply `agent/needs-input`, **assign to the human**, resume on their reply (`getInbox`); optional Relay/Telegram nudge.

**Reading the channel back (comment-response) — hard rules then a conservative soft zone:** (1) never answer its own comments (author == agent or carries `identity.marker`); (2) always respond when directly addressed (@mention / explicit `/flow` token — overrides ownership); (3) resume when an `agent/needs-input` item gets a non-agent comment; (4) stay out of `other`-owned threads unless mentioned; (5) **soft zone leans quiet** — over-responding is the worse failure.

**The hard gates:**

1. **Question / soft-escalation** (any stage, dynamic) — driven by the calibration ladder.
2. **Plan-approval gate** (after DECOMPOSE, before EXECUTE) — **off by default** (`gates.planApproval: false`, Decision §7.4): the engine flows DECOMPOSE→EXECUTE automatically and surfaces plan assumptions at the human-review gate. Operators who want a pre-code checkpoint flip it on.
3. **Human-review gate** (after VERIFY) — **always on.** PR + evidence → In Review → assign to human → stop. On approval + CI green → auto-merge + close + teardown.
4. **Circuit breaker** — stop + escalate if a unit exceeds `estimate × N` wall-clock or a token budget.

### 6. Auto-merge recovery ladder

Approval authorizes **one specific state**: this diff, green, cleanly mergeable. If that state can't be reproduced automatically at merge time, the agent does not merge — it checks three preconditions, each failure routing through the calibration ladder:

| Precondition                               | Pass                                                      | Fail → disposition                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mergeable?**                             | clean replay → continue, announce rebase                  | conflict → mechanical/no-functional-risk (both add an import, append a changelog/lockfile) → **resolve + announce**; real tradeoff (overlapping logic edits) → **bounce** (`agent/needs-rebase`, In Progress, comment, re-assign) |
| **CI green?**                              | green → continue                                          | red → **retry once** (flake guard); still red → re-enter EXECUTE→VERIFY, regenerate evidence                                                                                                                                      |
| **Functionally unchanged since approval?** | mechanical-only → **merge + close + teardown** (announce) | behavior-altering → **re-request approval** (re-assign, fresh evidence)                                                                                                                                                           |

Runaway bounce (fix→review→red over `gates.review.maxMergeAttempts`) → circuit-breaker escalation (`agent/blocked` + nudge).

### 7. Identity & ownership

Governing principle: **ownership/authorship live in labels + a comment marker (durable, always present); a dedicated agent account is a cleaner enhancement when it exists.**

- **Two-account (ideal):** agent (`identity.agent`) and human (`identity.reviewer`) have distinct tracker accounts — assignee + authorship unambiguous.
- **Shared-account (fallback):** agent acts _as_ the human's account; it claims via the `agent/claimed` **label** only, recognizes its own comments by **marker**, hands off by **label + nudge**.
- **The mode is _detected_:** `identity.reviewer` unset or == `identity.agent` ⇒ shared mode; otherwise two-account.
- **One primitive, two consumers:** `classifyOwnership(item) → mine | reviewer | other | unassigned` (compares `assignee`/`project.lead` against `identity.agent`/`identity.reviewer`) drives **both** dispatch eligibility (§4) and comment-handling (§5). The `ownership` config declares which classes the agent may claim — applied to issues **and** projects.
- **No personal identity ships in the package** — defaults (`identity.agent: "auto"`, `identity.reviewer: null`) resolve at runtime from the installer's authenticated account.

### 8. Task decomposition, artifacts & provenance

- **`specs/<slug>/03-tasks.json` = single source of truth** for decomposition (existing schema). Durable across session/thread archives.
- **Schema extension:** add optional per-task **`issue`** and **`parentIssue`** fields (currently absent) — the only place the task→issue mapping lives.
- **Sub-issue promotion is the rare exception** (Decision §7.6, raised to **`size ≥ "xl"`**): promote a task to its own tracker sub-issue only when `size ≥ decomposition.subIssueThreshold` (default **`"xl"`**); parent size does **not** additionally gate. The vast majority of tasks stay **checklist lines** mirrored into the ticket. Expected shape: one umbrella issue + (often zero) promoted sub-issues.
- **Mirror** the active phase into the ticket as a checklist, **generated from `03-tasks.json`, never hand-edited.**
- **Collapse the dual task system:** `03-tasks.json` is canonical; the built-in Task API becomes a _projection_ for live display.

**Link cardinality — 1:1 at the anchor, 1:many through structure:**

```
spec ─(1:1)─▶ ONE tracker "home"        ← issue (small spec) OR project (large spec)
  └─ 03-tasks.json
       ├─ task ─(1:1)─▶ sub-issue        ← 1:many, normalized; MOST tasks have none
       └─ task (checklist only)
  └─ relations ─(typed, rare)─▶ related / supersedes   ← via adapter link()
```

Generalize today's scalar `linear-issue:` frontmatter into a **PM-agnostic provenance block** naming one issue _or_ project. A flat `issues: […]` list is **rejected** (duplicates the task→issue map; reintroduces drift). **Filesystem is canonical; the tracker holds pointers + state + conversation — never a second copy of prose.** Back-links are **bidirectional but ID-only** (stable, low-churn), extended to ADRs and research, not just specs.

### 9. Configuration (`.agents/flow/config.json`)

Zod-validated → `config.schema.json` (via `z.toJSONSchema`). Resolved defaults reflect §7.4/§7.6/§7.7:

```jsonc
{
  "$schema": "./config.schema.json",
  "tracker": "linear",
  "identity": { "agent": "auto", "reviewer": null, "marker": "— 🤖 /flow" },
  "ownership": {
    "claimAssignedToAgent": true,
    "claimUnassigned": true,
    "claimAssignedToHuman": false,
    "claimAssignedToOthers": false,
    "scope": ["issues", "projects"],
  },
  "comments": { "respondWhen": "addressed", "ambiguousBias": "quiet" },
  "stages": {
    "capture": { "command": "/flow:capture", "label": "stage/capture" },
    "triage": { "command": "/flow:triage", "label": "stage/triage" },
    "ideate": { "command": "/flow:ideate", "label": "stage/ideate" },
    "specify": { "command": "/flow:specify", "label": "stage/specify" },
    "decompose": { "command": "/flow:decompose", "label": "stage/decompose" },
    "execute": { "command": "/flow:execute", "label": "stage/execute", "stateCategory": "started" },
    "verify": { "command": "/flow:verify", "label": "stage/verify", "stateCategory": "started" },
    "review": { "stateCategory": "started", "humanGate": true },
    "done": { "command": "/flow:done", "label": "stage/done", "stateCategory": "completed" },
  },
  "autonomy": {
    "default": "auto",
    "concurrency": "sequential",
    "wipCap": { "global": 2, "perProject": 1 },
    "seat": "pulse", // v1 autonomous poller seat (DorkOS); "watcher" = documented portable fallback (not built in v1)
  },
  "involvement": {
    "comms": "infer-from-trigger",
    "calibration": {
      "proceedSilentlyWhen": ["reversible", "confident"],
      "alwaysAsk": [
        "irreversible-or-destructive",
        "outward-facing",
        "secrets-or-spend",
        "scope-change",
      ],
      "stageBias": { "intake": "ask", "execution": "proceed-and-log" },
      "assumptionLog": { "artifact": true, "ticketComment": "pm-driven" },
    },
    "nudge": { "relay": false, "telegram": false },
  },
  "dispatch": {
    "rank": ["unblockers", "priority", "projectStatus", "type", "size", "age"],
    "sizeOrder": "small-first",
  },
  "gates": {
    "planApproval": false, // §7.4 — OFF by default; flow DECOMPOSE→EXECUTE, surface assumptions at review
    "review": {
      "mergeOnApproval": true,
      "requireCiGreen": true,
      "teardownWorktree": true,
      "onConflict": "resolve-if-mechanical",
      "ciRetries": 1,
      "reapproveOnFunctionalChange": true,
      "maxMergeAttempts": 3,
    },
    "circuitBreaker": { "estimateMultiplier": 2, "tokenBudget": 2000000 },
  },
  "context": {
    "perIssue": "fresh-session", // §7.7 — fresh claude session per issue
    "perStage": "fresh-subagent",
    "compactionTrigger": 0.65,
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
  "recovery": { "maxRetries": 2, "onExhausted": "block", "staleAfter": "5m" },
  "decomposition": { "mode": "hybrid", "subIssueThreshold": "xl" }, // §7.6 — XL-only promotion
  "evidence": {
    "ui": "auto",
    "temporal": "video",
    "logic": "test-summary",
    "attachTo": ["pr", "tracker"],
  },
}
```

### 10. The autonomous loop — the Pulse seat (§7.3, revises Decision #12)

The v1 autonomous loop is seated on **DorkOS Pulse**, not a bespoke watcher. Rationale: Pulse already provides a contextless code-loop (croner) that dispatches a **fresh, isolated, resumable, runtime-agnostic agent session per run** — exactly the orchestrator shape §5.11/§5.12 require — so there is no scheduler to build (this also answers DOR-89's "does Pulse subsume the poll loop?" → yes, collapsing P2 scope).

**The schedule is a file.** A project-scoped `SKILL.md` task definition controls it; the SQLite `pulseSchedules`/`pulseRuns` tables are a derived cache (file-first, ADR-0043 pattern):

```markdown
## <!-- <project>/.dork/tasks/flow-drain/SKILL.md -->

name: flow-drain
display-name: /flow — drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
cron: "_/10 _ \* \* \*"
timezone: America/Los_Angeles
enabled: true
max-runtime: 2h
permissions: acceptEdits

---

Run one tick of the /flow autonomous loop:

1. Via adapters/linear, fetch eligible work and rank it (dispatch ladder, §4).
2. Claim the top issue (durable label + state), provision its worktree.
3. Carry it through the stages to its gate — uncertainty-gated involvement (§5).
4. Stop at the human-review gate or on a genuine question (needs-input).
```

- **One tick = one issue.** Each croner fire is a fresh run-session (`sessionId = run.id`) that claims and works exactly one issue to its gate, then ends — preserving fresh-session-per-issue (§7.7). `croner protect:true` prevents overlapping runs (sequential WIP-1); `maxConcurrentRuns`/`wipCap` govern concurrency when raised.
- **Activation requires only:** the DorkOS server running (hosts the chokidar watcher + croner) and — for a project task — the project's DorkOS agent registered (a **global** `~/.dork/tasks/` task is watched unconditionally). No build step, no migration; dropping the file is picked up live.
- **Server-free manual mode is unaffected:** `/flow`/`/flow:<stage>` and `/flow auto` (terminal draining) run without the server.
- **Portability fallback (documented, not built):** for a non-DorkOS repo wanting autonomous mode, a generic `claude -p`-per-issue watcher is the documented alternative seat. v1 builds only the Pulse seat.
- **Honest dependency statement** ships in the package README: _autonomous mode depends on a running DorkOS server (Pulse); manual mode does not._

### 11. Context strategy (§5.11, §7.7)

Four tiers, all falling out of the stateless design:

- **Tier 0 — orchestrator is code, not an LLM session.** croner is the loop; it holds ~no context.
- **Tier 1 — fresh context per unit.** A **fresh `claude` session per issue** (a Pulse run) + a fresh subagent per stage, each handed a compact brief (issue title/AC + ~200-token prior-stage summaries + the one input artifact + pointers); subagents return 200–400-token summaries then are discarded.
- **Tier 2 — externalized durable memory.** `flow-state.json` (handoff: current stage + artifact pointers + per-stage summaries), per-stage artifact dirs, `04-implementation.md`, `execution.log.jsonl`, cross-issue `flow-history.tsv` — plus the tracker. Filesystem + tracker are ground truth; the model is amnesiac by design.
- **Tier 3 — per-stage token budget + circuit breaker** (`context.stageBudgets`, 0.65 effective-window trigger).

Auto-compaction is the within-stage seatbelt, not the driver. An `AGENTS.md` "Compact Instructions" block preserves the current item, stage, gate state, and artifact pointers if it fires.

### 12. Crash & stall recovery (§5.12)

Sessions are ephemeral; the work is durable. A **durable run record** keyed by issue (the session↔issue association) is written to `flow-state.json` (v1, disk) → server SQLite (v2):

```ts
FlowRun {
  issueId, identifier;          // tracker id + "DOR-123" (worktree/branch key)
  sessionId;                    // Claude SDK JSONL id — for resume
  worktreePath, branch;         // ~/.dork/workspaces/<project>/<key>/, dork/<key>
  status;                       // queued|running|waiting_for_review|complete|failed
  attemptCount; workerPid;      // v1 liveness
  heartbeatAt;                  // v2 (concurrent) liveness
  startedAt, completedAt;
}
```

**Next-tick recovery ladder** (driven by disposition, not by comment presence):

| Orphan signal                                       | Action                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/needs-input` (parked on human)               | **Skip** — resumes only on the human's reply; never reclaimed.                                                                                |
| `agent/claimed`, In-Progress, no live worker        | **Adopt + resume** if `worktreeExists AND sessionLogIntact AND attemptCount < recovery.maxRetries`; else **restart-clean**; `attemptCount++`. |
| over `recovery.maxRetries`                          | **Escalate** — `agent/blocked` + comment + nudge.                                                                                             |
| In-Progress but no local run record (other machine) | **Re-derive** from tracker + workspace (tracker-as-truth).                                                                                    |

- The **checkpoint is the git commit + the JSONL session** ⇒ recovery **resumes** (re-attach worktree at HEAD, `resume` the session), never restarts.
- **v1 (sequential, single machine, WIP 1) needs no heartbeat or lease**: any `agent/claimed` + In-Progress + not-`needs-input` item on a fresh tick is orphaned by definition; a `workerPid` check suffices. With the **Pulse seat**, `sessionId = run.id` is captured per run, making each issue independently resumable.
- **v2 (concurrent) adds** heartbeat (`heartbeatAt`), fencing token (`attemptId`), atomic multi-claim (`BEGIN IMMEDIATE`/`SKIP LOCKED`), and a stall-detector tick — the server residue earmarked in DOR-89.

### 13. Browser proof-of-completion (VERIFY)

- Run Playwright (`apps/e2e`) for the touched surface; capture per `evidence` config: UI → annotated GIF (`gif_creator`, interactive) or WebM (`recordVideo`, unattended/`retain-on-failure`); temporal → video; logic → test-pass summary. `evidence.ui: "auto"` selects by trigger (interactive vs unattended).
- Attach via the adapter: PR comment (ProofShot-style bundle) and/or tracker `externalUrls`.
- The unattended/server variant (headless `recordVideo` → automated Linear `fileUpload`/`attachmentCreate`) is the P5 Extension's job (DOR-95); v1 attaches what an interactive/CLI run can produce + the WebM already wired in `apps/e2e`.

### 14. Packaging, templates & identity (§5.9)

`.agents/flow/` is the logical/canonical root that makes the system one identifiable unit, built **as a DorkOS marketplace `plugin`-type package** from P1 (Decision #24). v1 contributes `commands`/`skills`/`hooks`/`templates` — **no `extensions` layer** (that's P5). Honest layout (ground truth: the manifest syncs **skills only**; commands/hooks stay Claude-native):

```
.agents/flow/
  README.md   SPEC.md   config.json + config.schema.json   manifest.json
  skills/     ← stage skills (gerund) + adapters/linear/   → SYNCED to .claude/skills/ (symlink)
  templates/  ← records/ (by type) · docs/ · pr.md          → loaded by skills
.claude/commands/flow/   ← thin /flow + /flow:<stage> triggers   (Claude-native)
.claude/settings.json    ← the unified loop hook                 (Claude-native)
<repo>/WORKFLOW.md        ← optional per-repo override
.dork/tasks/flow-drain/SKILL.md   ← the autonomous Pulse schedule (project-scoped)
```

**Templates the system owns:** `templates/records/` (PM records by type, with `## Validation criteria` / `## On Completion`), `templates/docs/` (ideation/specification/`03-tasks.json`/ADR scaffolds, externalized from the `/ideate` command), `templates/pr.md` (linked issue · test/validation summary · browser-proof links).

## User Experience

- **Manual operator (Kai, CLI):** runs `/flow:specify`, `/flow:execute`, etc. for one stage at a time, or `/flow auto` to drain the ready queue from the terminal. Questions arrive interactively. Works with no DorkOS server.
- **PM-driven (Kai, away):** labels/assigns an issue `agent/ready` in Linear. The `flow-drain` Pulse schedule (server running) claims the top-ranked eligible issue each tick, carries it to the review gate in a fresh per-issue session, posts an evidence-bearing PR, assigns the issue back, and stops. A genuine question arrives as a ticket comment + `agent/needs-input` + optional Telegram nudge; answering it resumes the work. On approval (CI green) the agent auto-merges, closes, and tears down the worktree (the autonomous end-state; **in v1 this resume-on-approval is not built — it is the P2 server Extension.** v1 parks at the gate with no approval detection; the operator merges the approved PR and runs `/flow:done` to close + teardown).
- **Priya (flow-preservation):** queries/advances `/flow` from her editor without context-switching; the system's prose lives once on disk (specs/ADRs/research), the tracker holds only pointers + state, so there's nothing to reconcile by hand.

## Testing Strategy

- **Unit (Vitest, `__tests__/` alongside source):**
  - **Calibration ladder** (§5): table-driven cases over the 5 rows × {reversible/sticky}×{confident/not}×{intake/execution stage} → expected behavior (proceed-silent / proceed-with-trail / stop-ask). _Purpose: the single most important behavior — pin it._
  - **Dispatch ranking + eligibility** (§4): given a `WorkItem[]`, assert the ordered survivor list and that blocked/`other`-owned/WIP-capped items are filtered. _Edge cases: missing priority/size (neutral), blockedBy open item._
  - **`classifyOwnership`** (§7): two-account vs shared-account (detected) × {mine/reviewer/other/unassigned}. _Purpose: the claim/comment gate._
  - **Recovery ladder** (§12): each orphan-signal row → expected action; assert `needs-input` is never reclaimed; `attemptCount` increments; over-retry escalates.
  - **Auto-merge recovery ladder** (§6): mechanical vs functional conflict/CI/drift → resolve+announce vs bounce vs re-approve.
  - **Config schema** (§9): Zod parse of valid/invalid `config.json`; `z.toJSONSchema` round-trip; default resolution (`planApproval:false`, `subIssueThreshold:"xl"`, `perIssue:"fresh-session"`, `seat:"pulse"`).
  - **`03-tasks.json` schema extension** (§8): `issue`/`parentIssue` optional fields parse; promotion fires only at `size ≥ "xl"`.
  - **`adapters/linear/` verb contract:** mock Linear MCP/Composio; assert each verb maps to the right call and that generic skills never embed tracker strings (lint/grep guard).
- **Integration:**
  - **Pulse seat (§10):** drop a `flow-drain` `SKILL.md` into a temp `.dork/tasks/`; assert `TaskFileWatcher` syncs it to `pulseSchedules`, croner schedules it, and a fire dispatches one fresh session with the resolved worktree cwd. Use a `FakeAgentRuntime` so no real model runs. _Reuses the existing tasks test patterns._
  - **Stage→projection round-trip:** a stage transition writes the right `stage/*` label + state category through the adapter (mocked).
- **E2E (Playwright, `apps/e2e`):** the VERIFY stage produces a WebM for a touched UI surface and the bundle links onto a PR/tracker stub. _Confirms the proof pipeline end-to-end._
- **What NOT to test:** the real Linear API (mock the adapter); croner's own scheduling (trust the library); the un-tunable Claude Code auto-compact.

## Performance Considerations

- The orchestrator holds ~no context (croner is code); per-issue sessions are bounded by `context.stageBudgets` + the 0.65 compaction trigger, mitigating context rot on long drains.
- `maxConcurrentRuns` + `wipCap` bound concurrent agent cost; sequential WIP-1 is the v1 default.
- File-watcher (chokidar) and croner are existing, low-overhead server components; the `/flow` schedule adds one job.
- Per-issue worktrees add disk + a one-time `pnpm install` (reuses the pnpm store); `autoTeardown` reclaims them on close.

## Security Considerations

- **Permissions:** the Pulse task runs with `permissions: acceptEdits` by default (not `bypassPermissions`); the floor of the calibration ladder (row 0) always stops for secrets/spend/production/outward-facing actions even at full confidence.
- **Auto-merge** only fires on explicit human approval + CI green + the §6 preconditions; behavior-altering drift forces re-approval. Marketplace-install rollback caveats (ADR-0231) are not in scope here.
- **Identity:** no personal identity ships in the package (`agent: "auto"`, `reviewer: null`); the marker/labels are the durable authorship signal, resolved at runtime from the installer's account.
- **Tracker writes** are confined to the `adapters/linear/` skill (single audit surface); Composio uses the personal/DorkOS account, never the artblocks work account.

## Documentation

**Files to create:**

- `.agents/flow/README.md` (the manual: stages, modes, command↔state map, gates, adapter interface, **the autonomous-mode server dependency**).
- `.agents/flow/SPEC.md` (the contract: stage model, `PMClient` interface for P5, config schema).
- `contributing/flow-engine.md` (internal dev guide; cross-link from `contributing/INDEX.md`).
- `templates/` set (records/docs/pr.md).

**Files to update:**

- `AGENTS.md` — replace the separate Linear/Worktrees/loop guidance with a `/flow` section + the "Compact Instructions" block.
- `working-in-worktrees`, `executing-specs`, `ideating-features` skills — point at the unified stage model.
- `.agents/harness.manifest.json` — register the `flow` bundle.

## Implementation Phases

### Phase 0 — Scaffold (Linear reconciliation done — §3 of ideation)

Stand up `.agents/flow/` as a marketplace `plugin`-type package (README/SPEC/config/schema/manifest + `templates/`, embedding `.claude-plugin/plugin.json`; no `extensions` layer) and the harness-sync wiring (register the `flow` bundle: skills synced, commands Claude-native, hook in settings.json). The **Flow Engine — Harness** Linear project + umbrella issue **DOR-129** already exist.

- **Acceptance:** `.agents/flow/` loads as a plugin; `manifest.json` lists every member; `pnpm lint`/`typecheck` clean; the bundle's skills appear under `.claude/skills/` via symlink.

### Phase 1 — Extract & thin (no behavior change)

Legacy commands → `/flow` + `/flow:<stage>` thin triggers over gerund stage skills; define the `adapters/linear/` adapter skill (the v1 `PMClient`) and move all Linear logic into it; collapse the dual task system; add `issue`/`parentIssue` to `03-tasks.json` + the PM-agnostic provenance block.

- **Acceptance:** every `/flow:<stage>` command ≤ ~40 LOC; a grep guard finds **zero** `mcp__linear__*`/Composio strings outside `adapters/linear/`; the legacy commands are removed (hard rename, no aliases); existing manual flows still work; `03-tasks.json` round-trips the new fields.

### Phase 2 — Unify the loop

Generalize the `autonomous-check` Stop-hook concept into the canonical stage state; implement mode orthogonality, uncertainty-gated involvement + the calibration ladder + comms routing, and config-driven gates (incl. `planApproval:false`, auto-merge-on-approval + the §6 recovery ladder). Seat the autonomous loop on **Pulse**: ship the `flow-drain` `SKILL.md` template + the dispatch brief.

- **Acceptance:** `/flow auto` drains a ready queue sequentially in the terminal; a `flow-drain` Pulse schedule (server up) claims and advances one issue per tick in a fresh session; the calibration-ladder + recovery-ladder unit suites pass; gates are config-driven.

### Phase 3 — Agent-as-team-member v1

Service-account/`auto` identity + shared-account detection, inbox polling, comment/assign/handoff, soft-escalation, durable label claims, the `classifyOwnership` consumers.

- **Acceptance:** in a shared Linear, the agent claims only permitted classes, recognizes its own comments (marker), responds only when addressed, parks on `needs-input` and resumes on reply — verified against `classifyOwnership`/comment-rule suites + a live read-only dry run.

### Phase 4 — Proof-of-completion

VERIFY stage browser automation + evidence-class attachment (interactive GIF / wired WebM) onto PR + tracker.

- **Acceptance:** a UI change run through VERIFY yields a recording linked on the PR and the tracker per `evidence` config.

### Phase 5 — Later: the Flow Engine — Extension (DOR-88…)

Promote this proven harness into the single full-stack DorkOS extension (server `PMClient`, webhook/`dorkos.ai` relay + Linear Agent Accounts, server-side `WorkspaceManager`, unattended evidence pipeline, heartbeat/fencing concurrency). Tracked in Linear, **not built here**.

- **Acceptance:** out of scope for this spec; the v1 contracts (config schema, `PMClient` verbs, `FlowRun` record) are the promotion surface.

## Open Questions

All blocking questions resolved in ideation §6/§7 and this spec's clarification pass (poller seat → Pulse; plan-gate → off; sub-issue cut → ≥XL; context → fresh session per issue). Non-blocking items intentionally deferred to their implementation phase:

- **(P2, non-blocking) Dispatch pick locus.** Whether the per-tick issue _ranking_ runs inline in the dispatched session or as a small deterministic pre-step script. **Resolved direction:** inline in v1 (the session is fresh, so no accumulation); revisit if ranking grows. _No decision needed before P2._
- **(P4, non-blocking) Interactive evidence ceiling.** Exactly how much browser proof an interactive/CLI VERIFY run attaches vs. what waits for the P5 unattended pipeline (DOR-95). **Resolved direction:** v1 attaches the `apps/e2e` WebM + any `gif_creator` capture; richer headless automation is P5. _No decision needed before P4._

## Related ADRs

- **ADR-0043** — file-first write-through + reconciler (the pattern Pulse schedules and the `FlowRun` record follow).
- **ADR-0231** — marketplace-install transaction safety (context for the P5 server extension).
- **ADR-0262** — permission-prompt recovery via hybrid pull + SSE (precedent for durable, resumable session state).
- Draft ADRs auto-extracted from this spec's decisions (calibration ladder, the adapter seam, the Pulse seat / Decision #12 revision, ID-only provenance, the ≥XL sub-issue cut) will be written on `/ideate-to-spec` completion; run `/adr:curate` to promote the significant ones.

## References

- Ideation: [`01-ideation.md`](./01-ideation.md) — 27 decisions (§6) + the resolved open questions (§7).
- Linear: **Flow Engine — Harness** project + umbrella **DOR-129**; **Flow Engine — Extension** (DOR-88/89/90/95/102, P5); **Workspaces** (DOR-84 WorkspaceManager).
- Research: workspace strategy / Symphony · crash & stall recovery · Linear agent accounts · work sequencing · browser video recording (linked in the header).
- Memory anchors: `project_flow_workflow_engine`, `project_dual_harness_skills`, `reference_conf_and_config`, `reference_linear_composio_access_dorkos`.
