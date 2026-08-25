---
id: 260825-110420
title: OpenCode search reads a throwaway snapshot, never the live store or the sidecar
status: accepted
created: 2026-08-25
spec: message-search
amends: [0308, 260728-214214]
superseded-by: null
---

# 260825-110420. OpenCode search reads a throwaway snapshot, never the live store or the sidecar

## Status

Accepted (DOR-688, spec `message-search` §2.3 and task 6.3).

**Amends [ADR-0308](0308-opencode-adapter-managed-server-sidecar.md)** — one clause of its Decision, and nothing else:

> OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly.

The **written** half stands, absolutely and forever. The **read** half is narrowed: a
read-only, snapshot-based read confined to an explicit table-and-column allowlist is
permitted, for indexing only. Every other clause of 0308 — the managed sidecar, the SDK
as the only interactive surface, the confinement rule, the ask-ruleset — is untouched.

## Context

Message search covers rooms and Claude Code today. OpenCode was deferred on four counts
(spec §2.3), and 0308's ban was the first of them: `opencode.db` holds
`account.access_token`, `account.refresh_token` and `credential.value` in the same file as
its messages, so a careless indexer over it writes live OAuth tokens into a searchable
table. That is not a hypothetical; it is why the ban was written.

Two things have changed since.

**The gap became a product claim.** DorkOS says "one place for every AI agent you run".
A search box that silently covers less for one runtime than another is the exact failure
this feature exists to refuse (spec G4), and the honest options were to cover OpenCode or
to keep saying in the product that it is not covered.

**The security argument turned out to have a structural answer.** The reason to fear the
read is proximity: the secrets are in the same file. A read whose reachable surface is a
frozen constant listing three tables and eight columns, none of them credential-bearing,
does not become dangerous because of what else the file happens to contain — any more than
`GET /api/sessions` becomes dangerous because the same disk holds `~/.ssh`.

The SDK route, meanwhile, was re-evaluated and still fails on its own merits, and that
matters more than it looks: it is the route somebody will propose again as "the safe one".
Nothing boots the sidecar at startup; `check-dependencies.ts` refuses even to probe because
a cold probe spawns a server as a side effect; `peekClient()` returns `null` when cold. So
an SDK-backed indexer on a five-minute timer must either spawn somebody else's agent
server on a schedule, or index only whatever happened to be warm. The first is a
reconciler with a child process; the second makes coverage nondeterministic, which is the
wrong trade for a feature whose entire promise is recall. **Every other source in this
design reads bytes already at rest, and this one now does too.**

## Decision

**1. Each sweep copies the store; the live file is never opened.**
`opencode.db` and its `-wal`/`-shm` siblings are copied into a fresh temp directory, the
COPY is opened `readonly: true` plus `PRAGMA query_only = 1`, and the directory is removed
in a `finally` when the sweep ends. DorkOS therefore never holds a connection to the
operator's store: it cannot lock it, checkpoint it, recover its WAL, or participate in the
concurrency problems 0308 recorded. The WAL siblings are copied because the newest
messages live in the log — a copy of the main file alone is the conversation as it stood
at the last checkpoint.

**2. Credential safety is structural, not a filter.**
`OPENCODE_READ_ALLOWLIST` (`services/search/opencode-store.ts`) is the complete set of
what may be reached: `session(id, directory, parent_id)`, `message(id, session_id,
time_created, data)`, `part(id, message_id, data)`, and `sqlite_master(type, name)` for
schema detection. Every statement in the module is built by a helper that throws on a
table or column outside it, so `SELECT *` is not expressible and reaching a credential
column takes a deliberate edit to a frozen constant. It is an allowlist rather than a
denylist of credential tables on purpose: a denylist is a list somebody must remember to
extend the day upstream adds `oauth_token_v2`.

**3. Message bodies are indexed as-is, including text that looks like a secret.**
A token a person pasted into a chat is their own transcript, and every other source
indexes what was typed into it. Redacting here would be exactly the content filter the
allowlist exists to make unnecessary, and it would be a filter that is wrong in both
directions.

