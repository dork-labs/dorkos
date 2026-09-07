---
name: auditing-ui
description: Runs a lens-based UI/UX audit of the client and turns its findings into tracked, fenced work items. Use when auditing the interface for quality gaps, running or scoping an audit (full, one lens, one surface, or a diff), driving the real-browser leg of an audit, synthesizing raw lens findings into batches, or deciding how audit findings enter the tracker.
---

# Auditing UI

An audit reads the interface through several independent lenses at once, then merges what they
saw into one ranked report and a set of PR-sized batches. It writes **zero code**.

The rules live in the charter, not here: `audits/ui.md` (domain) inherits `audits/README.md`
(cross-domain). This skill is the **procedure**: how to scope a run, how to fan out auditors,
how to drive the browser leg safely, how to synthesize, and how findings become work items
without colliding with the repo's own workflow engine.

Read the charter before every run. If `audits/ui.md` is missing, run `/ui-audit:init` first.

## 1. Scope the run

| Mode              | What runs                                                      | When                                  |
| ----------------- | -------------------------------------------------------------- | ------------------------------------- |
| `full`            | all twelve lenses over the whole client                        | rare, expensive, a programme kickoff  |
| `lens:<name>`     | one lens, whole tree                                           | validating a lens, or a rotation slot |
| `surface:<route>` | surface-local lenses over one route and its component tree     | after building or reworking a surface |
| `diff`            | surface-local lenses over what changed since each lens's stamp | the recurring pulse                   |

**`diff` covers surface-local lenses only.** Whole-tree lenses (duplication, placement, API
consistency, componentization, playground coverage) are properties of the whole tree; scoping
them to a diff produces confident nonsense. They are reached through **rotation** instead: one
whole-tree lens per pulse, cycling through all of them. The charter's "Lens classes" section is
the authority on which lens is which.

**Cost.** A `full` run is roughly ten million subagent tokens. Print an estimate and get explicit
consent before spawning. Scoped runs are one to two orders of magnitude cheaper, and a
`lens:tokens` run is the cheapest honest validation of a changed charter.

## 2. Fan out the auditors

One auditor per lens. Each auditor reads the charter itself (not a paraphrase of it), gets its
lens brief, and writes its **raw findings file** to the run log before returning a structured
summary. Raw files are the evidence the synthesizer works from; a summary alone is not enough.

- **Parallel** — spawn N agents, however your harness spawns agents, one per lens. This is the
  fast path and the one the report's turnaround assumes.
- **Sequential** — run the lenses one at a time in the same session, appending each raw file as
  it completes. This is a **first-class path**, not a degraded one: a single machine adopting
  this should start here, and a sequential run produces exactly the same report.

Either way the auditors are read-only. They must not modify a source file, and they must not
work inside a checkout another agent is writing to.

The prompt template is `assets/auditor-prompt.md`. Fill its placeholders; do not rewrite its
rules section, which restates the charter's binding constraints.

## 3. The browser leg

Code reading finds most of what a lens looks for. It does not find clipped layouts, strings that
escape their container, console errors on load, or motion that reads wrong. Those need a running
app, driven at desktop and phone widths.

**Look, don't touch. These rules are binding:**

- **Your own ports only.** Boot your own client on a port you chose, and never touch a server or
  client another agent or the operator is running. Stop only the process you started, by the PID
  you hold or by `lsof -ti :<your port>`. Never `pkill` or `killall` (repo Hard Rule 7).
- **A standalone Playwright script, never a shared MCP browser.** A shared browser is a single
  contended resource; parallel auditors driving it interleave and produce garbage. Write a small
  node script that navigates, resizes, screenshots to the session scratchpad, and exits, then
  **read the screenshots**. Playwright is importable from `apps/e2e/node_modules`.
- **No mutating clicks.** The API behind your client may be the operator's real server with real
  data. Navigate, resize, hover, screenshot, read the console. Do not click anything that
  creates, renames, deletes, sends, or archives.
- **Degrade explicitly.** When no app is runnable (no free port, no build, a broken dev server),
  say so in the report and audit code-only. Never let the browser leg silently vanish, leaving a
  reader who assumes it ran. A dropped browser leg is a stated coverage gap, listed with the
  other gaps.
- **Widths.** Desktop and phone at minimum (1440x900 and 390x844 are the sizes this repo's
  findings were confirmed at). Tablet where the surface has a distinct layout there.

## 4. Synthesize

The synthesizer reads the charter and every raw file, then produces one report that stands alone
for a reader who never opens the raw files. Template: `assets/synthesizer-prompt.md`.

1. **Dedup.** The same underlying defect seen by several lenses becomes one finding. Keep the
   best evidence and note which lenses saw it.
2. **Spot-verify citations.** Open the cited files for a meaningful sample (at least fifteen on a
   full run, or all of them on a small one). A citation that does not hold kills or narrows the
   finding. Record what was verified; the count is part of the report's credibility.
