---
id: 260728-214214
title: Message search is a derived, rebuildable index, not a second transcript store
status: accepted
created: 2026-07-28
spec: message-search
amends: 0310
superseded-by: null
---

# 260728-214214. Message search is a derived, rebuildable index, not a second transcript store

## Status

Accepted (2026-08-26 — the full programme shipped on this design: rooms + three transcript mechanisms indexed, palette UI, the Obsidian embed reading the same index read-only, and the delete-the-index recovery intact; see specs/message-search/04-implementation.md). **Partially supersedes [ADR-0310](0310-runtime-owned-session-storage-aggregated-listing.md) — one clause of one Negative consequence, and nothing else.**

**2026-08-25**: Amended by [260825-110420](260825-110420-opencode-search-reads-a-snapshot-not-the-live-store.md) (DOR-688) on the two claims below that time has overtaken. **The port trigger fired and the promotion was REFUSED**: OpenCode is now indexed, on a third mechanism (M3, a read-only snapshot of its SQLite store) — but that mechanism turned out to need none of the frontier logic rewritten, reusing M2's watermark implementation through a `ContainerReader` seam, so the registry array held. The re-trigger is recorded there: a FOURTH mechanism whose change detection is neither a byte offset nor a monotonic ordinal, or a source living outside `apps/server`. Consequently **there are now three mechanisms**, and the count of sources this record gives is a snapshot of 2026-07-28 rather than a rule.

**The scope of the supersession is one sentence** — 0310's Consequences → Negative, the cross-runtime-features bullet, quoted here rather than cited by line because this same commit edits that file:

> Cross-runtime features (global search, unified export) must fan out per runtime rather than query one store.

**This is an amendment, not a reading.** The comfortable defence — that the bullet sits under _Negative consequences_ and is therefore descriptive rather than binding — is lawyering, and it does not survive review. 0310's Decision had already said storage stays runtime-owned; if the bullet only restated that it would be redundant. It says something additional and specific, phrased as the only mechanism prohibition in the whole Consequences block ("must fan out **rather than** query one store"), and it names global search as its first example. This design answers queries from one store. That is the mechanism it forbids, applied to the feature it names, and pretending otherwise would leave a reviewer holding both documents and a contradiction.

So the clause is **narrowed, deliberately**, to what it was protecting: cross-runtime **authority** stays runtime-owned; cross-runtime **query** may be served from a derived, rebuildable index. It is retired **at query time only**, and preserved exactly at read time — every byte this index holds is read per runtime, through that runtime's own projection, from that runtime's own storage. What changes is that the fan-out result is cached and queried once instead of re-derived on every keystroke.

**What forced the narrowing is that bullet's own sibling.** The preceding Negative concedes that aggregation inherits every backend's latency and failure modes, and the fan-out endpoint pins that at 2s per runtime (`260717-001410:22`), so a fan-out search is partial by construction. It was written on 2026-07-02, when "cross-runtime feature" meant **listing**; interactive full-text search over hundreds of megabytes of two runtimes' transcripts plus the room log is not a per-request fan-out at any latency a person will accept.

0310's Decision is untouched — storage stays runtime-owned, there is still no unified DorkOS transcript store, and this index writes to no runtime's store, is not a store of record, and is never the answer to "what happened", only to "where to look". Its other two Negative consequences (graceful degradation of a slow or failed runtime; ordering and pagination defined at the aggregation layer) stand and are inherited: this index degrades per source with warnings, exactly as session listing does.

**0310 keeps `status: accepted` and `superseded-by: null`, and that is not an oversight.** A status is an instruction about whether to rely on a document, not a description of its history, and a reader must still rely on all of 0310 — it is the decision that keeps DorkOS from becoming the second writer of someone else's transcripts, which is the premise this ADR is built on rather than against. The retired clause is named in prose at the top of that ADR instead. (`writing-adrs`, "Partial supersession".)

## Context

**There is no full-text search anywhere in DorkOS**, verified rather than assumed: zero production hits for `fts5` / `bm25` / `snippet(` / `VIRTUAL TABLE` across `apps/` and `packages/`, no virtual table in any of the 37 migrations under `packages/db/drizzle/`, and no `LIKE`-based fallback in the room service either. A person who half-remembers something an agent said has no way to find it.

