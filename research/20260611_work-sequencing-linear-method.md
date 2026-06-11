# Work Sequencing: Linear Method Conventions + Dispatch Policy for /pm and the Orchestration Extension

**Date:** 2026-06-11
**Context:** Follow-up to `research/20260611_workspace_strategy_runtimes_symphony.md`. That report covered workspace isolation; this one covers _what to work on next_ — how the linear-loop (`/pm`) and the planned Symphony-style orchestration extension should sequence work, and the Linear conventions humans must follow to make that possible.
**Linear:** Workspaces project, Orchestration Extension project, DOR-89 (delta analysis — updated with the deltas below).

---

## 1. What the two systems actually do today

### 1.1 Sequencing

| Concern              | linear-loop (`/pm`)                                                                                                                                                           | Symphony (SPEC.md)                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invocation           | Episodic — runs when invoked                                                                                                                                                  | Continuous — poll tick every `polling.interval_ms` (default 30s)                                                                                                                                       |
| Project scope        | Team-wide, dynamic discovery, ownership filter                                                                                                                                | **One Linear project per workflow config** — `tracker.project_slug` is REQUIRED (§5.3.1); candidate query filters `project: { slugId: { eq } }`. No team awareness. Project-less issues are invisible. |
| Issue ordering       | Nine-tier judgment ladder (needs-input → interrupted specs → monitors → triage → ready → unplanned hypotheses → stale → falsely-complete → empty); within tiers, LLM judgment | Deterministic sort: native `priority` ascending (null last) → `created_at` oldest first → `identifier` (§8.2)                                                                                          |
| Issue dependencies   | Convention: blocker-verification rule + On Completion routing                                                                                                                 | Mechanical: `blocked_by` refs; a `Todo` issue never dispatches while any blocker is non-terminal                                                                                                       |
| Project dependencies | None                                                                                                                                                                          | None (cannot — single-project scope)                                                                                                                                                                   |
| Due dates            | Not read anywhere                                                                                                                                                             | Not read (the SPEC's `due_at_ms` is retry-timer bookkeeping)                                                                                                                                           |
| Estimates            | Not read anywhere                                                                                                                                                             | Not in the issue model                                                                                                                                                                                 |
| Concurrency          | n/a (one action at a time; `auto` chains up to 5)                                                                                                                             | Global cap + per-state caps (§8.3)                                                                                                                                                                     |

### 1.2 Claiming — how each system knows something is being worked on

**Symphony** keeps claims **in-memory only** (`claimed` set + `running` map, §7.1) — explicitly "not the same as tracker states." Routing is by **configured assignee**: humans assign issues to the agent's Linear user, Symphony filters on that. Symphony itself never writes to the tracker; state transitions, comments, and PR links are delegated to the coding agent inside the session via the WORKFLOW.md prompt. The SPEC acknowledges this as a weakness (TODO at L2114: "Add first-class tracker write APIs … in the orchestrator instead"). Restart loses claims; recovery is by reconciliation (tracker state refresh every tick + startup sweep).

**linear-loop** claims **durably in the tracker**: `/pm` writes the `agent/claimed` label and moves the issue Todo → In Progress at dispatch. The assignee field is deliberately reserved as a **human-notification channel** (`needs-input` assigns the issue to the human; the ownership filter targets unassigned issues/projects).

These models conflict on assignee semantics and claim durability. §5 below resolves them.

## 2. Industry findings (full agent report in session 519830d3)

- **Little's Law** (`cycle time = WIP / throughput`) makes WIP reduction the only lever for faster delivery at constant throughput. SAFe portfolio data: cutting active epics 10 → 6 cut cycle time 40% at identical throughput.
- **The Linear Method** (linear.app/method): projects are time-bound deliverables, **1–3 people / 1–3 weeks**, with an owner, a brief, and a target date. Issues without a project are valid (maintenance, small fixes). Priority is _relative ordering_, not scheduling. **Due dates are a code smell as a planning tool** — reserve for genuinely fixed external dates. Mix feature and quality work each cycle. Aggressively archive stale backlog items (30+ days untouched).
- **Reinertsen / WSJF**: optimal sequencing is Cost of Delay ÷ Duration. Within a priority tier CoD is ~equal, so **shortest-job-first within a tier is the provably optimal special case** — without the false precision of full cross-tier WSJF ratios.
- **Shape Up**: bet on 1 big or 2–3 small projects per cycle, exclusively; the **circuit breaker** (no automatic extensions) is the enforcement mechanism.
- **Kanban classes of service**: Expedite (violates WIP limits, one at a time), Fixed-date (schedule by working back from the deadline using P85 cycle time), Standard, Intangible.
- **Prior art gap**: no public agent orchestrator (Codex, Devin, Cursor background agents, Symphony) implements project-aware sequencing or project-level WIP. All flatten to "a filtered issue list." This is open design space — and the coordination layer is literally DorkOS's thesis.

### Why don't orchestrators handle multiple projects?

A Linear team holding multiple projects is **not** unconventional — it is exactly Linear's intended model (team owns issues; projects group deliverables; the Linear Method treats the project as the unit of meaningful work). Orchestrators flatten it anyway because: (a) they are **repo-centric** — one config pins one repo and one issue queue, and "project" doesn't map cleanly across trackers (GitHub/Jira/Linear all differ), so v1 products ship the lowest common denominator; (b) cross-project sequencing requires an **opinionated prioritization policy**, which vendors avoid baking in — their model is "human decides, agent executes"; (c) the category is ~18 months old and effort went to workspace isolation and reconciliation first.

## 3. Determinations

### 3.1 Sizing — adopt estimates; use as tiebreaker, not divisor

**Adopt Linear's native estimate field** (Fibonacci scale) on the DorkOS team, with agent-centric semantics:

| Estimate | Meaning                                            |
| -------- | -------------------------------------------------- |
| 1        | Single focused agent session                       |
| 2        | A couple of sessions                               |
| 3        | Multi-session; consider sub-issues                 |
| 5        | Decompose into sub-issues, or promote to a project |
| 8        | This is a project, not an issue                    |

**Use size in sequencing as a same-priority tiebreaker only**: priority first, then **smallest estimate first within the same priority tier**, then oldest first. Rationale:

- Within a tier, CoD is approximately equal, so shortest-first is Reinertsen's optimal special case — principled, not a compromise.
- Full WSJF (`priority ÷ estimate` as the primary key) was **rejected**: ordinal priorities divided by rough Fibonacci estimates produce false precision; a High/8 issue would starve behind High/1 issues forever; and agent wall-clock is cheap and parallel — the scarce resources are review bandwidth and risk, which size only loosely proxies.
- Size has two other jobs: a **decomposition trigger at creation** (estimate ≥ 5 → split) and the **circuit-breaker budget** (in-progress longer than ~2× estimate → stop autonomous dispatch, escalate to human).

### 3.2 Orphan issues and single-issue projects

Policy, derived from "projects are committed, time-bound deliverables":

1. **Pre-commitment issues (`type/idea`, exploratory `type/research`) may live project-less.** Projects are created at the commitment moment (hypothesis accepted / betting table), not at capture. A project-less idea in Backlog is healthy.
2. **Committed executable work (`type/task`, anything `agent/ready`) must have a home**: a thematic project it advances, or the persistent **Maintenance** project.
3. **Never create a single-issue project.** If the work genuinely deserves a project, planning will decompose it into multiple issues; if it can't be decomposed, it's an issue. (The three empty Backlog projects found in our workspace — Immer benchmark, Obsidian DirectTransport verification, TanStack Pacer — were exactly this anti-pattern: issue-sized work created as projects, which then sat with zero issues for months.)
4. **Maintenance is a persistent project that never completes.** It holds small standalone committed work (bugs not tied to a theme, small UX improvements, dependency updates). It exists for two reasons: capacity allocation (a ~20% lane that is worked steadily but never ahead of committed projects), and **dispatcher visibility** — under Symphony-style project-scoped dispatch, a project-less issue can never be dispatched at all.

### 3.3 Dispatch policy (the missing `dispatch-priority.md` template)

Codified in `.claude/skills/linear-loop/templates/dispatch-priority.md` (written alongside this report) as ordered decision rules — the human-readable spec for `/pm` **and** the implementation spec for the extension's sort:

1. **Expedite**: an Urgent (P1) issue preempts everything; one expedite at a time; ignores WIP caps.
2. **Due-date slack**: `due_date − today − typical cycle time ≤ 0` → treat as expedite. Due dates allowed only for genuinely fixed external dates.
3. **Project WIP cap (2)**: at the cap, pull only from in-progress projects — the one **closest to completion** first.
4. **Below the cap**: open the highest-priority not-started project; no cherry-picking issues from uncommitted projects.
5. **Within a project**: priority → smallest estimate → oldest.
6. **Blockers**: skip issues with non-terminal blockers (Linear relations only, never prose); escalate blocks older than 24h.
7. **Maintenance lane**: ~20% of capacity, after committed projects are served.
8. **Aging anti-starvation**: unstarted issue older than ~2× its tier's expectation gets promoted one tier.
9. **Circuit breaker**: project in progress > 2× appetite → stop autonomous dispatch, escalate.

## 4. Alignment plan: one set of conventions, two consumers

| Decision      | Convention                                                                                                                            | linear-loop                                   | Extension                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Urgency       | **Native priority field** (Urgent/High/Medium/Low), set on all actionable issues; ideas may stay unprioritized (sorts last — correct) | `/pm` reads it in ASSESS; intake sets it      | Primary sort key (matches Symphony §8.2)                                                                                                                                                                                  |
| Size          | **Native estimate field** (Fibonacci, semantics above), set at creation/triage                                                        | Intake + triage set it; decomposition trigger | Same-priority tiebreaker; circuit-breaker budget                                                                                                                                                                          |
| Dependencies  | **Linear blocking relations only** — never prose                                                                                      | Blocker-verification rule becomes mechanical  | `blocked_by` gate (Symphony Todo rule)                                                                                                                                                                                    |
| Dispatch gate | **`agent/ready` label**                                                                                                               | Existing convention                           | Maps to Symphony `required_labels`                                                                                                                                                                                        |
| Claiming      | **Durable tracker writes**: `agent/claimed` + Todo → In Progress at dispatch                                                          | Existing convention                           | Extension adopts it (fixes Symphony's L2114 TODO); makes `/pm` and the orchestrator mutually visible — neither double-dispatches the other's work. Startup sweep clears stale claims (claimed label + no running worker). |
| Assignee      | **Human-notification channel only** (`needs-input`)                                                                                   | Existing convention                           | Route by labels, NOT by assignee (deviation from Symphony §8.2 routing)                                                                                                                                                   |
| Project scope | Projects = 1–3 week committed deliverables with brief, target date, project priority                                                  | Project conventions in SKILL.md               | **Team-scoped fetch, project-aware sequencing** (the headline delta vs Symphony's `project_slug` scoping)                                                                                                                 |
| Workspaces    | Per-issue keying (sanitized identifier / Linear `branch_name`), reuse across attempts, cleanup on terminal state + startup sweep      | n/a                                           | WorkspaceManager binding (DOR-84)                                                                                                                                                                                         |

## 5. Changes made with this report

- `.claude/skills/linear-loop/SKILL.md` — Linear Method conventions: native priority, estimates + sizing semantics, blocking relations, project conventions (1–3 weeks, brief, target date, project priority), orphan/Maintenance policy, claim/assignee contract.
- `.claude/skills/linear-loop/templates/dispatch-priority.md` — new; the policy in §3.3.
- `.claude/skills/linear-loop/templates/triage-intake.md` — intake now sets priority, estimate, and project placement.
- `.claude/commands/pm.md` — ASSESS reads priority/estimate/due dates; dispatch step routes through the template.
- Linear workspace cleanup: Maintenance project created; orphans homed (DOR-80, DOR-78 → Chat Session Reliability; DOR-72 → Maintenance); three empty projects converted to issues and cancelled; priorities set on ready work (DOR-84, DOR-89, DOR-88); estimates enabled (Fibonacci).
- DOR-89 updated with the extension deltas (team-scoped dispatch, classes of service, size-as-tiebreaker, durable claims, label routing).

## 6. Open questions

- Should the extension's project WIP cap be config (`~/.dork/config.json`) or per-repo policy (WORKFLOW.md-equivalent, DOR-90)? Leaning per-repo policy with a config default.
- Cycle adoption: the Linear Method leans on cycles for cadence; the loop currently has none. Revisit once the orchestrator produces enough throughput for a cadence to matter.
- P85 cycle-time data for due-date slack math doesn't exist yet — the extension should compute it from issue history once it has been running.
