---
title: 'Q3 Resource Contention — Pre-Registration'
date: 2026-07-25
type: experiment
status: active
tags: [q3, contention, multi-agent, measurement, pre-registration, DOR-500]
---

# Q3 Resource Contention — Pre-Registration

- **Question:** At 2 humans and 6 agents on one machine, which resource class collides first?
- **Status:** Design frozen. **No measurement run has been executed. No data exists.** Smoke
  runs HAVE been executed, and each wrote a full `summary.json`. Those artifacts are not
  data and must not be read as results — 2 agents rather than 6, turns of a few seconds
  rather than tens of seconds, run only to prove the plumbing works. They are identifiable
  from the file itself: `plan.smoke` is `true`. Treat any run with `plan.smoke === true`,
  fewer than 6 agents, or a `plan.durationMs` under 10000 as a plumbing check, whatever its
  numbers say.
- **Harness:** `scripts/q3-contention/` (`pnpm q3:contention`) and the `q3-*` test-mode
  scenarios in `apps/server/src/services/runtimes/test-mode/q3-contention-scenarios.ts`.
- **Origin:** Ledger row Q3 of the multi-user review exchange, whose subject artifact is
  [`research/20260724_multi-user-communities.md`](20260724_multi-user-communities.md). The
  exchange itself was a deliberately uncommitted agent-to-agent thread; this file is the
  durable extraction of its Q3 design, written **before** any data existed.

> **Why this file exists.** The design was fixed before the first run specifically so
> results could not be rationalised after the fact. A future reader auditing an executed
> run should compare it against **this file**, not against the harness source — the source
> can be edited, and an experiment whose design moves with its results measures nothing.
> If a run needs a design change, amend this file in a separate commit first, and say so.

---

## The decision this feeds

The multi-user review converged on a resource-coordination decision (called **A′-mechanism**
in that exchange): a resource-keyed lock over a _containment_ relation spanning several
resource classes. Two shapes were live:

1. A **full resource-keyed lock** — real mutual exclusion over a containment hierarchy.
2. A **write-intent policy** — a convention that agents declare intent, with no enforcement.

Sizing that work requires knowing which resource class actually breaks first. The review
closed with Q3 as the only open row, explicitly marked _"measurement, not argument."_ This
harness is that measurement and nothing more.

## Resource classes under test

Ranked as candidates, not as a prediction:

| Class                       | What would show it                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working tree                | Interleaved writes to a shared file lose lines (see _Canary method_)                                                                                            |
| `~/.dork` SQLite            | `SQLITE_BUSY` / "database is locked" in server output                                                                                                           |
| File descriptors / watchers | `EMFILE`; machine open-file count approaching its limit                                                                                                         |
| Runtime subprocess memory   | RSS of the server process tree (arm 3 only — test-mode spawns nothing)                                                                                          |
| Provider rate limits        | Turn `terminalReason` values carrying rate-limit failures (arm 3 only)                                                                                          |
| Human supervisory attention | **Not measurable here.** Named because the review flagged it as the plausible real binding constraint, and a machine-resource null result does not rule it out. |

## The three arms

Fixed. A new arm is a new pre-registration, not an edit to this one.

| Arm   | Runtime       | Trees                       | Exercises                                       |
| ----- | ------------- | --------------------------- | ----------------------------------------------- |
| **1** | test-mode     | ONE shared worktree         | Tree sharing + machine-global effects together  |
| **2** | test-mode     | TWO worktrees, agents split | Machine-global effects **only**                 |
| **3** | real runtimes | TWO worktrees, agents split | Adds subprocess memory and provider rate limits |

**Arm 2 is the control, and it is the load-bearing arm.** Arms 1 and 2 differ in exactly one
variable: whether agents share a working tree. Everything else — machine, agent count, server
process, `DORK_HOME`, duration, tick rate — is held constant. So:

- Effects present in arm 1 but absent in arm 2 are **tree-sharing** effects.
- Effects present in **both** are machine-global and would not be fixed by giving each agent
  its own tree.

That distinction is the whole point: a lock keyed on the working tree fixes the first class
and does nothing for the second.

Arms 1 and 2 are free and repeatable. Run them many times for a distribution; a single run of
either is an anecdote. Arm 3 costs real tokens and is expected to be run rarely.

## Configuration

- **6 agents** — the "6 agents" half of the question. The "2 humans" half is modelled as
  concurrent load, not as authenticated accounts: what a human contributes to contention is a
  turn, and a turn is a turn regardless of who fired it.
- **One server process, N sessions.** This matches the realistic configuration:
  `.claude/scripts/worktree-setup.sh` patches ports only and never `DORK_HOME`, so parallel
  worktrees on one machine share one DorkOS home. See _Limitations_ — this bounds what a
  SQLite null result can mean.
- **Turn duration in the tens of seconds**, so turns genuinely overlap. A zero-latency
  scenario measures nothing.