**Two prior decisions anticipated this, and one of them named the cost that forces it.** `specs/room-participation/02-specification.md:646` refused to build an index for its own tool and said what would buy one — _"If it becomes slow, that is evidence for an index, and evidence is what should buy one."_ And `decisions/260717-001410-recent-sessions-fanout-endpoint.md:28` names this work in its first Positive — _"One reusable cross-agent session primitive (future global search/export can build on it) with a single server-side implementation"_ — then records at `:34` what doing it by fan-out alone would cost: _"O(agents × runtimes) reads per request; acceptable at tens of agents with 30s client staleTime, but fleets of hundreds will need a server-side cache."_

**Read `:28` carefully rather than favourably: it anticipates global search building on the fan-out primitive, not on a separate store.** It is an invitation, not a licence for this shape. The line that actually forces the shape is `:34`, together with the 2s-per-runtime timeout that endpoint inherits (`:22`) — a fan-out search returns partial results by construction, and a person searching their own history cannot be told "some of your runtimes timed out" on every keystroke. This index is the server-side cache `:34` predicted; it is not the thing `:28` imagined, and the difference is why this ADR exists rather than being unnecessary.

**Two constraints bound the answer.** ADR-0310 keeps transcript storage runtime-owned, so DorkOS must not become the second writer of anyone else's truth. ADR-0308:24 goes further for one runtime — _"OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly"_ — and reading that file would have put `account.access_token`, `account.refresh_token` and `credential.value` one careless `SELECT` away from a searchable table. The security instinct and the ADR converge; the ADR got there first, and the credentials are evidence that it was right rather than grounds for an exception.

## Decision

We will build message search as a **derived, read-only, rebuildable SQLite index**, following ADR-0043's shipped shape — canonical truth on disk, a derived cache, a reconciler — with the runtimes' own stores playing the role `.dork/agent.json` plays for `agents`.

**One `messages` table, one FTS5 external-content table (`tokenize='porter unicode61'`), one `search_sources` frontier table.** No new dependency: FTS5, `bm25()` and `snippet()` are present in the pinned `better-sqlite3@12.11.1` / SQLite 3.53.2. External content is **39.9% smaller** than storing the text twice at the measured corpus size, with query time indistinguishable (p50 0.681 ms vs 0.702 ms). Porter is not a preference: `dogs` returns **1** hit under `unicode61` and **3** under `porter unicode61`, and stemming is what makes the user story work.

**Each source gets one small pure projection; nothing else varies.** Discovery, change detection, incremental read and upsert are written once per _mechanism_, not once per source, and a source is a row in a registry array plus a function. Two mechanisms served three sources at the time of writing: **append-only JSONL tailed at a byte offset** (Claude Code transcripts, Codex rollout files) and **SQLite rows above a monotonic watermark** (the room log). A third — **another program's SQLite store, read through a throwaway snapshot** — landed with OpenCode; see the amendment note in Status. Every projection selects explicit fields — no `SELECT *`, no "index all text columns", no recursive JSON walk.

**OpenCode is deferred, and the deferral is load-bearing rather than incidental.** ADR-0308:24 forecloses the direct read; the SDK alternative then fails on four counts of its own — a background read must **spawn someone else's agent server** on a timer, the corpus is **24 messages**, the pinned SDK surface is provably stale against the server it drives, and an SDK poll is a **third mechanism**: it has no resumption primitive (it pages backwards from newest, so "what is new" is not expressible) and it carries a liveness precondition the other two lack. Under this design's own rule, a third mechanism promotes the shape to a port. **We will not do that for 24 messages** — so there is no port, and **the day OpenCode is indexed the promotion fires.** That trigger is recorded so the next author inherits a decision rather than an accretion. _(The day came on 2026-08-25, and the promotion was refused with evidence rather than taken automatically — ADR 260825-110420. The direct read was also reopened there, narrowly: a snapshot copy through a table allowlist, never the SDK and never the live file.)_

Nothing here reads Codex rollout files on the strength of silence alone: no ADR forbids it — the phrase "never read or written directly" occurs exactly once in the whole decisions corpus, about OpenCode — but absence of a prohibition is not authorization, which is why the coupling is recorded here.

