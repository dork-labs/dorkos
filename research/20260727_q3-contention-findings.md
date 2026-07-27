# Q3 contention findings — what breaks first at 6 concurrent agents

- **Date:** 2026-07-27
- **Status:** active
- **Question:** At the realistic near-term configuration (2 humans + 6 agents on one machine), which resource class collides first — working tree, `~/.dork` SQLite, fds/watchers, subprocess memory, or provider rate limits?
- **Design:** Pre-registered in `research/20260725_q3-contention-preregistration.md` (arms, canary method, overlap requirement, and the positive/null/invalid definitions were fixed **before** any data existed). Harness: `scripts/q3-contention/`, PR #482, DOR-500.
- **Run date:** 2026-07-26. **Raw artifacts no longer exist** — the harness tears down its run root by default (`--keep` was not passed), so the CSVs and `summary.json` from these runs are gone. This document is the record.

---

## Conditions

Six runs, all arms 1 and 2 (test-mode runtime). 6 agents, 30 000 ms turns, 500 ms tick, default `--min-overlap`. **Arm 3 was not run** — it remains unrun and unverified.

The machine was **not quiet**. Background load varied widely between runs (peak 1-minute load 8.0 to 50.1) from Spotlight reindexing, iCloud file sync, Time Machine, and other agent sessions. This matters and is analysed below rather than hidden.

## Results

**Arm 1 — 6 agents, ONE shared worktree**

| Run | Survived / 360 | Rate  | Peak load1 | Peak tree RSS | Peak open files |
| --- | -------------- | ----- | ---------- | ------------- | --------------- |
| 1   | 57             | 15.8% | 8.0        | 785 MB        | 22 477          |
| 2   | 6              | 1.7%  | 49.7       | 757 MB        | 22 604          |
| 3   | 18             | 5.0%  | 50.1       | 755 MB        | 22 326          |

**Arm 2 — 6 agents, TWO worktrees (3 per tree) — the control**

| Run | Survived / 180 per tree | Rate  | Peak load1 |
| --- | ----------------------- | ----- | ---------- |
| 1   | 43, 43                  | 23.9% | 40.0       |
| 2   | 55, 70                  | 34.7% | 25.6       |
| 3   | 61, 62                  | 34.2% | 26.7       |

**Every run:** overlap proof passed (all six agents concurrent for the full ~30 s common window), `crossedTokens=0`, `sqliteBusy=0`, `emfile=0`, all six turns `ok`.

## Findings

**1. Tree-sharing is the collision.** Halving agents-per-tree roughly doubles write survival, and does so _even when the control ran under higher load_: arm 2 at load 40 (23.9%) beat arm 1 at load 50 (1.7–5.0%) by 5–14×. That inversion is the control earning its keep — without arm 2 you would see arm 1's loss and could not tell tree-sharing from a machine-global cause.

The arithmetic matches the mechanism: last-writer-wins whole-file rewrites give survival scaling roughly with 1/N writers, so 6→3 writers per tree roughly doubling is what the mechanism predicts.

**2. Nothing else collided.** `sqliteBusy=0` and `emfile=0` in all six runs, at ~22–23k open files machine-wide. Scoped per the pre-registration: the SQLite zero means **one process's connection pool did not self-contend**, not that multi-process SQLite contention is absent — the harness runs one server with N sessions, which is the realistic configuration (`worktree-setup.sh` patches ports but never `DORK_HOME`). Error detection is by log-scraping, so an error swallowed without logging is uncounted.

**3. The instrument is far more load-sensitive than the pre-registration anticipated.** Arm 1 swung 1.7% → 15.8% on background load alone — nearly 10× from the same configuration. **Treat the absolute numbers as soft; the arm-1-vs-arm-2 contrast is the durable result.** A clean-machine re-run would tighten this considerably and has not been done.

**4. No cross-session content bleed.** Six concurrent agents with disjoint vocabularies, zero foreign tokens in any session's stream. See the limits below before citing this.

## Limits — read before quoting any number here

**The canary is a deliberately non-atomic read-modify-write.** It proves agents interleave pervasively at fine grain — the _opportunity_ for corruption is the normal case, not an edge case. It does **not** prove real agent tooling corrupts anything: a tool writing atomically (temp file, then rename) loses nothing on this workload. Whether DorkOS's write tools are atomic is answerable by reading their implementations, not by more measurement. **Do not quote these as a data-loss rate for real agents.**

**`crossedTokens=0` is narrower than it appears.** Verified in `scripts/q3-contention/turns.ts`:

- It is a **purity check, not a completeness check** — received token count is never reconciled against the `ticks` the scenario self-reports, so the harness could drop an arbitrary fraction of every stream and still report zero.
- **No sequence continuity check.** `drainFrames` parses only `event:` and `data:` and ignores `id:` entirely; the harness requests `?after=0` for gap-free replay and never verifies gap-freeness.
- **Structurally blind to the `turn_end` boundary** — `consumeTurnStream` returns the instant it sees `turn_end`, so anything after it is unobserved by construction. This is precisely the boundary log atomicity concerns.
- Arms 1–2 exercise **test-mode**, not claude-code, codex, or opencode.

So the defensible claim is: _no session's text stream contained content belonging to another session, in test-mode, up to the turn_end boundary._ Cite it as "no cross-session content bleed observed." **Do not lean on it for log atomicity.**

Three small changes to `turns.ts` would earn the stronger claim: reconcile received tagged-token count against reported `ticks`; parse `id:` and assert monotonic seq with no gaps; keep reading past `turn_end` to assert nothing follows.

**Bound on what agent-owned workspaces fix.** These results argue for per-agent working directories (`specs/agent-workspace-binding/`), but that reduces interference _between agents_, not between concurrent _sessions of one agent_, which share that agent's tree by design. Six sessions of one agent would reproduce arm 1 exactly.

## What this licensed

Per the pre-registered outcome definitions: **Positive (tree-sharing)**.

The decision it fed — whether rooms need a full resource-keyed lock or only a write-intent policy — resolved toward **prevention over containment**: give main agents their own working directories so the collision stops being the default case, rather than building a hierarchical lock to contain it. Remaining exposure after that change is human-vs-agent (you editing in an IDE while an agent edits the same repo) and Pulse-scheduled runs, which inherit no reading of `AGENTS.md`. Neither is agent-vs-agent.

The lock (A′-mechanism) is therefore **not** thread-gated and dropped in priority. It is still the only answer for concurrent sessions of one agent.

## Related

- `research/20260725_q3-contention-preregistration.md` — the fixed design
- `research/20260724_multi-user-communities.md` — the multi-user architecture research this fed
- `research/20260727_multi-user-review-exchange.md` — the six-document agent review exchange
- `specs/agent-workspace-binding/`, `specs/channel-workspace/`
- ADR `260726-170125` (a room is a membership-scoped durable stream), ADR `260726-170127` (the room path carries its own cascade guard)
