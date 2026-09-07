---
name: auditing-ui
description: Runs a lens-based UI/UX audit of the client and turns its findings into tracked, fenced work items. Use when auditing the interface for quality gaps, running or scoping an audit (full, one lens, one surface, or a diff), driving the real-browser leg of an audit, synthesizing raw lens findings into batches, or deciding how audit findings enter the tracker.
---

# Auditing UI

An audit reads the interface through several independent lenses at once, then merges what they
saw into one ranked report and a set of PR-sized batches. It writes **zero code**.

The rules live in the charter, not here: `audits/ui.md` (domain) inherits `audits/README.md`
(cross-domain). **The charter is the authority on the lens set, the lens keys, and which lens is
surface-local versus whole-tree.** This file is the **procedure**, and it is the single home for
the procedure: the commands under `/ui-audit:*` point here rather than restating any of it.

Read the charter before every run. If `audits/ui.md` is missing, run `/ui-audit:init` first.

## 1. Durable state

Three things outlive any single run and live at the domain root, `audits/runs/ui/`:

| Path          | What                                                                 | Written by        |
| ------------- | -------------------------------------------------------------------- | ----------------- |
| `profile.md`  | how work lands in **this** repo                                      | `/ui-audit:init`  |
| `stamps.json` | per-lens last-audited commit + rotation cursor                       | `run` and `pulse` |
| `<date>/`     | one run's `report.md`, `raw/<key>.md`, and its ledger when untracked | `run` and `pulse` |

`<date>` is ISO `YYYY-MM-DD`.

### The repo profile is consulted, not decorative

Read `audits/runs/ui/profile.md` at the start of every `run`, `pulse`, and `execute`. It answers
questions this procedure deliberately does not hard-code, and each answer changes behavior:

- **Landing style** — a repo with no merge queue must not inherit arm-then-verify or a bare
  `gh pr merge --auto`; `execute` follows the profile's answer, not this repo's habits.
- **Changelog** — whether a batch owes a fragment, and in what shape.
- **Isolation** — worktree per batch, or something else.
- **Formatting gate** — the exact command that satisfies CI, run last before every push.
- **Tracker mode** — the adapter path in §5, or the markdown ledger.
- **Browser leg** — the dev command and a free port, or the fact that there is none, which is
  what §3's degrade rule keys off.

A missing profile is not a reason to guess. Say it is missing, name `/ui-audit:init`, and fall
back to the most conservative reading (no queue, no fragment, no browser leg) — **but only for a
run that never intended real tracker emission** (dry or validation). A run that does intend real
emission captures the profile then, per `/ui-audit:init` contract 3, rather than silently
downgrading to the markdown ledger: the conservative fallback is for runs that were never going to
emit, not a quiet substitute for one that was.

### Stamps, and the first run

```json
{
  "lenses": {
    "copy": { "lastAuditedCommit": "a1b2c3d", "lastRun": "2026-09-20" },
    "responsive": { "lastAuditedCommit": "9f8e7d6", "lastRun": "2026-09-13" }
  },
  "rotation": { "cursor": "dry" }
}
```

Stamps are **per lens**, never one global stamp: a lens skipped for six weeks still sees six
weeks of change when it next runs. A whole-tree lens's `lastAuditedCommit` records recency only —
when it last ran — and is never used as a diff base, since whole-tree lenses cannot be
diff-scoped (§2). The rotation cursor names the next whole-tree lens due, in the charter's Lens
classes order. Write a lens's stamp only when that lens actually ran, and only
after its findings are recorded; a lens that did not run keeps its old entry untouched. Creating
`stamps.json` for the first time sets `rotation.cursor` to the **first** whole-tree lens in that
order (`cva`), since nothing has run yet and the first one is therefore the one due.

**Bootstrap rule: a lens with no stamp has no diff base, and the audit refuses to invent one.**
`diff` scoping and `/ui-audit:pulse` require an existing `stamps.json`. With no stamps file, or
for a lens missing from it, they **stop and say so**, naming the fix: run `full` (or a scoped run
covering those lenses) to establish the baseline. The alternative — silently widening to the
whole tree — turns a cheap pulse into a ten-million-token run nobody consented to, which §2's
cost gate exists to prevent. `run` therefore takes an **explicit scope** and has no default.