**4. The watermark is a count of messages PLUS a volatility window, because a count alone
is provably not enough.**
`Session.time.updated` is stamped at turn START and never on message write, so the
`updated > lastSeen` poll the spec warned about misses the assistant half of every
in-flight turn. A session's ordinals are its messages' positions in `(time_created, id)`
order, so the high-water mark is a row count — and **the count has the same disease for a
different reason.** OpenCode creates the assistant `message` row at turn start and streams
its `part` rows in underneath it, mutating them in place as tokens arrive. Measured on the
operator's store 2026-08-25: **236 of 236 parts created after their message row, 55 of 80
text parts updated in place, 91 of 94 message rows updated after creation, last part up to
62 seconds behind.** So the count rises when a turn STARTS and the content lands for a
minute afterwards, and three shapes follow — a sweep landing mid-stream indexes a truncated
body and, because the count never moves again, serves it forever; a revert plus a new turn
inside one interval leaves the count identical while the content differs; an in-place part
edit changes no count at all.

**This was caught in adversarial review, after an earlier version of this ADR claimed the
caveat was "discharged". It was not.** The fix is
`OPENCODE_VOLATILE_WINDOW_MS` (15 minutes, three sweep intervals): `listContainers` reads
`message.time_updated` and `part.time_updated` — timestamps, not content, both added to the
allowlist — and marks any session touched inside that window `rereadWhole`, which moves the
resume position back to ordinal 1. Re-reading is free because the index upserts on
`(source, container, ordinal)`, and the cost is bounded by how much OpenCode was used in the
last quarter hour rather than by corpus size. A revert that lowers the count below what the
index holds still takes M2's shrink-means-rebuild path, which deletes first.

The margin is the guarantee: a mutation is first seen somewhere inside one interval, so a
two-interval window would land the following sweep exactly on the boundary. Three intervals
means at least two sweeps observe every mutation, the second strictly after the longest
stream observed (62 s) has finished. A test pins the window against
`SEARCH_RECONCILE_INTERVAL_MS`.

**A re-read DELETES first, and the version that did not was wrong.** The first
implementation kept `rereadWhole` distinct from a rebuild — resume at ordinal 1 and let the
upsert rewrite each row, so the FTS5 delete trigger stayed out of the common case. That
leaves a hole, found in the verify pass: **a message that projects to nothing writes no
row**, so it cannot overwrite what sits at its ordinal. A container whose count lands
exactly on the index's high-water mark fails the shrink test too (`maxOrdinal < indexedTo`
is false at equality), and the stale row answers at that ordinal forever. It is reachable
rather than theoretical — **25 of the 75 messages on the operator's store project to
nothing**, because a turn that only called a tool has nothing to search. The two paths are
now one: a whole re-read deletes and rewrites. The cost is bounded by whoever raises the
flag, and its only user raises it for conversations touched in the last quarter hour.

**5. Child sessions are not containers.** A session with a `parent_id` is a subagent's own
transcript — a conversation the human never had — excluded for the same reason
`claude-code-discovery.ts` walks past `subagents/**`.

**6. An absent store is not an empty one.** No `opencode.db` means zero indexed, zero
pruned and no failure recorded: OpenCode may never have run here. Reading absence as "every
session is gone" would delete an entire indexed corpus the first time the runtime was
uninstalled, silently.

**7. The port promotion is REFUSED.**
The design named the arrival of a third mechanism as the trigger that would promote
`SEARCH_SOURCES` from an array of records to a `SearchAdapter` port (spec §3, D12). M3 is
that third mechanism, and the promotion is refused — on evidence rather than taste. The
prediction behind the trigger was that a third mechanism would need a third copy of the
frontier logic. It did not. M3 reuses M2's entire watermark implementation through a
four-line `ContainerReader` seam and contributes one function of its own
(`snapshot-frontier.ts`, ~40 lines of code); the resume rule, the shrink rebuild, the
frontier write and the prune are shared, not duplicated. A port introduced here would
abstract three mechanisms that already share their implementation, which is a class
hierarchy standing where a record does.

**The re-trigger is written down rather than left to taste. The promotion fires on
either of:**

- **a FOURTH mechanism** — one whose change detection cannot be expressed as either a byte
  offset or a monotonic ordinal, so it needs frontier logic of its own rather than a
  `ContainerReader`; or