3. **Drop the invalid.** Findings with no citation, findings relitigating a settled ADR, and
   recommendations that fight the design language go. Record every drop with its reason: a
   dropped finding sometimes carries a real observation that deserves re-filing with a proper
   trace, and the record is how that happens.
4. **Batch by collision class.** Group survivors into PR-sized batches, three to fifteen
   findings each, grouped so that two batches worked in parallel touch disjoint files. Same
   slice or same theme is the usual proxy. Give each batch the priority of its worst finding
   and an effort mix. Batches that must follow another (copy stragglers after the copy sweeps,
   file moves last) get that dependency stated.
5. **Be honest in the summary.** Say what is good as well as what is wrong, and state plainly
   how many findings ask for deletion versus addition. Simplify-first is measurable.

## 5. The ownership contract

Audit findings enter the tracker **fenced**, so the repo's workflow engine cannot pick them up
before a human decides where they belong. This contract is normative; do not improvise around it.

- Every `/ui-audit:run` and `/ui-audit:pulse` emission creates one per-run **`type/meta` item,
  "promotion decision for audit run `<date>`"**, and every emitted finding-batch item carries a
  **`blockedBy` edge to it**. A `source/audit` label rides along as **provenance only**, and is
  explicitly not a fence.
- **Never write `agent/*` labels.** Those are the workflow engine's claim labels; borrowing them
  makes its own loops treat audit items as orphaned work to re-adopt, which inverts the fence.
  In-progress visibility uses the plugin-namespace label **`audit/claimed`** instead.
- The fence is triple, and needs zero modification to the workflow engine: (1) an open blocker
  mechanically fails its readiness condition, so triage and groom cannot honestly arm the item;
  (2) the meta item hits groom's own "meta, never ready" rubric; (3) the dispatch engine
  independently drops open-blocker items even if one were mis-armed.
- **Promotion is resolving the blocker, and that is the fork.** Chosen per batch by the operator,
  or by the configured default:
  - **workflow path** — remove the edge; the item enters the normal lifecycle; the audit never
    touches it again.
  - **audit path** — `/ui-audit:execute` works items **still blocked** (the fence stays up
    against the workflow engine the whole time) and closes them on merge.
- **No tracker configured?** The ledger is markdown: `audits/runs/ui/<date>/backlog.md`. No
  contention exists, so no fence is needed; the ledger is the tracker of record.
- **Residual risk, disclosed.** Groom _could_ propose closing the promotion-decision meta item as
  junk. Closures are the one class that always passes groom's itemized human gate with evidence,
  so the operator catches it there.
- **The meta item has an end of life.** Close it once every batch in its run is promoted or
  closed. Otherwise it becomes exactly the stale ledger groom sweeps at.

## 6. The run log

One directory per run: `audits/runs/ui/<date>/`. Lean markdown only; screenshots and video stay
in the session scratchpad and are referenced by description (`audits/README.md`).

```
audits/runs/ui/2026-09-20/
├── report.md      # the synthesized findings + batches
├── raw/<lens>.md  # one file per auditor
├── stamps.json    # per-lens last-audited commit + the rotation cursor
└── backlog.md     # only when no tracker is configured
```

`stamps.json` is the pulse's memory, and it is **per lens**, never one global stamp:

```json
{
  "lenses": {
    "copy": { "lastAuditedCommit": "a1b2c3d", "lastRun": "2026-09-20" },
    "responsive": { "lastAuditedCommit": "9f8e7d6", "lastRun": "2026-09-13" }
  },
  "rotation": {
    "order": ["cva", "dry", "organization", "dx", "playground", "componentize"],
    "next": "dry"
  }
}
```

A lens skipped this run keeps its old stamp, so the next run that includes it still sees
everything since **that lens** last looked. Write the new stamps only for lenses that actually
ran, and only after their findings are recorded.

## 7. Landing the work

Executing a batch is parallel-batch work like any other: worktree per batch, implementer,
adversarial review on the branch **before** the PR opens, then finalize. That playbook is not
duplicated here. Read `.claude/skills/orchestrating-parallel-work/SKILL.md` for the wave,
collision, rebase, arm-and-verify, and close-out mechanics, and `REVIEW.md` for the reviewer
rubric and its failure-mode library. `assets/review-brief.md` is the brief template that points
a reviewer at both.

## Assets

- `assets/auditor-prompt.md` — the per-lens auditor prompt.
- `assets/synthesizer-prompt.md` — the synthesis prompt.
- `assets/review-brief.md` — the adversarial-review brief for an execute batch.
- `assets/reference-implementation/` — two **non-normative** orchestration scripts from the
  September 2026 run, kept as known-good examples for one specific session orchestrator. The
  prose above is what is normative; the scripts are color. See that directory's README.