**Rebuild will be the first answer to drift, not the last.** A full cold rebuild of a prototype index built for this decision measures **8.25 s** over the operator's entire 2,911 MB corpus and **2.69 s** over the corpus this actually indexes, producing a 29.2 MB database. That single fact is what makes the rest of the design cheap, and it produces the rule this index is governed by: **in a table rebuildable in seconds, no column ships without a consumer.** Widening later costs one projection change and a rebuild, not a migration. The rule cut two columns during design review, including one the reviewer had proposed.

**Search is scoped by a join, never by a token in the index.** The caller's visible container set is resolved by the shipped authorization path and applied as `source_id = 'rooms' AND origin_key IN (...)`; the owner path omits the clause entirely. Materializing an ACL into the index would force re-indexing a whole room every time somebody joined it. An agent reaching search over MCP gets member-scoped room history and **no session history at all**, because `resolveCaller` cannot serve an MCP invocation and a caller omitting `X-DorkOS-Agent` resolves to the install owner — who may see every room. Absence is never consent.

**This is recall for a human.** Agent-facing recall is DOR-632 and is deliberately a different problem, with a different corpus, ranking, access model and latency budget.

## Consequences

### Positive

- A person will be able to find anything they or their agents ever said, across every indexed runtime and every room, from one box — including sessions run from the bare CLI outside DorkOS. **What is new is searching them and reaching every project from one box**, not listing them: `listSessionsInDir` already reads every `.jsonl` in a project directory with no origin filter, and the session watcher already covers every slug directory. Claiming DorkOS could not surface those sessions would fail our own demo-claim gate, applied to our own history.
- The cross-runtime cockpit's headline claim gets a feature that only works because the cockpit is multi-runtime. Search over one runtime would have undercut the claim the product leads with.
- Nothing becomes load-bearing. The index is derived, disposable and rebuildable in seconds; deleting it is a supported recovery, and no runtime notices it exists.
- ADR-0310's degradation shape is inherited for free: a source that fails to project contributes zero rows and one warning, never a failed search and never a blank result list.
- `search_room_history` stops needing a substring scan of its own, so there is exactly one search path over the room log rather than two that disagree.
- The `260717-001410` fan-out endpoint gets the server-side cache it predicted it would need, without changing its contract.

### Negative

- **We become coupled to on-disk formats we do not own, for the sources that have no other reader.** The mitigation is real but partial: a projection is ~20 lines and a rebuild is seconds, so a format change costs one function and no data — but it costs _silently_, as a source that quietly stops contributing rows. The frontier table must therefore make "this source produced nothing" visible rather than indistinguishable from "this source had nothing new."
- **Coverage is uneven across runtimes, and the unevenness is not obvious to a person.** Only one runtime's bare-CLI sessions are reachable; the others are visible only to the extent DorkOS itself has a record. A search box that silently covers less for one runtime than another is the kind of dishonesty this project refuses, so the shortfall has to be stated in the product, not only in the spec.
- **We index a small fraction of what was said, and some natural queries return nothing.** About 4% of transcript lines and under 1% of transcript bytes, measured over the operator’s own corpus. Tool output, file snapshots and reasoning blocks are excluded, so _"the error the agent showed me"_, _"that stack trace"_ and _"the diff where we changed X"_ find nothing. This is a stated scope, and it belongs in user-facing copy rather than in a spec nobody reads.
- **A second index over the room log is now a permanent temptation.** Anything wanting different matching semantics — substring, fuzzy, semantic — will be tempted to add its own path. The rule that there is one index over these rows has to be defended, not assumed.
- **Stale rows are indistinguishable from live ones at the point of reading**, which is why deletion has to be transactional with whatever invalidates the underlying cache. A community that ejects you must drop its cached rooms and its index rows in the same transaction, or search serves content the cache correctly dropped.
- **`porter unicode61` cannot find code.** Identifiers only match under a trigram tokenizer, and adding one would double the index to serve a question file search answers better against files that are actually current.
- **One more reconciler.** A fourth periodic sweep in a process that already runs three, with the same 5-minute-staleness trade-off ADR-0043 accepted.