- **a source that lives outside `apps/server`** — a package, an extension, or a
  marketplace-installed indexer. The array is a private constant in one file; the moment a
  source has to be registered from somewhere that cannot edit that file, the registration
  surface IS the port, and it should be built deliberately rather than grown as an
  `if`-chain in `indexer.ts`.

## Consequences

### Positive

- OpenCode conversations are searchable, and the product's "one place" claim survives
  contact with its own search box. 50 messages across 63 sessions on the operator's
  machine, indexed in 41 ms (2026-08-25).
- The read is safe by construction, and the construction is one frozen constant a reviewer
  can check in ten seconds — with a test that reddens if a credential table is ever added
  to it.
- DorkOS is not a participant in OpenCode's store concurrency at all, which is a stronger
  position than the SDK path offers: the sidecar holds a live connection, and this does not.
- The frontier logic stayed one implementation for three mechanisms, which is now measured
  rather than asserted.
- **A source that has gone dark says so to the person searching.** A failed snapshot stamps
  `search_sources.last_error` on the containers that already exist, so `searchForCaller`
  raises its warning rather than leaving the failure in a log nobody reads. That matters
  here more than for the other sources, because this is the one that parses another
  product's private schema and the ADR expects that schema to move.

### Negative

- **A copy costs what a copy costs.** The whole store is copied every sweep, so the cost
  scales with total OpenCode history rather than with what changed — unlike M1's byte
  offset and M2's ordinal read. At 1.4 MB and 41 ms per sweep this is free; at a gigabyte
  it would not be, and the answer then is `VACUUM INTO` against a read-only connection or a
  size ceiling, not a live read.
- **A copy taken from under a live writer can be torn or merely STALE, and only the second
  is genuinely undefended.** Torn was measured rather than assumed: four tear shapes against
  a valid database — two zeroed interior pages, a truncation to 60%, a page of garbage — and
  **every one threw `SQLITE_CORRUPT` on the first real `SELECT`.** None opened cleanly and
  returned a short list, so the feared "it lies to you" shape did not reproduce. (A bare
  `SELECT COUNT(*)` can still answer from a surviving page, which is what made an earlier
  draft of this bullet believe otherwise.)

  `PRAGMA quick_check` at open is still load-bearing, for a different and sharper reason:
  `listContainers` runs at the top of `sweepContainers`, OUTSIDE the per-container `try`, so
  a corrupt read there escapes the source altogether. Checking at open converts a
  **process-wide sweep abort — which would take rooms and Claude Code down with OpenCode —**
  into one recorded per-source failure. (A second, independent guard now backs it up: the
  indexer wraps each source, so no source can end another's tick.)

  **The accepted risk is staleness.** The three files are copied one after another, so a
  checkpoint landing between them yields an old main file beside a truncated WAL: a
  perfectly valid database that describes an earlier moment and can be missing whole
  conversations. `quick_check` passes it. The defence is `SNAPSHOT_MIN_LIVE_SHARE` — the
  sweep refuses to prune when fewer than half the known containers are listed, records a
  failure instead, and prunes on a later tick once the count has settled. That is a floor,
  not a proof: a stale copy losing a third of the sessions still prunes them, and they come
  back on the next sweep at the cost of a re-read. Making this airtight needs an atomic
  snapshot (`VACUUM INTO` against a read-only connection, or the backup API), which is the
  trigger for revisiting: **the day the corpus is large enough that a re-read after a bad
  prune is expensive, take an atomic copy instead of a file copy.**

- **DorkOS now parses another product's private JSON schema.** `message.data` and
  `part.data` are OpenCode's internals, and they will change. The projection counts every
  row it does not recognise (`SourceSweep.skipped`) precisely so that drift is visible
  instead of looking like a quiet runtime, and the schema check fails the whole source
  loudly if a table or column disappears.
- **0308's line is no longer absolute**, and that has a cost beyond this feature: "never
  read directly" was a rule anyone could apply without judgement, and it is now a rule with
  an exception. The exception is bounded by this record — read-only, snapshot, allowlisted,
  indexing only — and any widening of it needs its own ADR.