## Canary method

Each agent repeatedly performs a **deliberately non-atomic read-modify-write** against a
shared file: read the whole file, append one line tagged with its vocabulary and an
incrementing counter, write the whole file back. No append mode, no lock, no atomic rename.

One canary **per worktree**. In arm 1 all agents share one; in arms 2 and 3 each tree has its
own, so agents in different trees cannot lose each other's lines.

After the run, surviving lines are counted against what each agent reported writing.

**What this measures, stated precisely:** the canary is an **interleave detector**. A shortfall
proves that concurrent whole-file rewrites interleaved and clobbered each other. It is _not_ a
corruption rate for real agent tooling: a writer using the atomic temp-file-plus-rename pattern
(which DorkOS's own marketplace install transaction uses, ADR-0304) loses **nothing** on this
same workload. The canary answers "did these agents' writes interleave, and how much," which is
the input to the lock-versus-policy decision. It does not answer "how much data do real agents
lose." Any number from this harness quoted as a corruption rate is a misuse of it.

## Overlap requirement

**Non-negotiable.** Without proof of concurrency, a clean result is indistinguishable from six
agents politely taking turns, and the entire run is worthless.

Every agent records the wall-clock instant its turn started and ended, on one clock. A run is
valid only if a single instant exists at which **every** agent was mid-turn — the common
intersection of all N intervals, not merely pairwise overlap. Intervals that only touch do not
count. A run failing this is discarded, not interpreted.

## Work requirement

A turn that overlapped but did nothing is as worthless as one that did not overlap. A run is
valid only if every planned agent finished cleanly, produced streaming work, and wrote at
least one canary line. This exists because arm 3 drives a real model that can ignore
instructions: six agents streaming prose while skipping the canary would satisfy the overlap
proof and report "no contention" from a run that measured nothing.

## What counts as a result

Stated before the data, so neither outcome can be re-labelled afterwards.

**Positive — tree-sharing collides first.** Arm 1 shows canary shortfall; arm 2 shows
materially less or none, at the same agent count and duration. Reads as: the working tree is
the first collision, and a resource-keyed lock on the tree is worth its cost.

**Positive — a machine-global class collides first.** `SQLITE_BUSY`, `EMFILE`, memory
exhaustion, or rate-limit terminal reasons appear at similar rates in arms 1 **and** 2. Reads
as: the resource-class priority inverts, and per-tree locking is the wrong first move.

**Null.** Both arms run clean at 6 agents: no shortfall beyond arm 2's baseline, no
`SQLITE_BUSY`, no `EMFILE`, no memory or rate-limit failures, with the overlap and work proofs
passing. Reads as: **no machine resource class collides at this configuration**, so
A′-mechanism is not urgent on contention grounds and a write-intent policy is defensible for
now.

A null result is a real result and must be reported as one. It does **not** license "multi-agent
rooms have no contention problems" — see _Limitations_, especially the human-attention row.

**Invalid.** Overlap proof fails, work proof fails, or the machine was under foreign load.
Discarded. Not interpreted, not reported as null.

## Limitations

Known before the first run. A result must be read through all of them.

1. **Single-process SQLite.** One server process means one connection pool against
   `~/.dork`. A `SQLITE_BUSY` count of zero shows that pool did not self-contend; it does
   **not** show SQLite survives multiple DorkOS processes on one home. That is a different
   experiment. This limitation is deliberate — it matches the realistic configuration above —
   but it bounds the claim.
2. **The canary detects interleaving, not corruption.** See _Canary method_. Atomic writers
   lose nothing here.
3. **`SQLITE_BUSY` and `EMFILE` are detected by scraping server output.** An error the
   database driver swallows without logging is not counted. Absence of evidence, not evidence
   of absence.
4. **Open-file count is machine-wide** (`sysctl kern.num_files`), not per-process, so a busy
   machine raises the floor. Chosen because `lsof` is too expensive to sample at 1 Hz and the
   machine-global limit is the resource class in question. Only macOS is verified.
5. **Test-mode spawns no subprocesses.** Arms 1 and 2 cannot speak to runtime memory or
   provider rate limits at all. Only arm 3 touches those two rows of the table.
6. **Human supervisory attention is unmeasurable here** and was the review's own leading
   candidate for the real binding constraint.
7. **Foreign load invalidates a run.** The harness records load average so a contaminated run
   can be recognised, but it does not refuse to start on a busy machine. Check the sampled
   load before trusting any run.

## Artifacts a run produces

Under `.temp/q3-contention/<runId>/`: `samples.csv` (1 Hz machine state), `turns.csv`
(per-agent intervals and outcomes), `canary-<tree>.log` (copies of the canaries),
`summary.json` (everything above plus the plan, the overlap verdict, and the caveat strings),
and `server.log`.

The harness reports numbers. It does not interpret them.