## 2. Scope the run

| Mode              | What runs                                                      | When                                  |
| ----------------- | -------------------------------------------------------------- | ------------------------------------- |
| `full`            | all twelve lenses over the whole client                        | rare, expensive, a programme kickoff  |
| `lens:<key>`      | one lens, whole tree                                           | validating a lens, or a rotation slot |
| `surface:<route>` | surface-local lenses over one route and its component tree     | after building or reworking a surface |
| `diff`            | surface-local lenses over what changed since each lens's stamp | the recurring pulse                   |

Lens keys come from the charter's lens list, which is their only authority.

**`diff` covers surface-local lenses only.** Whole-tree lenses are properties of the whole tree;
scoping them to a diff produces confident nonsense. They are reached through **rotation**
instead: one whole-tree lens per pulse, cycling in the charter's order.

**Coverage, which is the real budget.** Tokens are what a run costs the operator; they are not a
stop condition an auditor can meter. Give every auditor a **coverage** budget instead: read its
lens's source of truth in full (the token and theme files for `tokens`, the shared primitive
directory for `cva` and `dx`, the playground registry for `playground`), then run one scripted
sweep per violation class and open the hits. Stop when the sweeps are exhausted, and state in the
coverage note where you stopped and what you did not reach. Never hand an agent a clock.

**Cost.** Budget roughly 0.5M to 1M subagent tokens per lens, more for the ones that read the
whole shared layer. The twelve-lens run that produced the September 2026 report came to roughly
ten million. Print an estimate before spawning, and on `full` get explicit consent first.

**A scoped run is not a small full run.** On `lens:<key>` and `surface:<route>`, the whole-tree
scope stands but the reporting rules relax: collision class beats batch size (§4), a single-lens
run synthesizes inline (§4), and the report says plainly which lenses did **not** run, so nobody
reads a one-lens report as a verdict on the interface.

## 3. Fan out the auditors

One auditor per lens. Each auditor reads the charter itself (not a paraphrase of it), gets its
lens brief, and writes its **raw findings file** to `audits/runs/ui/<date>/raw/<key>.md` before
returning a structured summary. Raw files are the evidence the synthesizer works from; a summary
alone is not enough.

- **Parallel** — spawn N agents, however your harness spawns agents, one per lens. This is the
  fast path and the one the report's turnaround assumes.
- **Sequential** — run the lenses one at a time in the same session, appending each raw file as
  it completes. This is a **first-class path**, not a degraded one: a single machine adopting
  this should start here, and a sequential run produces exactly the same report.

Either way the auditors are read-only: they must not modify a source file, and must not work
inside a checkout another agent is writing to.

The prompt template is `assets/auditor-prompt.md`. Fill its placeholders; do not rewrite its
rules section, which restates the charter's binding constraints.

### The browser leg

Code reading finds most of what a lens looks for. It does not find clipped layouts, strings that
escape their container, console errors on load, or motion that reads wrong. Those need a running
app, driven at desktop and phone widths.

**Which lenses get one, and when.** Five lenses have findings a browser can confirm or upgrade:
`responsive`, `states`, `motion`, `clutter`, and `tokens` (for theme drift and anything the
cascade decides at render time). The command fills the auditor prompt's `{{#BROWSER_LEG}}` block
for exactly those, on every scope, **whenever the profile supplies a dev command and a free
port** — and for no other lens, since the rest read structure a browser cannot adjudicate. The leg
may be skipped even then when nothing in scope is browser-adjudicable, provided the report says
so. No dev command in the profile means the degrade rule below applies to all five. **No profile at all is
different**: when the scope includes one of these five lenses, capture the profile now (or ask)
rather than silently skipping the browser leg — the same rule as §1's emission case, because a
dropped browser leg here is exactly the kind of thing a missing profile must not quietly cause.
This is the predicate; nothing else decides it.

**Look, don't touch. These rules are binding, and this is the only place they are written:**

- **Your own port, and only your own.** Boot your own client on a port you chose and hold. On
  this machine `:6242` is the operator's server and `:6241` the orchestrator's client: both are
  someone else's, always. Stop only the process you started, by the PID you hold or by
  `lsof -ti :<your port>`. Never `pkill` or `killall` (AGENTS.md Hard Rule 7).
- **A standalone Playwright script, never a shared MCP browser.** A shared browser is a single
  contended resource; parallel auditors driving it interleave and produce garbage. Write a small
  node script that navigates, resizes, screenshots to the session scratchpad, and exits, then
  **read the screenshots**. The installed package is **`@playwright/test`**, resolvable from
  `apps/e2e` (bare `playwright` is not installed and will not resolve).
- **No mutating clicks.** The API behind your client may be the operator's real server with real
  data. Navigate, resize, hover, screenshot, read the console. Do not click anything that
  creates, renames, deletes, sends, or archives.
- **Degrade explicitly.** When no app is runnable (no free port, no build, a broken dev server,
  or a profile that says there is none), say so in the report and audit code-only. Never let the
  browser leg silently vanish, leaving a reader who assumes it ran. A dropped browser leg is a
  stated coverage gap, listed with the others.
- **Widths.** Desktop and phone at minimum (1440x900 and 390x844 are where this repo's findings
  were confirmed). Tablet where the surface has a distinct layout there.

**Cold worktree + browser-leg.** Two things the September 2026 run learned the hard way, recorded
so the next browser leg does not re-learn them. A cold worktree does not boot the client on
`@dorkos/shared` alone — `@dorkos/marketplace`, `@dorkos/skills`, `@dorkos/extension-api`, and
`@dorkos/icons` dists are needed too; build all of them before booting. And a client on a foreign
port talking to the operator's real server sees CORS reject it: API-backed content comes back
sparse and a failure toast sits on every page, which starves the `states`, `clutter`, and
`responsive` lenses of populated surfaces at render time. Prefer the profile's own dev-server pair
(client + server booted together on ports the profile names) over pointing a standalone client at
someone else's server.

## 4. Synthesize

The synthesizer reads the charter and every raw file, then produces one report that stands alone
for a reader who never opens the raw files. Template: `assets/synthesizer-prompt.md`.

**Spawn a synthesizer only when two or more raw files exist.** On a single-lens run step 1 is
vacuous and the runner synthesizes **inline** — read the raw file, verify its citations, write
the report — which is cheaper and identical in output.

1. **Dedup.** The same underlying defect seen by several lenses becomes one finding. Keep the
   best evidence and note which lenses saw it.
2. **Spot-verify citations.** Open the cited files: **all of them at or below twenty findings, at
   least fifteen above that.** A citation that does not hold kills or narrows the finding. Record
   what was verified; the count is part of the report's credibility.
3. **Drop the invalid.** Findings with no citation, findings relitigating a settled ADR, and
   recommendations that fight the design language go. Record every drop with its reason: a
   dropped finding sometimes carries a real observation that deserves re-filing with a proper
   trace, and the record is how that happens.
4. **Batch by collision class.** Group survivors into PR-sized batches, grouped so that two
   batches worked in parallel touch disjoint files. Same slice or same theme is the usual proxy.
   Three to fifteen findings per batch **on a full run**; on a scoped run collision class wins
   over batch size, and a one-finding batch is a legitimate result — never merge classes that
   genuinely collide just to reach a floor. Give each batch the priority of its worst finding and
   an effort mix. Batches that must follow another (copy stragglers after the copy sweeps, file
   moves last) get that dependency stated.
5. **Be honest in the summary.** Say what is good as well as what is wrong, and state plainly how
   many findings ask for deletion versus addition. Simplify-first is measurable.

## 5. The ownership contract

Audit findings enter the tracker **fenced**, so the repo's workflow engine cannot pick them up
before a human decides where they belong. This contract is normative and lives only here; the
commands point at it rather than restating it.

- Every `/ui-audit:run` and `/ui-audit:pulse` emission creates one per-run **`type/meta` item,
  "promotion decision for audit run `<date>`"**, and every emitted finding-batch item carries a
  **`blockedBy` edge to it**. A `source/audit` label rides along as **provenance only**, and is
  explicitly not a fence. A run that emits no new batches — everything found was a dedup refresh
  of an already-filed item — emits nothing and creates no meta item.
- **Never write `agent/*` labels.** Those are the workflow engine's durable claim labels;
  borrowing them makes its own loops treat audit items as orphaned work to re-adopt, which
  inverts the fence. In-progress visibility uses the plugin-namespace label
  **`ui-audit/in-progress`** (not `audit/claimed`: Linear enforces team-wide label-name
  uniqueness, and `claimed` already exists as `agent/claimed`).
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

### How to actually write it

**All tracker I/O routes through the `/flow` plugin's `linear-adapter` skill** (AGENTS.md, and
the adapter's own rule that no other skill may touch a tracker string). Load it and use its verbs;
do not hand-roll a tracker call from here. Four things it settles, and three traps it documents:

- **The relation verb is `link(a, b, type)` with type `blocks`, and direction matters.** The
  fence is `link(metaItem, batchItem, 'blocks')` — the meta item **blocks** the batch item, which
  is what gives the batch item the open `blockedBy` the readiness check reads. Reversed, the
  fence is not merely absent, it is backwards, and the meta item becomes the blocked one.
- **Create the labels first.** `source/audit`, `ui-audit/in-progress`, and the `type/meta` value
  must exist in the tracker before an emission references them.
- **Team and project** come from the profile, not from this file.
- **Labels read back flattened to leaf names.** A grouped label arrives as `meta`, not `type/meta`,
  and as `claimed`, not `agent/claimed`. Match on the leaf when reading; never conclude from a
  bare `claimed` that a label is in your namespace.
- **A label write REPLACES the entire label set.** Compute the union against a **fresh read taken
  immediately before the write**. A union computed from an earlier snapshot silently deletes
  labels a concurrent session added in between, which on this repo has happened live.
- **`LINEAR_RUN_QUERY_OR_MUTATION` takes `query_or_mutation`, not `query`.** Passing `query` fails
  validation; this is the adapter's own verified-schema trap, not something to rediscover here.

## 6. Keeping the charter current

The charter accretes; nothing rewrites it wholesale, and `/ui-audit:init` will not overwrite an
existing one. When the operator states a new durable directive, record it the same turn:

1. Add it to the charter's **Standing directives** with its date and the operator's own framing.
2. Sharpen the lens or lenses it binds in the same edit, so an auditor reading only its lens
   still sees it.
3. If it is true of every domain and not only this one, it belongs in `audits/README.md` instead.
4. If it changes the lens set or a lens key, update the Lens classes section too: the rotation
   and the stamps are keyed off it.

## 7. Landing the work

Executing a batch is parallel-batch work like any other, and that playbook is deliberately not
duplicated here:

- **`orchestrating-parallel-work`** → its **"Landing Parallel Batches"** section, which owns
  sequencing by collision class, the per-batch chain, the landing rules (format last before every
  push; verify the merge is armed **or** queued; rebase to both intents; test-merge in-flight
  branches), rolling dispatch, and close-out discipline.
- **`REVIEW.md`** → its **"Failure modes worth hunting by name"** section, the library a review
  brief points a reviewer at. `assets/review-brief.md` is that brief.

> Both sections are on `main`. If `grep 'Landing Parallel Batches'` finds nothing in that skill,
> your checkout predates them and you substitute your own landing method.

## Assets

- `assets/auditor-prompt.md` — the per-lens auditor prompt.
- `assets/synthesizer-prompt.md` — the synthesis prompt.
- `assets/review-brief.md` — the adversarial-review brief for an execute batch.
- `assets/reference-implementation/` — two **non-normative** orchestration scripts from the
  September 2026 run, kept as known-good examples for one specific session orchestrator. The
  prose above is what is normative; the scripts are color. See that directory's README.

> **Harness note.** This skill is shared (`.agents/skills/`), and its procedure is written in
> capability language so any harness can follow it. Three references are unavoidably specific to
> this repo's Claude Code setup: the `/ui-audit:*` commands, the `orchestrating-parallel-work`
> skill (Claude-only by manifest), and the `/flow` plugin's adapter. A harness without them still
> runs §§1-6 unchanged; for §7 it substitutes its own landing method, and for §5 its own tracker
> path or the markdown ledger.
