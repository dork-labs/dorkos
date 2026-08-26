---
slug: message-search
id: 260728-213721
created: 2026-07-28
status: specified
linearIssue: DOR-672
---

# Message search — one box over every message you have ever sent or received

**Status:** Specified (frozen for DECOMPOSE)
**Author:** Claude (directed by Dorian), SPECIFY stage
**Date:** 2026-07-28
**Tracker:** DOR-672 · the cockpit's first recall surface
**Ideation:** `specs/message-search/01-ideation.md`
**Decision:** ADR `260728-214214` (a derived, rebuildable index; partially supersedes one clause of ADR-0310 — the "must fan out per runtime rather than query one store" bullet)
**Anchor:** `origin/main` @ `042f89dae`, 2026-07-28. **Byte sizes written `MB` are binary megabytes (bytes ÷ 1048576, i.e. MiB)** — one convention throughout, so figures here are directly comparable with each other but read ~5% smaller than the same bytes in decimal MB. Every `file:line` below was opened at that commit. Measurements are labelled **[measured]** where this document took them and **[operator]** where they were taken during design; where the two disagree, §1.4 says so.

## Overview

You half-remember a conversation with an agent about dogs. You type `dogs`. You get every matching message — DorkOS rooms, Claude Code sessions and Codex sessions, including ones you ran from the bare CLI outside DorkOS — ranked, in one list. You click one and land where it was said. **OpenCode is not in that list**, and §2.3 is why; a search box that silently covers less for one runtime than another is the failure this project refuses, so the gap is stated in the product and not only here.

This spec builds that as a **derived index, not a second store**: canonical truth stays where each runtime put it, and DorkOS keeps a rebuildable SQLite cache beside it. That is ADR-0043's shipped shape with runtimes' stores in the role `.dork/agent.json` plays for `agents`.

```
 runtime store / room log ──projection──▶ messages ──trigger──▶ messages_fts (external content)
   (canonical, never written)   (~20 lines,      (derived,        (porter unicode61, bm25)
                                 pure)            disposable)
                                     ▲
                              search_sources ── the frontier: what we have already read
```

Three things this is not. It is **not** a transcript store — no runtime reads it, and deleting it is a supported recovery. It is **not** a search over everything that happened — it indexes what was _said_ — **about 4% of transcript lines and under 1% of transcript bytes** — and §1 states exactly which questions therefore return nothing. And it is **not** agent memory; DOR-632 is that, and §9.4 keeps them apart.

## Background / Problem Statement

**There is no full-text search anywhere in DorkOS, verified rather than assumed.** `grep -rniI "fts5|bm25|snippet\(|VIRTUAL TABLE"` across `apps/` and `packages/` returns zero production hits. No SQLite virtual table exists in any of the 37 migrations under `packages/db/drizzle/`. There is no `LIKE` fallback either — grep for `like(` or `search` across `apps/server/src/services/rooms/` and `apps/server/src/routes/rooms.ts` returns nothing. The only `fts5` mentions in the repo are research prose that decided against it (`research/20260224_mesh_core_library.md:405-409`, weighing it; `:451`, "Skip FTS5 in v1").

**Two prior decisions asked for this, and this spec answers both.**

- `specs/room-participation/02-specification.md:646` refused to build an index for its own tool and wrote its own invitation: _"If it becomes slow, that is evidence for an index, and evidence is what should buy one."_
- `decisions/260717-001410-recent-sessions-fanout-endpoint.md:28` names this work in its first Positive — _"One reusable cross-agent session primitive (future global search/export can build on it) with a single server-side implementation"_ — and records at `:34` what fan-out alone would cost: _"O(agents × runtimes) reads per request; acceptable at tens of agents with 30s client staleTime, but fleets of hundreds will need a server-side cache."_ **This index is that cache.** Read adversarially, `:28` anticipates search building on the fan-out **primitive**, not on a separate store — it is an invitation, not a licence for this shape. The line that forces the shape is `:34`, with the 2 s-per-runtime timeout that endpoint inherits (`:22`): a fan-out search is partial by construction, and a person searching their own history cannot be told "some of your runtimes timed out" on every keystroke.

So the framing is an anticipated need arriving on schedule, not a change of mind. There is exactly **one** supersession in the whole change, it is an ADR-level one, and it is named in ADR `260728-214214`. The three changes to neighbouring specs are amendments, not supersessions, and §References lists them.

**Two constraints bound every option.** ADR-0310 keeps transcript storage runtime-owned so DorkOS never becomes the second writer of someone else's truth. ADR-0308:24 goes further for one runtime — _"OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly"_ — and the file itself is the argument: it holds `account.access_token`, `account.refresh_token` and `credential.value` in the same database as its messages. The security instinct and the ADR converge, and **the ADR got there first**; the credentials are evidence it was right, not grounds for an exception.

## Decisions (LOCKED — settled in IDEATE, do not relitigate)

`specs/message-search/01-ideation.md` §6, D1–D12, in full. The five that bind hardest here:

1. **D1 — a derived index, not a store.** Rebuildable in seconds, disposable, never written to by any runtime.
2. **D2 — one `messages` table, FTS5 external content, one `search_sources` frontier table.** No new dependency.
3. **D10 — never traverse generically.** Every projection selects explicit fields. No `SELECT *`, no "index all text columns", no recursive JSON walk.
4. **D11 — in a table rebuildable in seconds, no column ships without a consumer.**
5. **D12 — no port while there are two mechanisms**, and a written-down trigger for when that stops being true. §3 records what the trigger did.

## Goals

- **G1** — One query box answers "where did we talk about X" across rooms, Claude Code and Codex — bare-CLI sessions included — ranked, in one list, fast enough to feel like typing.
- **G2** — The index is **derived**: `DELETE FROM messages` plus a rebuild is a complete, supported recovery, and no runtime can tell it exists.
- **G3** — **Per-source degradation.** One source that fails to project contributes zero rows and one warning — never a failed search, never a blank list. ADR-0310's "partial list + warning, never a blank screen" shape, inherited rather than reinvented.
- **G4** — **The scope is stated in the product**, not only here. A person must be able to learn what search does not cover without reading a spec.
- **G5** — `search_room_history` becomes a caller of this index, so there is exactly one search path over the room log. **[Amended 2026-07-29 (DOR-672 DECOMPOSE) — `search_room_history` is RP7's to build, not this ticket's. See Amendment 5.]**
- **G6** — An access model where **visibility is a join**, the owner path is explicit, and no agent reaches session history.

## Non-Goals

- **Not** code search. Identifiers only match under a trigram tokenizer, and adding one doubles the index to answer a question file search answers better — against files that are current, where a transcript copy is stale.
- **Not** semantic or embedding search. A different index, a model dependency, and a failure mode (plausible-but-wrong recall) that a recall tool can least afford. Lexical first; if lexical is measurably insufficient, that is evidence for the next thing, exactly as RP7 reasoned about this one.
- **Not** an MCP tool of its own in v1. The one agent-facing surface is RP7's existing `search_room_history` (§8), which is a tool that already exists rather than a new one.
- **Not** search across a remote community. §9.3.
- **Not** agent memory (DOR-632). §9.4.
- **Not** ranking beyond `bm25()` plus recency. No learned ranking, no click feedback, no personalization — all three need data this feature has to ship to collect.
- **Not** a new UI surface. The entry point is the existing command palette's own search, and `specs/rooms/02-specification.md:517`'s separation of navigation from message search still holds — §8 says how both are true.

## Technical Dependencies

- **`better-sqlite3` / SQLite 3.53.2** — already a dependency: `packages/db/package.json:21` declares the **range** `^12.11.1` (not a pin), resolving today to 12.11.1 (`pnpm-lock.yaml:8662`) as a singleton across the monorepo. A range means a minor bump can arrive without a commit here, so the FTS5 assertions in §Testing Strategy are what hold the guarantee, not the manifest. `pragma compile_options` includes `ENABLE_FTS5`; `bm25()`, `snippet()`, `highlight()` and `porter unicode61` all verified by running them. **[measured]**
- **`@dorkos/db`** — a new schema file, registered in **two** places for **two different reasons**, which an earlier draft conflated into one. `drizzle-kit` reads only the `schema` array in `packages/db/drizzle.config.ts:4-21`, so **that** registration is what makes generation see the file; omit it and `db:generate` silently ignores the table. The barrel (`packages/db/src/schema/index.ts:10-25`) is what gives `createDb()` its type inference — omit it and generation still works while every typed query against the new table fails to compile. Both are required; they fail differently.
- **A hand-written migration.** Drizzle cannot express an FTS5 virtual table — `drizzle-orm@0.45.2/sqlite-core` exports no virtual-table builder, and its only `virtual` token is generated-column mode. Raw SQL in `packages/db/drizzle/00NN_*.sql` is required. The precedent is thinner than an earlier draft implied and rests on **one** file: `0011_tasks_system_redesign.sql:1-5` is genuinely hand-authored; `0012` and `0013` are byte-identical to generated output and prove nothing.
- **`apps/server`** — a new service domain `services/search/`. Warranted under `.claude/rules/server-structure.md`: a cohesive area with several related services, not an orphan file.
- **`lib/dork-home.ts:15-21`** — the only data-directory resolver. The database is `dork.db` directly in it (`apps/server/src/index.ts:306`, `harness-boot.ts:69`). `os.homedir()` is banned.
- **No new external dependency.**

## Detailed Design

### 1. Stated scope — what is indexed, and the questions that return nothing

This section is first because it is the one a person can be surprised by, and a surprise here reads as a broken product.

#### 1.1 What is indexed

**What was said, by a person or by an agent, in prose.** One row per user or assistant message carrying non-empty text. Everything else in a transcript is deliberately absent.

**Two framings, because one of them alone would mislead.** §2.1 excludes subagent transcripts and eval-harness sandboxes, so the corpus this reads is a subset of the corpus on disk, and the share depends on which denominator you use. All figures are one snapshot, 2026-07-28; the corpus grows continuously, so they drift by tenths within a day.

|                                                 | Messages   | Text         | Share of **files v1 reads** (241 files, 671.5 MB, 192,856 lines) | Share of **everything on disk** (2,458 files, 2,771.2 MB, 448,857 lines) |
| ----------------------------------------------- | ---------- | ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **What v1 indexes**                             | **17,953** | **16.80 MB** | **9.31% of lines · 2.50% of bytes**                              | **4.00% of lines · 0.61% of bytes**                                      |
| If subagent transcripts and evals were kept too | 50,631     | 42.85 MB     | —                                                                | 11.28% of lines · 1.55% of bytes                                         |

**[operator]** reported 10.8% and 1.38%, which is the bottom row's framing — everything on disk, subagents included. **That is the number the brief carried, and it is not this design's number.** Excluding subagent transcripts and eval sandboxes makes the honest figure _smaller_, not larger: **v1 indexes 4.00% of transcript lines and 0.61% of transcript bytes.** The larger-sounding figure is the one to avoid quoting, and §1.3 is the part that actually matters to a person either way.

Everything in §1.2 below is measured over the **whole** corpus, because that is where the composition is clearest; the same proportions hold in the subset, and the per-subset figures are given where they differ materially. **Watch the denominator in every one of them** — §2.1 records a place where losing it produced a false claim in an earlier draft of this document.

#### 1.2 What is excluded, with the real numbers

| Excluded                                                                                              | Size **[measured]**                        | Why                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool results — `tool_result` blocks (981.3 MB) **plus** top-level `toolUseResult` payloads (998.9 MB) | **1,980 MB**                               | Claude Code writes each tool result **twice, in two encodings, in the same file**. This is ~71% of the corpus on its own and the single largest reason the index is small. Its content is command and file output, which file search answers against files that are current. |
| Tool calls — `tool_use` blocks                                                                        | 96.5 MB                                    | Arguments, not speech.                                                                                                                                                                                                                                                       |
| Assistant reasoning — `thinking` blocks                                                               | **57,375 blocks**, but **0.19 MB of text** | See below — this exclusion is nearly free, and saying otherwise overstates it.                                                                                                                                                                                               |
| File snapshots — `file-history-snapshot` lines                                                        | **16.0 MB** (2,551 lines)                  | A copy of a file whose current version is on disk.                                                                                                                                                                                                                           |
| `attachment` lines                                                                                    | 153.6 MB                                   | Harness plumbing: `skill_listing` (72.5 MB), `deferred_tools_delta` (29.4 MB), `hook_success` (26.3 MB). Nobody said any of it.                                                                                                                                              |

**The thinking exclusion is much cheaper than it sounds, and the spec should not take credit for a sacrifice it is not making.** The block count is right — 57,375 here against the operator's 57,357, the same number on a growing corpus. But **56,923 of them (99.2%) carry an empty `thinking` string.** Total reasoning text across the entire corpus is **0.19 MB**; what those blocks actually carry is **161.5 MB of `signature`**. So "we exclude 57,357 thinking blocks" is true and reads as a large deliberate loss; the honest form is that there is almost no reasoning text on disk to exclude.

**One number from the brief does not reproduce and is corrected here.** "177 MB of file snapshots" — `file-history-snapshot` lines total **16.0 MB**. The nearest bucket to 177 MB is `attachment` + `file-history-snapshot` = 169.6 MB; separately, `tool_result` blocks in main-session files alone come to exactly 177 MB, which is the likelier origin. The exclusion stands either way, for the reason in the table.

#### 1.3 The queries that will return nothing

Stated plainly, and repeated in user-facing copy (§Documentation, and **G4**):

- _"the error the agent showed me"_ — that was tool output.
- _"that stack trace about the port binding"_ — tool output.
- _"the diff where we changed X"_ — tool output, and the file is on disk.
- _"what the agent was thinking when it chose that"_ — reasoning, and there is almost none on disk to index even if we wanted it.

What **does** work is the thing the feature is for: what you asked, what an agent answered you in prose, and what was said in a room.

#### 1.4 Two more corrections to the brief's measurements, since they change what a reader should expect

- **`snippet()` is slower than a plain ranked query, not faster.** The brief says top-20 is 3.3 ms and 1.9 ms _with_ `snippet()`. It cannot be: `snippet()` re-reads each returned row's body from the content table and scans it for a match window, which is strictly more work than returning ids. **[measured]** at ~18k rows it is 5–9× slower on queries with real hit counts (0.49 ms → 4.55 ms; 0.67 ms → 3.64 ms) and never faster on any query tried. The absolute numbers are tiny and nothing in the design changes — but §6.3 budgets for it rather than assuming snippets are free.
- **External content is confirmed.** Building the same 18,114 rows both ways: external content **29.1 MB** vs storing the text twice **48.4 MB** — **39.9% smaller**, against the operator's 43% on the larger corpus — with query time indistinguishable (p50 **0.681 ms** vs **0.702 ms**). Two corpus sizes, two runs, same conclusion. **[measured]**

### 2. The sources, and the one that is deferred

**Three sources ship. One is deferred, and the deferral is the reason the design keeps its shape.**

| Source         | Reads                                                                                                        | Mechanism                                          | Corpus **[measured]**                    |
| -------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------- |
| `rooms`        | `room_entries` rows above a per-room `seq` watermark                                                         | **M2** — SQLite rows above a monotonic watermark   | live install                             |
| `claude-code`  | `${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<slug>/<sessionId>.jsonl`                                        | **M1** — append-only JSONL tailed at a byte offset | 241 files, 671.5 MB, **17,953 messages** |
| `codex`        | `${CODEX_HOME ?? ~/.codex}/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` and the flat `archived_sessions/` | **M1**                                             | 16 files, 6.93 MB, **223 messages**      |
| ~~`opencode`~~ | —                                                                                                            | —                                                  | deferred; 24 messages exist              |

#### 2.1 `claude-code` — main sessions only, and discovery must recurse to skip the rest

The projects root is **`$CLAUDE_CONFIG_DIR ?? ~/.claude`** (`apps/server/src/services/runtimes/claude-code/claude-config-dir.ts:31-33`), not a hardcoded `~/.claude`; that file's TSDoc says hardcoding "silently split-brains" (DOR-250), and an index that hardcodes it reintroduces the same bug. `getProjectsRoot()` appends `projects` (`sessions/transcript-reader.ts:60-62`).

**[Amended 2026-07-29 (DOR-672 DECOMPOSE, DOR-682) — resolving THE root is right for the existing caller and wrong for this index, which must enumerate roots instead. On the operator's own machine a single root covers at most 67% of their Claude Code history, and 3.5% under the environment this decomposition ran in. See Amendment 2.]**

**The directory slug is lossy and must never be used to recover a path.** `cwd.replace(/[^a-zA-Z0-9-]/g, '-')` (`transcript-reader.ts:51-53`) collapses `/`, `.` and `_` all to `-`, so it is non-invertible. The shipped reader already compensates by taking the true working directory from the JSONL head record (`:104-106`) and the projection does the same.

**Discovery recurses; indexing does not.** **[measured]**, the corpus is not flat:

| Category                                                                                                      | Files   | Bytes        | Indexed? |
| ------------------------------------------------------------------------------------------------------------- | ------- | ------------ | -------- |
| Main sessions — `<slug>/<sessionId>.jsonl`, minus the eval sandboxes below                                    | **241** | **671.5 MB** | **yes**  |
| Subagent transcripts — `<slug>/<sessionId>/subagents/**.jsonl`, nested as deep as `subagents/workflows/<wf>/` | 2,142   | 2,096.0 MB   | no       |
| **Eval-harness sandboxes** — main-session files whose `cwd` is a `dorkos-evals-*` tmpdir                      | **37**  | **2.5 MB**   | **no**   |
| Plugin artifacts — `<slug>/vercel-plugin/skill-injections.jsonl`                                              | 38      | 1.2 MB       | no       |

**Subagent transcripts are 87% of the files and 76% of the bytes, and they are excluded.** They are conversations the human never had — an agent's working notes, in which the "user" turn is another agent's prompt. The user story is "every message you have ever _sent or received_", and neither applies. The shipped adapter already drops sidechain transcripts at list level (`transcript-reader.ts:310-325,438`), so this follows precedent. Discovery still walks the tree rather than globbing `projects/*/*.jsonl`, because **a one-level glob would exclude them by accident of depth rather than by decision** — and the day someone wants them, the change is a predicate, not a rewrite.

**Eval-harness sandboxes are excluded on the same test, and they were nearly missed.** `pnpm evals:local` runs suites against a real model in a throwaway directory, and those runs write transcripts into the operator's own `~/.claude/projects` like any other session — 37 files on this machine. They are machine-generated conversations with a model in a directory that no longer exists; **by §2.1's own test, "conversations the human never had", they are the same category as the 2,142 subagent transcripts** and it would be incoherent to exclude those and keep these. A box promising "every message _you_ have ever sent or received" must not return them.

**Detection is exact, and it is the repo's own constant, not a heuristic.** The eval runner creates its sandbox as `mkdtemp(path.join(tmpdir(), SANDBOX_PREFIX))` where `SANDBOX_PREFIX = 'dorkos-evals-'` (`packages/evals/src/runner/sandbox.ts:23,59`), then `realpath`s it. So a main-session file is an eval sandbox iff its **head-record `cwd`** contains a path segment beginning `dorkos-evals-`. It must be tested against the `cwd`, never the directory slug, for the reason two paragraphs up: the slug is lossy and non-invertible. The residual is stated rather than hidden — 9 further files (17 messages) sit in other throwaway temp directories that carry no such marker, and no rule that does not guess can catch them.

**The projection must survive dirty input — but the corpus is cleaner than an earlier draft of this document claimed, and the correction is worth more than the claim was.** That draft reported "64 lines fail `JSON.parse` and 3,804 carry no `type` field" under a heading that says **main sessions only**. Both numbers were the whole corpus. Re-measured against the 241 files v1 actually reads: **0 malformed lines and 0 type-less lines.** All 3,804 type-less lines are in the 38 plugin-artifact files v1 never opens. This is the same denominator error §1.1 exists to prevent, committed in the document that establishes the rule.

**The 64 did not reproduce either, and why they did not is the useful part.** A second pass hours later found **0 malformed lines in the entire corpus**, main and subagent alike. The first pass was reading files that live agents were appending to at that moment, so what it caught was **truncated final lines in flight** — not corruption. That is direct empirical evidence for §5's partial-line rule: a reader can and does observe an incomplete last line, so retaining the trailing partial and advancing the offset only past the last complete line is not defensive programming, it is the observed case.

The projection is still written to survive a line that does not parse — skipped, counted, never aborting the file — because one bad line must not cost a session. What changes is the justification: it guards a live-append race, not a dirty corpus.

**[Amended 2026-07-29 (DOR-672 DECOMPOSE, DOR-681) — the conclusion "0 malformed" is right and BOTH stated reasons are wrong. The 64 reproduce exactly, they are not in-flight truncations, and they are not on disk at all: they are an artifact of splitting lines with Node's `readline`, which also breaks on U+2028 and U+2029. This turns a reassuring paragraph into a concrete implementation constraint. See Amendment 3.]**

#### 2.2 `codex` — the rollout files, and why no ADR is being broken

`codex-runtime.ts:732` says _"No byte-addressable transcript exists — rollout files are SDK-internal."_ That is a TSDoc on one stub method explaining why it returns nothing. It carries no rationale and no enforcement, and it is **a different tier from ADR-0308:24** — a Decision line with an ESLint rule behind it. ADR-0309, the codex adapter's own ADR, mentions the path (`:18`) and the SDK's inability to list or read threads (`:20`, `:24`), and frames resume as continuity _"without DorkOS owning transcript storage"_ (`:31`); every line is about SDK incapacity or ownership, none about reading. **The phrase "never read or written directly" occurs exactly once in the whole decisions corpus, and it is about OpenCode.**

**Absence of a prohibition is not authorization**, which is why the coupling is a recorded decision (ADR `260728-214214`) rather than an assumption. What makes it cheap is the format, **[measured]** over 2,114 lines with **zero malformed**:

- **Whole messages, no deltas.** Role at `payload.role`, text at `payload.content[].text`, and a top-level `timestamp` on **2,114 of 2,114 lines**. No stateful fold — the exact inverse of §2.4's rejected candidate.
- **Append-only, one file per session.** One `session_meta`, always line 1; 16 session ids, none in two files; timestamps monotonic within every file; **file mtime equals the last record's timestamp on 16 of 16 files.**
- **Working directory** from `session_meta.payload.cwd` (16/16), and per-turn from `turn_context.payload.cwd`.
- **One trap, named so it is not discovered:** the same messages appear in **two families** — `response_item` (144 assistant, 79 user) and `event_msg` (144 `agent_message`, 59 `user_message`). The projection reads `response_item` **only**. Reading both double-counts every message.

Codex adds 223 messages to 17,953 — about 1.2%. **The case for it is not volume.** The multi-runtime cockpit is the product's headline differentiator, and a search box that covers one runtime undercuts the claim the product leads with. One ~20-line projection inside an existing mechanism is the whole cost.

#### 2.3 `opencode` — deferred, on four counts

ADR-0308:24 forbids the direct read: _"OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly."_ **The security rule in §9.1 and that ADR converge, and the ADR got there first** — `opencode.db` holding `account.access_token`, `account.refresh_token` and `credential.value` beside its message tables is evidence the ADR was right, not grounds for an exception. Two further facts make the direct read wrong on its own terms: message text lives in opaque JSON `data` blobs on `message`, `part` and `session_message`, so indexing means parsing a private schema; and the file is in WAL mode against a store `:37` records as having upstream reliability issues.

So the SDK path was evaluated, because "read it the way the adapter already does" is the obvious rescue. **It fails on four counts of its own:**

1. **A background read has to spawn someone else's agent server.** Nothing boots the sidecar at startup (`apps/server/src/index.ts:626-654`, "The sidecar spawns lazily on first use"), and `check-dependencies.ts:12-14` refuses even to probe because _"a cold probe would spawn a server as a side effect."_ The adapter has two accessors for exactly this distinction: `peekClient()` never boots and returns `null` when cold; `getClient()` boots (`session-mapper.ts:59-76`). A reconciler on a timer must therefore spawn a child process purely to read — 15 s startup budget, six-attempt restart ladder, one cached instance per directory with no idle eviction (`server-manager.ts:53-66`; `NOTES.md:38-43`) — or throw on every tick. On this machine the binary is not installed, so `boot()` throws at `server-manager.ts:204-206`. **Every other source in this design reads bytes already at rest.**
2. **The corpus is 24 messages.** Counts only, from a copy opened read-only: `session` 6, `message` 24, `part` 73.
3. **The pinned v1 SDK is stale against the server it drives.** The server supports `before` (message keyset), `start` (sessions-updated-since) and `scope: 'project'`; none is in the pinned v1 types, so (a) would get whole-session re-reads and exact-directory-only listing. Fixing that means revisiting ADR-0308's "build on v1", which is a larger decision than this feature should be making.
4. **It would be the third mechanism** (§3), which under D12 promotes the whole shape to a port. Doing that for 24 messages is the tail wagging the dog.

**Two live adapter bugs surfaced while establishing this, and they are search-independent** — they deserve their own tickets: `client.session.list` has a **server-side default cap of 100** that DorkOS never overrides, so an install with more than 100 OpenCode sessions in one project silently loses the oldest from the session list; and its directory filter is **exact string equality**, so a session started in `<repo>/apps/server` is invisible to `listSessions('<repo>')`.

**What the follow-up ticket inherits.** The SDK-surface decision (widen v1 types, adopt the v2 types against the same URL, or wait for `/experimental/session`) blocks everything else. Whether the reconciler may boot the sidecar or is `peekClient()`-gated is a product decision, not an implementation one — a `peekClient()`-only indexer is cheap and safe but makes coverage nondeterministic, which is the wrong trade for a feature promising recall. And one caveat must be written down before anyone polls: **`Session.time.updated` is stamped at turn start, not on message write** (`prompt.ts:1160-1161` in the local OpenCode snapshot; `updateMessage`/`updatePart` never patch it — the line is version-drifted, the behaviour is not), so a naive `updated > lastSeen` poll misses the assistant half of any turn in flight. The watermark must be `>=`, plus a forced re-read of any session last seen non-idle. The projection itself is already written (`session-mapper.ts:201-246`).

#### 2.4 The DorkOS event log — rejected, recorded so it is not re-proposed

`packages/db/src/schema/session-events.ts` is DorkOS-owned, which makes it the tempting answer for codex. It fails on four counts and the rejection is recorded because it is the option a reader will otherwise propose:

- **Coverage.** 455 rows across **2 sessions**, from one afternoon, against 2,458 Claude Code transcripts on the same machine. The dev database has **0 rows**. Claude Code never writes there at all (`session-events.ts:3-5`).
- **It is trimmed, permanently.** `EVENT_LOG_MAX_EVENTS = 5000` per session (`event-log.ts:26`), applied inside `appendTurn` (`session-event-store.ts:91`, `:167-182`). JSONL can be trimmed too, but there the original is still on disk to re-read; here the trimmed table **is** the original. An index over it would lose exactly the history the index exists to preserve, and a rebuild would not bring it back.
- **The shape is wrong for a per-row projection.** Assistant text arrives as `text_delta` fragments carrying no message identity (`session-stream.ts:206`; `schemas.ts:517-521`), folded by `event-log-history.ts:126-128` — **256 of 455 production rows**. A row in isolation is not a searchable unit.
- **No usable timestamp.** `created_at` is computed once per `appendTurn` (`session-event-store.ts:83`), so 455 rows carry **9 distinct values** — turn flush time, not message time. No payload carries one.

### 3. Two mechanisms, one registry array, and a trigger that is now armed

**M1 — append-only JSONL tailed at a byte offset.** Discovery walks a root; change is `(size, mtime)` against the frontier; incremental read resumes at the stored byte offset. `claude-code` and `codex` share it.

**M2 — SQLite rows above a monotonic watermark.** Discovery is the container list; change is `max(seq) > frontier`; incremental read is `WHERE seq > ?`. `rooms` uses it, and any future DorkOS-owned table would.

**A source is one row in a registry array plus one pure projection.** The registry row names the source id, its mechanism, its root resolver and its projection; nothing else varies. That is why there is no `TranscriptSource` port: a port abstracting two mechanisms and three functions is a class hierarchy standing where a record would do.

**The trigger fired once during SPECIFY, and the design survived for a different reason than expected.** IDEATE's D12 held that SDK-mediated reads would keep OpenCode inside M2. **That was wrong.** Take the three axes the two mechanisms share and add the one they both take for granted:

|                      | M1 (JSONL tail)       | M2 (SQLite watermark) | OpenCode SDK poll                                  |
| -------------------- | --------------------- | --------------------- | -------------------------------------------------- |
| unit                 | file                  | row                   | session                                            |
| change signal        | `(size, mtime)`       | monotonic column      | `time.updated`, advisory and stamped at turn start |
| **incremental read** | resume at byte offset | `WHERE seq > ?`       | **re-fetch a bounded tail and dedupe by id**       |
| **precondition**     | none                  | none                  | **a child process must be alive**                  |

Both shipping mechanisms have a **resumption primitive**: a position handed back to the source, which returns only what is past it. An SDK poll has none — `session.messages` pages backwards from newest, so "what is new" is not expressible; you re-read and diff, which makes per-poll cost a function of session length rather than of new content. And "can I read?" becomes a lifecycle question rather than a filesystem one. That is a third mechanism.

**So the reason there is no port is §2.3, not the SDK.** The source that would have introduced the third mechanism is deferred. **The day OpenCode is indexed, the promotion fires** — that is not a caveat, it is the trigger the design named, and it is written here so the next author inherits a decision rather than an accretion.

### 4. Data model

Two tables and one virtual table. One migration, hand-written, because Drizzle cannot express an FTS5 virtual table.

```sql
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,          -- FTS5 external-content rowid
  source_id   TEXT    NOT NULL,             -- 'rooms' | 'claude-code' | 'codex'
  origin_key  TEXT    NOT NULL,             -- OPAQUE. The container, composed by the projection.
  ordinal     INTEGER NOT NULL,             -- position within the container, monotonic
  role        TEXT    NOT NULL,             -- 'user' | 'assistant'
  created_at  TEXT,                         -- ISO-8601, nullable: not every source has one
  body        TEXT    NOT NULL,
  UNIQUE (source_id, origin_key, ordinal)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  body,                                     -- MUST be named `body` — see below
  content='messages', content_rowid='id',
  tokenize='porter unicode61'
);
```

**`origin_key` is a single opaque string the projection composes, never a foreign key and never parsed by the index.** This is the one design property that has to be defended, because it is what lets the schema survive changes it cannot see coming. The room projection sets `origin_key = roomId` today; when `communityRef` lands it composes `` `${communityRef}:${roomId}` `` and nothing else changes — not the schema, not the query, not the ranking, not the frontier. `specs/community-adapter/02-specification.md` requires `room_entries`' `(roomId, seq)` primary key to be re-scoped and **never states the target shape**, so an index that depended on the shape would be betting on a decision nobody has made. The two tempting alternatives both fail: a separate indexed `community_ref` column is a second thing to keep in sync and re-indexes a whole community on rename; leaving `origin_key = roomId` assumes room ids are globally unique, which is exactly the assumption that re-scoping exists to retire.

**`origin_key`, `ordinal` and the container path, defined for every source — not just for rooms.** An earlier draft defined the composition only for `rooms`, which left Phase 3 and Phase 5 to invent it for the two runtimes under implementation pressure. It is settled here:

| Source        | `origin_key`                                       | `ordinal`                                    | Container path (on `search_sources`)                     |
| ------------- | -------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `rooms`       | `roomId` — later `` `${communityRef}:${roomId}` `` | `room_entries.seq`                           | `NULL`. A room is not a directory.                       |
| `claude-code` | the session id (the JSONL filename stem)           | index of the message within the file         | the head record's `cwd` (`transcript-reader.ts:104-106`) |
| `codex`       | the session id from `session_meta`                 | index of the `response_item` within the file | `session_meta.payload.cwd`                               |

**The container path lives on `search_sources`, one row per container, and deliberately not on `messages`.** Opening a session hit needs a working directory, and the slug cannot supply one (§2.1) — so the path has to be stored. But it is a per-container constant, and repeating it on all 17,953 message rows to save one join is the denormalization that later disagrees with itself. `search_sources` is already keyed `(source_id, origin_key)`, which is exactly the container, so the column costs nothing new. This is also why D11 is not violated: **no column is added to `messages`.** The same reasoning `specs/community-adapter/02-specification.md` §1 used to put `label` on `CommunityDescriptor` rather than on every `CommunityRoom`.

**The FTS5 column must be named `body`, matching the content table's column.** With `content='messages'`, FTS5 re-reads the original text from the content table **by column name**. Get it wrong and `MATCH` and `bm25()` keep working while `snippet()` and `highlight()` fail at runtime with `SQL logic error` — a failure a MATCH-only test passes straight through. **[measured]** deliberately, against a mismatched name.

**No column ships without a consumer** (D11). `role` is rendered and filtered; `created_at` orders and displays; `source_id` labels a result and scopes the frontier; `origin_key` and `ordinal` are the navigation coordinates, resolved to a directory through `search_sources.container_path`. Two columns proposed during design were cut under this rule. Widening later is one projection change and a rebuild — **2.69 s** over the v1 corpus **[measured]** — not a migration.

```sql
CREATE TABLE search_sources (
  source_id      TEXT NOT NULL,
  origin_key     TEXT NOT NULL,
  byte_offset    INTEGER,        -- M1 only
  size_bytes     INTEGER,        -- M1: shrink detection
  mtime_ms       INTEGER,        -- M1: cheap change signal
  last_ordinal   INTEGER,        -- M2: the watermark
  container_path TEXT,           -- the cwd a hit opens in; NULL for sources with no directory
  last_indexed_at TEXT NOT NULL,
  last_error     TEXT,           -- makes "produced nothing" visible, not silent
  PRIMARY KEY (source_id, origin_key)
);
```

`last_error` is not decoration. ADR `260728-214214`'s sharpest recorded negative is that a projection broken by an upstream format change **fails silently** — a source that stops contributing rows is indistinguishable from a source with nothing new. This column is what makes the difference observable, and §Testing Strategy asserts it.

### 5. Change detection, and why there are two signals rather than eight

CTX's change-signal taxonomy — reviewed at source by the operator during design, and worth stealing where the tool itself was declined (`01-ideation.md` §5.6) — has eight members. **Six have zero observed instances in the measured corpus**, so this design carries two: **a file grew** (`size` increased) and **a file appeared**. Everything else is a rebuild.

**Compaction is append-only, measured twice.** **[measured]**: 28 of 2,458 files carry `isCompactSummary` markers, 74 marker lines in total, and **all 28 have content after the last marker** — zero files end at one. The largest carries 16 markers across 25,361 lines with 156 lines still after the last. So a compact boundary is a line in a growing file, not a rewrite, and the byte offset survives it. **[operator]** measured the same 28-of-2,458 independently.

**`relocated` is a line, not a file move.** **[measured]** 543 lines of `type: 'relocated'`, matching the operator's 543 exactly. It records a working-directory change _inside_ the file. Reading it as a move — which the name invites — would trigger a spurious re-index of a file that never went anywhere.

**Shrink means rebuild that file.** A file smaller than its recorded `size_bytes` has been truncated or replaced; the frontier row is reset and the file re-read from zero. This costs milliseconds and is the only correct answer, since a byte offset into a rewritten file points at the middle of a line.

**Line boundaries are the reader's problem, and the shipped `readFromOffset` does not solve them.** It advances `newOffset` to `stat.size` unconditionally (`transcript-reader.ts:599-611`), so a read landing mid-line returns a truncated final record _and consumes its bytes_. It is also claude-path-shaped — `getTranscriptsDir(vaultRoot) + '/' + sessionId + '.jsonl'` (`:65-67`) cannot express a codex rollout path, where the id is inside a filename behind a date prefix — allocates the whole delta into one buffer, and **has no production consumer at all**. What transfers is the `(mtimeMs, size)` idea from `getTranscriptETag` (`:507`), which is two lines. The JSONL frontier reader is new code: it retains any trailing partial line and advances the offset only past the last complete one.

**The reconciler runs at 300,000 ms**, matching the three that already exist (`mesh-core.ts:391`, `task-reconciler.ts:16`, `workspace-reconciler.ts:15`), plus a startup sweep, plus an immediate write-through on the room path where DorkOS already owns the write. ADR-0043's accepted trade-off — up to five minutes of staleness — is inherited deliberately.

**[Amended 2026-07-29 (DOR-680) — the write-through was not built, and is deferred rather than dropped. The reconciler and the startup sweep shipped. See Amendment 6.]**

### 6. Query, ranking, and prune

#### 6.1 The query

```sql
SELECT m.id, m.source_id, m.origin_key, m.ordinal, m.role, m.created_at,
       snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS excerpt
FROM messages_fts f
JOIN messages m ON m.id = f.rowid
WHERE messages_fts MATCH ?
  -- Owner path: this whole clause is omitted rather than filled with everything.
  -- Agent path: sources are enumerated explicitly, never defaulted.
  AND m.source_id = 'rooms'
  AND m.origin_key IN (/* the caller's visible room keys, §7 */)
ORDER BY bm25(messages_fts)
LIMIT 20;
```

**The visibility clause is scoped by `source_id` as well as `origin_key`, and that is not cosmetic.** `origin_key` is opaque and composed per source (§4), so it is unique _within_ a source and carries no guarantee across sources — a bare `origin_key IN (...)` would let a room key collide with a session key and leak a session row to an agent. The agent path therefore names its source explicitly. **The owner path omits the clause entirely** rather than building a set of every container: a filter that has to enumerate everything is a filter that silently starts excluding things the day enumeration misses one.

**[Amended 2026-08-24 (DOR-684) — the agent path is not one `IN (...)` list with one floor: the visible set is `(roomId, joinedSeq)` PAIRS, applied as a floor PER container. See Amendment 7.]**

Ranking is `bm25()` alone in v1, with recency available as a tiebreak. Learned ranking and click feedback need data this feature has to ship to collect.

#### 6.2 What the tokenizer buys and costs

`porter unicode61`, one index, no trigram. **[measured]**: `dogs` returns **1** hit under `unicode61` and **3** under `porter unicode61` against a corpus containing "dog", "dogs" and "DOGGED". Stemming is what makes the user story work — a person types the word they remember, not the form that was written.

The cost is precise and belongs in the user-facing copy §Documentation requires: **a fragment that is not a word finds nothing.** `ogs` matched `dogs` under RP7's substring scan; it does not here. Prefix (`dog*`), phrase (`"pack of dogs"`), boolean and `NEAR` all work.

#### 6.3 Latency budget

**[measured]** at ~18k rows: top-20 ranked **0.02–0.67 ms** p50; **with `snippet()` 0.21–4.55 ms**. **[operator]** at 500k rows: **3.3 ms**. Snippets cost 5–9× on queries with real hit counts (§1.4), so the budget is set from the `snippet()` column, not the bare one. Both are far inside a keystroke, and the design has headroom of more than an order of magnitude before anything needs revisiting.

**[Amended 2026-07-29 (DOR-672 DECOMPOSE, DOR-684) — the last sentence is wrong, and the figures above are a best case rather than a budget. `ORDER BY bm25()` is O(hits), not O(limit). See Amendment 1.]**

#### 6.4 Prune — two different things that a single word hides

**Prune is not optional**, but the rule the brief carried conflates two cases that must be handled differently.

- **The source file is gone.** Its frontier row and its `messages` rows are deleted. Otherwise the index serves messages from a transcript that no longer exists, and — worse — an incremental index and a rebuilt one silently disagree, which is exactly the drift ADR-0043's reconciler exists to catch.
- **The source file is intact but its working directory is gone.** **These must not be pruned.** The conversation happened, the transcript is on disk, and "what did we decide in that worktree" is precisely the question this feature exists to answer. What changes is not the row but the _result_: the hit is still returned and still readable, and its open action reports that the directory is gone instead of failing on a path. That is what `search_sources.container_path` (§4) is for.

**The measured distribution, restated — an earlier draft of this paragraph was wrong in both of its headline claims, and the rule survives anyway.** That draft said "70 of 278 sessions — 25% — and every one of them is a removed worktree." Neither half held. Within the 241 files v1 indexes, **33 have a vanished `cwd`**, and they are not one thing:

| Where the vanished `cwd` pointed                                   | Files  | Indexed messages |
| ------------------------------------------------------------------ | ------ | ---------------- |
| Legacy `.claude/worktrees/` in two repos                           | 12     | 209              |
| `~/.dork/workspaces/…` — the path the draft named as _all_ of them | 12     | 62               |
| Other throwaway temp directories and fixtures                      | 9      | 17               |
| **Total**                                                          | **33** | **288**          |

Two corrections, and the second is the one that matters. Removed worktrees are **12 of 33**, not all of them — and the largest group is a _legacy_ worktree layout that has since been replaced, which is a different fact with a different lifetime. And "a quarter of the operator's history" was 25% of **files**; by messages it is **288 of 17,953 — 1.60%**, an order of magnitude smaller on the dimension the sentence was actually about. (The draft's 70 files included the 37 eval sandboxes §2.1 now excludes outright, which is why the count moved as well.)

**So the argument is no longer "this would delete a quarter of your history."** It is smaller and it is sufficient: pruning on a missing directory would silently delete 288 real messages the operator can still read on disk, to tidy up a navigation edge case that a nullable column already handles. A rule that deletes recoverable data to avoid rendering a caveat is the wrong trade at any percentage — which is the form the argument should have taken in the first place, instead of resting on a number that turned out to be wrong.

### Code structure & file organization

```
packages/db/src/schema/search.ts                 # messages, search_sources (Drizzle)
packages/db/src/schema/index.ts                  # + barrel export
packages/db/drizzle.config.ts                    # + the same file again, or generate never sees it
packages/db/drizzle/00NN_message_search.sql      # hand-written: FTS5 virtual table + triggers
apps/server/src/services/search/
  index.ts                                       # barrel + factory
  registry.ts                                    # the source array: id, mechanism, root, projection
  jsonl-frontier.ts                              # M1: line-boundary-safe tail, shrink detection
  row-frontier.ts                                # M2: rows above a watermark
  projections/
    rooms.ts  claude-code.ts  codex.ts           # ~20 lines each, pure
  indexer.ts                                     # the reconciler + startup sweep
  search-service.ts                              # query, ranking, the visible-set join
  __tests__/
apps/server/src/routes/search.ts                 # one route
```

Projections are **pure functions with no filesystem and no database access** — they take parsed input and return rows. That is what makes them table-testable, and it is the property that keeps "adding a source" honest at one function.

### API changes

**One route.** `GET /api/search?q=<query>&limit=<n>&source=<id>` returns `{ results: SearchHit[], warnings: SourceWarning[] }`. `warnings[]` is ADR-0310's envelope, reused rather than reinvented: a source whose projection failed contributes zero hits and one warning naming it, never a failed request and never a blank list.

No existing route changes. `search_room_history` is an MCP tool, not a route, and it is `specs/room-participation` §10.3's to land.

### Data model changes

Two new tables and one virtual table, all in §4. **No existing table is altered** — every source is read where it already lives, and the room source reads `room_entries` without touching its schema. This is the property that makes the index deletable.

## User Experience

### 7. The access model — visibility is a join, never a token

| Caller                       | Rooms                                | Sessions (including bare-CLI) |
| ---------------------------- | ------------------------------------ | ----------------------------- |
| The operator, in the cockpit | all                                  | all                           |
| An agent, over MCP           | member-only, at or after `joinedSeq` | **none**                      |

**Visibility is resolved to a set of containers and applied as a join** — `source_id = 'rooms' AND origin_key IN (...)`, source-scoped for the reason §6.1 gives. The owner path skips the clause entirely rather than building a set of everything. **Materializing the ACL into the index as facet tokens was considered and rejected**: it would force re-indexing every message in a room each time somebody joined it, which turns a membership change into an O(room) write.

**Sessions are owner-only in v1, and the evidence is two open tickets.**

- **DOR-514** — `apps/server/src/services/core/mcp-server.ts:81-84` resolves one Relay sender identity for the whole external MCP surface, and `runtimes/claude-code/mcp-tools/relay-helpers.ts:11,56` shows what it resolves to: `EXTERNAL_MCP_SENDER = 'relay.external.mcp'`. **Correction to the brief:** the lines are `81-84`, not `82-85`, the literal lives in `relay-helpers.ts` rather than `mcp-server.ts`, and the collapse is **Relay-specific** — an external caller presenting `X-DorkOS-Agent` _is_ individually attributed for tool gating and capability invocation (`mcp-server.ts:73,90,110`; `routes/mcp.ts:33`). The hole is narrower than the brief said and still disqualifying for session history.
- **The DOR-505 residual** — `middleware/agent-identity.ts:11-17` states the posture: _"This middleware never rejects a request … identity is attribution, not authorization."_ A caller omitting the header falls through every branch to `next()` and resolves at `routes/room-caller.ts:70` to the install owner. **And the owner sees everything**: `services/rooms/room-service.ts:797-816` — _"the owner may see every room."_ So on the default login-off posture, a local program that simply omits a header would get an exhaustive, ranked, cross-runtime reader of the operator's entire history. **Absence is never consent** (ADR `260727-181825:54`; DOR-604 is the sweep that applied it, and both are cited because the maxim is the ADR's).

**Structurally, `resolveCaller` cannot serve an MCP tool at all.** It takes an Express `Response` (`room-caller.ts:55`) and MCP handlers never receive one — `createExternalMcpServer` is handed an `AgentIdentity`. There are also **no room tools on any MCP surface today**, so RP7's `search_room_history` will be the first, arriving with no `resolveCaller` equivalent.

**The precondition for unlocking session search is written down rather than left to be discovered:** `resolveCaller` becomes MCP-aware **and** session membership becomes a defined concept. Until both, this is a decision with a stated trigger, not an omission.

**One access rule this index depends on does not exist yet.** **Correction to the brief:** `joinedSeq` is **specced, not shipped** — `room_members` has `joined_at` (text) and `last_read_seq` (`packages/db/src/schema/rooms.ts:134-149`), and no `joined_seq` column appears in any migration under `packages/db/drizzle/`. RP7's §8.3 specs it and RP3 lands it. The consequence is recorded in `specs/room-participation/02-specification.md` §10.3 and in its phasing table: **RP7 now depends on RP3 as well as on this index**, because an index-backed `search_room_history` shipped before `joinedSeq` exists would hand an agent a fast, ranked reader of everything said in its rooms before it joined.

**[Amended 2026-08-24 (DOR-684) — `joinedSeq` exists now. RP3 landed `room_members.joined_seq`, so this paragraph's premise is false and the floor it describes is the one DOR-684 applies. See Amendment 7.]**

### 8. Surfaces

**The entry point is the command palette's existing search, and `specs/rooms/02-specification.md:517` still holds.** That paragraph carried two independent arguments; the amendment to that spec's §13.2 separates them. The UX-separation argument — Slack keeps `Cmd+K` and `Cmd+F` apart, Teams merged them and is the cautionary example — is untouched and load-bearing. Only the cost argument ("we have no message index") expires. **Navigation and message search remain different surfaces**; this feature is the second one, not an addition to the first.

**`search_room_history` becomes a caller** (`specs/room-participation/02-specification.md` §10.3). There is exactly one search path over the room log, because two paths over the same rows that answer differently is the tolerated legacy pattern AGENTS.md refuses. The substring scan is never written, so the conversion is never a follow-up. **[Amended 2026-07-29 (DOR-672 DECOMPOSE) — `search_room_history` is RP7's to build, not this ticket's. See Amendment 5.]**

**A result carries what it needs to be opened**: source, container, ordinal, role, timestamp, and a `snippet()` excerpt with the match marked. A result whose working directory no longer exists is still shown, and says so (§6.4).

## Testing Strategy

- **Unit — projections.** Each is a pure function over parsed lines or rows, so each gets a table-driven test: a well-formed message, an empty-text message (skipped), a `tool_result`-bearing user record (its sibling text suppressed, per `transcript-parser.ts:321-331`), a `thinking` block (skipped), a malformed line (skipped and counted, file continues), and — for codex — **a fixture containing both `response_item` and `event_msg` for the same message, asserting exactly one row**. That last one is the double-count trap in §2.2 and it is the test most likely to catch a real regression.
- **Unit — the frontier.** A file that grew (resume at offset, no duplicates); a file that grew by half a line (the partial is retained, the offset advances only past the last complete line); a file that shrank (row reset, full re-read); a file that vanished (rows deleted); a file whose cwd vanished but which is intact (**rows kept** — the §6.4 asymmetry, and the one a well-meaning cleanup would get wrong).
- **Unit — compaction.** A fixture with a compact-summary marker followed by content, asserting the marker is not treated as a truncation and post-marker messages are indexed.
- **Integration — rebuild equals incremental.** Index a fixture corpus incrementally in several passes, then rebuild from scratch, and assert the two `messages` tables are identical. This is the single highest-value test in the suite: it is what makes "delete and rebuild" a trustworthy recovery rather than a hope.
- **Integration — FTS5 behaviour that a naive test misses.** Assert `snippet()` returns text (the §4 column-name trap passes a MATCH-only test); assert `dogs` matches `dog`/`dogs`/`DOGGED`; assert the trigger keeps the index in sync across `UPDATE` and `DELETE`; assert `PRAGMA integrity-check` after mutations.
- **Integration — access.** The owner sees every room; a member sees only theirs; a non-member searching a room's content gets zero results and **the same response as a room that does not exist**; no caller reaches session rows over MCP.
- **Migration.** The hand-written migration applies through the real Drizzle migrator, and `bash scripts/assert-migrations-current.sh` stays green. The snapshot chain is the trap: copying the previous snapshot verbatim fails with a parent-collision **and exits 0**, so the new snapshot needs a fresh `id` with `prevId` pointing at the previous one, plus a `_journal.json` entry. `.github/workflows/db-check.yml:80` is explicit that "what no gate here can check is whether a hand-written **data** migration is CORRECT." Quoted exactly, because dropping that word would widen the sentence to cover this case; a hand-written **schema** migration is if anything less checkable, so the point holds — but it holds by extension, not by quotation. The rebuild-equals-incremental test is what actually checks this one.
- **No e2e in this spec.** The palette surface is where a browser test earns its place, and it lands with that work.

## Performance Considerations

- **Rebuild is the correctness mechanism, and it is affordable.** **[measured]** 2.69 s over the v1 corpus (241 files, 671.5 MB) producing 17,953 messages and 29.2 MB; **[operator]** 8.25 s over the full 2,911 MB corpus. Both are inside the budget that makes "delete it and rebuild" the first answer to drift rather than the last.
- **Steady state is an append.** **[operator]** p50 0.07 ms at 494k rows inside a batch; **[measured]** 1.29 ms for a single row in its own transaction at ~18k rows — the difference is one WAL commit, which is why the reconciler batches one transaction per file rather than one per row.
- **Query is not the constraint** (§6.3), and `snippet()` is the term to watch, not `bm25()`. **[Amended 2026-07-29 — half right. `snippet()` is a constant multiplier; `bm25()` ordering is the term that scales with corpus size, and it is the one that will bite first. Amendment 1.]**
- **Index size is small because scope is small.** 29.2 MB for 17,953 messages **[measured]**; external content is what keeps it there (§1.4).
- **No new hot path.** Nothing here runs per turn. The room source write-through is one insert on a path that already writes a row.

## Security Considerations

### 9.1 Never traverse generically

**Every projection selects explicit fields. No `SELECT *`, no "index all text columns", no recursive JSON walk.** The counter-example is concrete: `opencode.db` holds `account.access_token`, `account.refresh_token` and `credential.value` in the same database as its messages, so a generic indexer over it would write live OAuth tokens into a searchable table. §2.3 removes that file from reach entirely — **the strongest form of the rule is not opening the file** — and the rule still governs every source that is read.

### 9.2 A community that ejects you must not remain searchable

Normative, and amended into `specs/community-adapter/02-specification.md` §5: **a `'not-admitted'` connection result deletes that community's message-index rows in the same transaction as the room-cache invalidation.** Two statements instead of one leaves a searchable orphan whose room no longer exists to re-check membership against. It is worse than the failure that rule already prevents: a stale room is something the reader clicks and is refused, while a stale search result **is the message body itself**, already rendered, with a snippet around the match. The index being derived is why recovery is cheap; it is not a reason to let it lag, because a stale derived row is indistinguishable from a live one at the point of reading.

### 9.3 Remote community search is a different trust model

v1 searches the local cache only. **Searching a remote community means a server you do not control ranks results you cannot verify** — and a ranking is not a page of entries: what you do not find is invisible, and NIP-50's one-shot `REQ` offers no way to check what was withheld. That is a different decision from the one this spec is making, recorded as a deliberate deferral in `specs/community-adapter/02-specification.md`'s Non-Goals with the shape a future `search` capability flag would take.

**Communities get search anyway, from the other direction.** Remote messages cached in `rooms` / `room_entries` are indexed by the same projection that indexes local rooms, because the index reads the cache and cannot tell where a cached row came from. That is a consequence of caching, not a port capability — and §9.2 is the obligation that arrives with it.

### 9.4 Search is not memory

DOR-632 ("An agent re-learns the operator from scratch in every room") is recall **for an agent**; this is recall **for a human**. They want different corpora, different ranking, different access rules and different latency budgets. Conflating them drags a shippable feature into a harder problem, and the access model is where the difference bites hardest: §7 gives an agent strictly less than it gives the operator, which is the opposite of what a memory system needs.

### 9.5 A room id is still not a capability

`services/rooms/room-service.ts:789-804` reports `ROOM_NOT_FOUND` identically for "no such room" and "not visible to you", so a probe cannot distinguish them. Search must not become the oracle that distinguishes them: a query scoped to a room the caller cannot see returns the same empty result as a query scoped to a room that does not exist. **A room id is not a capability, and neither is a query string.**

## Documentation

- **`contributing/` — a short guide on adding a source**: the registry row, the projection contract, which mechanism to pick, and the port trigger in §3. The single most valuable artifact for whoever indexes OpenCode.
- **User-facing copy** stating the scope (§1.3) wherever search is used. This is a product commitment, not a docs task: **G4** says a person must be able to learn what search does not cover without reading a spec.
- **`AGENTS.md`** — one line once this ships, not before. The demo-claim gate.
- **No changelog fragment in this spec.** Nothing user-facing ships here, and the gate agrees: the fragment requirement keys on `feat` / `fix` / `refactor` / `perf` commit types (`.github/workflows/changelog-fragment-check.yml`), and `changelog_backfill.py --validate --changed-only` reports clean. The fragment lands with the implementation.

## Implementation Phases

- **Phase 1 — the table and the migration.** Schema file, registered in **both** the barrel and `drizzle.config.ts`; the hand-written FTS5 migration with its snapshot chain; the migration test. No projections, no reader.
- **Phase 2 — the room source, end to end.** M2, the frontier, the reconciler, write-through, and the rebuild-equals-incremental test. Rooms first because DorkOS owns the write, so any bug here is ours and cheap to see.
- **Phase 3 — the JSONL mechanism and `claude-code`.** M1's frontier reader (line-boundary retention, shrink detection), recursive discovery that excludes subagent transcripts by decision, the projection, and the dirty-input tests. This is where the corpus and the value are.
- **Phase 4 — `codex`.** One registry row and one projection, plus the two-families double-count test.
- **Phase 5 — query, access, and the surfaces.** The route, the visible-set join, the palette entry point, and `search_room_history` as a caller. RP7's own dependency on RP3 (`joinedSeq`) gates the agent-facing half. **[Amended 2026-07-29 (DOR-672 DECOMPOSE) — `search_room_history` is RP7's to build, not this ticket's. See Amendment 5.]**

**OpenCode is not a phase here.** It is a follow-up ticket with a named blocker (§2.3), and it is the ticket that will decide whether this shape becomes a port.

## Open Questions

All resolved during SPECIFY; kept with their answers so the reasoning is auditable.

- ~~**Should the index read codex rollout files, or DorkOS's own event log?** (RESOLVED)~~ **Answer: the rollout files.** The event log fails on coverage, permanent trimming, delta shape and timestamps (§2.4), and no ADR forbids the rollout files (§2.2). **Rationale for recording it rather than just choosing:** the event log is the answer a reader reaches for first precisely because it is DorkOS-owned, and its four disqualifiers are only visible from measurements nobody would take twice.
- ~~**Should OpenCode ship in v1 through the SDK?** (RESOLVED)~~ **Answer: no, deferred.** §2.3. **Rationale:** this reverses a design-time ruling that all four sources ship, and it should be reversed — the positioning argument for covering every runtime is real, but an accepted ADR beats positioning, and the SDK rescue turned out to fail on four counts having nothing to do with ADR-0308. A v1 that honestly covers rooms, Claude Code and Codex and says why OpenCode is missing is better than one that quietly breaks a decision.
- ~~**Does this design comply with ADR-0310's "must fan out per runtime rather than query one store" bullet, or contradict it?** (RESOLVED)~~ **Answer: it contradicts the letter and complies with the intent, and it is recorded as an amendment.** §Background, and ADR `260728-214214`'s Status. **Rationale:** the comfortable reading — that the bullet sits under _Negative consequences_ and is therefore descriptive — is lawyering. That ADR's Decision had already said storage stays runtime-owned; if the bullet merely restated it, it would be redundant. It is the only mechanism prohibition in the whole Consequences block and it names global search by name. Claiming compliance would leave a reviewer holding both documents and a contradiction. **Anchored by clause text rather than by line throughout this change, because this same commit edits that file** and every line number in it moves.
- ~~**Are subagent transcripts in scope?** (RESOLVED)~~ **Answer: no, and discovery still recurses.** §2.1. **Rationale:** they are 87% of files and 76% of bytes, and they are conversations the human never had; excluding them by decision rather than by glob depth is what makes the choice reversible.
- ~~**Does `snippet()` need its own budget?** (RESOLVED)~~ **Answer: yes.** §1.4, §6.3.

## Related ADRs

- **ADR `260728-214214`** — this spec's decision. Partially supersedes ADR-0310's "must fan out per runtime rather than query one store" bullet.
- **ADR-0310** — runtime-owned session storage with registry-aggregated listing. Governs, minus one clause; its per-runtime degradation consequence ("a slow/failed runtime must degrade gracefully") is inherited by the index.
- **ADR-0308** — the OpenCode adapter's managed sidecar, and the reason `opencode.db` is never opened.
- **ADR-0043** — file-canonical truth with a derived cache and a reconciler. The shape this follows.
- **ADR-0263** — "own the boundary, not the bytes."
- **ADR `260717-001410`** — the recent-sessions fan-out endpoint that predicted this cache.
- **ADR `260727-181825`** — user-safe defaults; §1, "Absence is not consent."
- **ADR `260726-170125`** — a room is a membership-scoped durable stream.

## References

- `specs/message-search/01-ideation.md` — the measurements and the twelve decisions
- `specs/room-participation/02-specification.md` §10.3 — RP7, amended by this change
- `specs/rooms/02-specification.md` §13.2 — the command palette, amended by this change
- `specs/community-adapter/02-specification.md` — Non-Goals, §5 and §Data model changes, all amended by this change
- `specs/message-search/03-tasks.json` — the DECOMPOSE breakdown; the per-task `issue` field is the task→issue map (DOR-679 … DOR-688)

---

# Amendments from DECOMPOSE (2026-07-29)

**Why these are here rather than only in the tickets.** This programme's recurring failure is a claim that was true when written and cited later without re-checking — a failure this document itself commits three times and corrects twice (§1.1, §2.1, §6.4). Whoever picks up DOR-684 will read §6.3, not a ticket comment. So the corrections land at the source.

**No original claim is deleted** — each is left in place with an inline marker, because a correction that erases what it corrected teaches nobody why it was needed.

**Line numbers in this document have moved, and an earlier draft of this paragraph wrongly claimed they had not.** The amendment _sections_ are appended, but the inline markers are **insertions**, so every line past the first one shifts. Nothing outside this file cites it by line today — verified by grep across `specs/`, `decisions/`, `docs/` and `contributing/` — so the breakage is latent rather than actual. But the claim was false as written, and a document whose own Amendment 4 warns that line numbers move should not have asserted otherwise. **Cite this file by section heading or quoted clause text, never by line.** That is the same discipline §Background already applies to ADR-0310, and for the same reason.

## Amendment 1 — the latency budget is a curve, not a number (DOR-684)

**Amends §6.3 and the "Query is not the constraint" bullet under §Performance Considerations.**

§6.3's figures are correct and are a **best case**. Its conclusion — "the design has headroom of more than an order of magnitude before anything needs revisiting" — does not hold, because the quantity it treats as constant is not.

**The claim being made here is the SHAPE, not the numbers.** Three independent runs of this benchmark — two during DECOMPOSE, one by review — produced three different absolute figures, spanning roughly 2× in each direction, because every one was taken on a shared workstation under whatever load the other agents were generating (review measured at load 39–41 throughout). **The shape reproduced identically every time; no absolute figure reproduced at all.** So the absolutes below are one run, recorded for illustration and explicitly **machine- and load-dependent** — they are not a budget, not a regression threshold, and not quotable. Re-run the benchmark on the machine you care about; do not cite this table.

**`ORDER BY bm25()` is O(hits), not O(limit).** bm25 must score every matching row before `LIMIT` can discard any, so cost is a function of how many messages match, not of how many are returned. One run, 2026-07-29, against the 18,114-row prototype index the original figures came from:

| Query       | Hits   | `ORDER BY bm25()` | No `ORDER BY` | `+ snippet()` |
| ----------- | ------ | ----------------- | ------------- | ------------- |
| `dogs`      | 2      | 0.03 ms           | 0.012 ms      | 0.55 ms       |
| `search`    | 295    | 0.16 ms           | 0.017 ms      | 2.79 ms       |
| `opencode`  | 414    | 0.20 ms           | 0.016 ms      | 3.05 ms       |
| `index`     | 806    | 0.35 ms           | 0.016 ms      | 1.64 ms       |
| `migration` | 886    | 0.37 ms           | 0.016 ms      | 2.10 ms       |
| `that`      | 5,139  | 2.42 ms           | 0.015 ms      | 7.35 ms       |
| `the`       | 15,691 | **6.83 ms**       | 0.016 ms      | **19.48 ms**  |

**Two structural facts, each confirmed by two independent measurements on different loads:**

1. **Unordered is flat** across a four-order-of-magnitude range of hit counts — 0.012–0.017 ms here, 0.011–0.019 ms in review. The join and the match are effectively free; the ranking is the whole cost.
2. **Ranked is linear in hits.** The slope is the load-dependent part — ~0.44 µs/row here, 0.71–1.03 µs/row in review, ~0.375 µs/row on an earlier DECOMPOSE run — but linearity itself held in all three, and the hit counts are identical across runs (`opencode` 414, `migration` 886), so the runs are measuring the same corpus and differ only in machine conditions.

**Everything below follows from the shape and survives any slope in that range.**

**So §6.3's 0.21–4.55 ms is the range for queries matching under ~1,000 rows, not a ceiling.** The realistic worst case at this corpus size is one to two orders of magnitude above the stated budget, depending on load. And **the operator's 3.3 ms at 500k rows cannot be a common-term figure**: at any slope in the measured range, a term matching ~400k rows costs somewhere between 150 ms and 400 ms to rank before `snippet()` is charged. That number is not evidence the design scales; it is evidence a rare word is cheap at any scale, which was never in doubt.

**On "cold", stated precisely, because the earlier draft conflated two different things.** A first query measured on a fresh connection with statement preparation inside the timed call ran ~2× the warm p50 here and ~10× on the earlier run. But connection setup and statement preparation are **fixed costs that do not scale with the corpus**; only page-cache misses scale, and the two were not separated. So treat cold as "the first query of a session is materially slower for reasons that are mostly one-time", not as a second scaling term. It is a reason to warm the statement at startup, not a reason to redesign.

**The consequence this document lacked: a minimum query length and a debounce are part of the calling contract, not an optimisation.** Typing `t` → `th` → `the` fires three queries whose cost _rises_ as the query becomes more specific, and the first two are simultaneously the most expensive and the least useful. G1 says "fast enough to feel like typing"; that is a property of what the caller sends, not of FTS5. Both belong in DOR-684's route contract and DOR-685's palette, and neither is a tuning knob to be discovered later under a performance bug.

**Nothing in the design changes.** External content, the tokenizer, the schema and the ranking are all unaffected — this is a budget correction, not a redesign. What changes is what a reviewer should expect, and what a benchmark must assert.

**Re-run it rather than trusting it.** The measurement is one script against any built index, and the methodology matters — prepare statements outside the timing loop, discard a warm-up, take p50 over 25 runs:

```js
// node bench.mjs <path-to-index.db>
import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { readonly: true });
const SNIP = "snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)";
const p50 = (fn, n = 25) => {
  for (let i = 0; i < 5; i++) fn(); // warm-up, discarded
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  return t.sort((a, b) => a - b)[Math.floor(n / 2)];
};
const count = db.prepare('select count(*) c from messages_fts where messages_fts match ?');
const ranked =
  db.prepare(`select m.id, ${SNIP} e from messages_fts f join messages m on m.id=f.rowid
                           where messages_fts match ? order by bm25(messages_fts) limit 20`);
for (const q of ['dogs', 'migration', 'that', 'the'])
  console.log(q, count.get(q).c, 'hits', p50(() => ranked.all(q)).toFixed(2), 'ms');
```

**A benchmark must assert the hit count before it asserts the latency.** An empty or broken index answers in microseconds, so a latency-only assertion passes most loudly exactly when the feature is most broken. DOR-684 carries this as a requirement.

**And a regression threshold must be derived, never inherited.** Because the absolutes move ~2× with load, any budget hard-coded from this document will be either meaninglessly loose or flaky. DOR-684's benchmark establishes its threshold on the machine it runs on — measure the flat unordered baseline and the ranked slope in the same run, and assert on the **ratio and the linearity**, which are stable, rather than on a millisecond figure, which is not.

## Amendment 2 — the index enumerates Claude Code roots; it does not resolve one (DOR-682)

**Amends §2.1's opening paragraph, the `claude-code` row of §2's source table, and §Technical Dependencies.**

§2.1 is right that the root is `$CLAUDE_CONFIG_DIR ?? ~/.claude` and right that hardcoding `~/.claude` reintroduces DOR-250. It is wrong that resolving **one** root is sufficient, and the counter-example is the machine this feature was designed on.

**Measured 2026-07-29, read-only.** Three Claude Code config roots exist, and **all three were written within the last 7 days** — 143, 78 and 28 main-session files modified respectively, so none is abandoned history:

| Root         | Indexed files (evals excluded) | Indexable messages |
| ------------ | ------------------------------ | ------------------ |
| `~/.claude`  | 236                            | 17,989             |
| `~/.claude2` | 120                            | 7,880              |
| `~/.claude3` | 28                             | 942                |
| **Union**    | **384**                        | **26,811**         |

A single-root index sees at most **17,989 of 26,811 — 67%**. The failure is not bounded there: the environment this decomposition ran in had `CLAUDE_CONFIG_DIR=~/.claude3` inherited from its shell, and a server launched the same way indexes **942 of 26,811 — 3.5%** while reporting nothing wrong, because a short result list is indistinguishable from a complete one.

**That is this document's own G4 failure, in a form §2.1 did not anticipate.** G4 refuses a box that "silently covers less for one runtime than another"; this covers less for the _same_ runtime depending on an environment variable.

**Why the mistake is a reasonable one, stated because the fix should not read as a rebuke of `resolveClaudeConfigDir()`.** That function is exactly right for its existing caller, which reads back a transcript for a session DorkOS itself just ran and therefore MUST resolve the identical directory the SDK wrote to. The index asks a different question — _where does this person's history live?_ — and inherited the answer to the first. Two legitimate questions, one resolver, and only one of them is served by it.

**The amendment.** The `claude-code` registry row's root resolver returns a **set**. The default set is `$CLAUDE_CONFIG_DIR` when set, **union** `~/.claude` — those being the only two paths the SDK itself can have written to in a given process, so the union is free and provably complete for that process. Further roots are user configuration (a Zod field, a semver-keyed migration, default `[]`), because a third profile is an operator fact DorkOS cannot infer. **Auto-globbing `~/.claude*` is not the answer**: on this machine it sweeps up `.claude-worktrees` and `.claudekit`, neither of which is a config dir.

A root that does not exist is skipped silently; a root that exists and fails to read contributes one `search_sources.last_error` and zero rows, per G3. Session ids are UUIDs so cross-root `origin_key` collision is not a practical risk — but `search_sources` is keyed `(source_id, origin_key)`, so a collision would silently overwrite a frontier rather than fail, and DOR-682 asserts distinctness rather than assuming it.

**Consequence for every corpus figure in this document, not only §2's table.** The `claude-code` figures throughout describe `~/.claude` alone. The real v1 corpus on this machine is roughly **1.5× larger** than every count in **§1, §2 and §5**, and the share-of-disk percentages are correspondingly understated. **§5's change-signal figures are single-root too** — the 28-of-2,458 compaction sample, its 74 marker lines and the 543 `relocated` lines are all counted over `~/.claude` only, so each grows with the root set even though the conclusions they support (compaction is append-only; `relocated` is a line and not a file move) are structural and do not. The design is unaffected — the numbers are.

### As shipped (DOR-682, 2026-08-25) — four deltas from the paragraphs above

Recorded here rather than only in the ticket, for the reason the amendment header gives: whoever reads this section next will not read a Linear issue.

**1. No new config field was needed.** This amendment asked for "a Zod field, a semver-keyed migration, default `[]`". `runtimes.claudeCode.accounts` already is that field — DOR-729 shipped it, and ADR `260801-204126` folded it into `resolveClaudeRootSet()` along with the active root, `$CLAUDE_CONFIG_DIR` and `~/.claude`. So the whole of this amendment's scope came down to the registry row calling that function instead of `resolveActiveClaudeRoot()`. The two features now enumerate one set from one derivation and cannot disagree about what history exists.

**2. A root that fails to read reports through `SourceSweep.failures`, not `search_sources.last_error`.** The clause above asked for a row. There is no honest row to write: `search_sources` is keyed by container, so an error about a whole ROOT would need an invented container id — one that discovery can never return, and that the prune would therefore delete on the first healthy sweep, flapping in and out of the frontier every five minutes. DOR-681 had already reached the same conclusion for a discovery that fails outright (`DISCOVERY_FAILURE_KEY`), and the per-root case joins it. The visibility G3 asks for is unchanged: the reconciler logs every failure, naming the root's path. A root that simply does not exist is still silent, because an account nobody has used is not a fault.

**3. A partial enumeration suppresses the prune, and that has a real cost.** Not anticipated here, and load-bearing. Containers are pruned when discovery reports they are gone — and a root that would not open reports the same absence as a root whose files were deleted. Pruning on that would delete an entire account's indexed history the moment its volume hiccupped, then pay a full rebuild to recover it. So the sweep prunes only when every root enumerated.

**Stated plainly rather than softened:** this is not "stale rows survive one extra sweep". A root that is _permanently_ unreadable — a registered account on a disk that never returns, a permission nobody restores — **freezes pruning for every root, indefinitely**. Deleted transcripts from healthy accounts keep answering searches until the broken root is repaired or removed from the config. It is survivable only because the failure is loud: every sweep logs the root by path. The real fix is per-root pruning, which needs a `root` column on `search_sources` so a frontier row can say which account it came from. That is **follow-up work, deliberately not smuggled into this ticket** — the same column also enables a per-root `last_error` (delta 2's missing row) and per-account attribution of a hit, so it is one migration serving three motivations.

**4. A symlinked duplicate root would have blacked out the whole index.** Found in review, fixed here. `resolveClaudeRootSet()` deduplicates lexically, so a registered account that is a _symlink_ to another root survives as two spellings of one directory. Every session id then has a twin; twins are refused rather than preferred; the index indexes nothing, forever, rebuilding nothing every five minutes. Discovery therefore collapses roots on `realpath` rather than on the string, and a duplicated directory now reports **one** summary failure naming the two locations instead of one failure per colliding session id — several hundred identical warnings per sweep is not a report, it is a way to lose the one fact an operator can act on.

**Measured after the change**, on the machine this amendment was written on: 2 roots, **497 files, 19,124 messages**, and — the point of the whole ticket — the identical 19,124 whether `CLAUDE_CONFIG_DIR` is unset or exported as `~/.claude3`.

**On what the bench asserts, and why it is not a message-count floor.** `scripts/search-corpus-bench.ts` asserts coverage by cross-checking its multi-root discovery against an independent per-root enumeration. A floor would work on this machine today — the task text's 18,000 would indeed have caught a single-root regression here — but a floor is the wrong instrument for this property, because it is **machine- and time-dependent while the property is neither**. An operator with one Claude account reds spuriously against any floor derived from two, and `cleanupPeriodDays` shrinks every root's 30-day window without anything being wrong. The cross-check answers "did the source read every root the resolver returned", which is the actual claim, and it answers it identically on one account or five.

## Amendment 3 — the corpus is clean; the reader was not (DOR-681)

**Amends §2.1's two paragraphs on malformed lines.**

§2.1 reaches the right conclusion — the corpus is clean — through two explanations that are both wrong, and the true explanation is a concrete implementation constraint that would otherwise have shipped as a bug.

**What §2.1 says:** a first pass found 64 malformed lines; a second pass hours later found 0; therefore the 64 were "truncated final lines in flight", evidence of a live-append race.

**What re-measurement on 2026-07-29 found:**

- **64 malformed lines — the original count, exactly.** Not 0.
- **0 of the 64 are the final line of their file.** Every one is mid-file, so the in-flight-truncation story cannot be right.
- **An immediate re-scan of the same files returns 64 again.** Perfectly stable; there is no race.
- They are confined to **5 files** carrying a tearing separator, **1 of them a main session**.

**The cause — and exactly which characters are responsible, because an earlier draft of this amendment got that wrong.** On Node **v24.14.1**, the version this repo runs, `readline` breaks on **LF (U+000A), CR (U+000D), U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR — and nothing else.** Measured directly, one separator per file, counting the lines the interface emits:

| Character             | `readline` |
| --------------------- | ---------- |
| LF U+000A · CR U+000D | splits     |
| U+2028 LS · U+2029 PS | **splits** |
| **U+0085 NEL**        | **inert**  |
| VT U+000B · FF U+000C | inert      |

`JSON.stringify` escapes none of LS/PS/NEL and all three are legal raw inside a JSON string, so a runtime writing whole records emits them as-is. But only LS and PS tear a record apart.

**The arithmetic closes exactly, and it closes without NEL.** Across the corpus: **34 × U+2028 and 12 × U+2029 spread over 19 records** produce `46 + 19 = 65` fragments, of which **1 is empty** (two adjacent separators) and is skipped as a blank line — leaving **64** unparseable fragments, the observed number. The **44 × U+0085 NEL**, which occur in 7 records including one main-session file carrying 2 NEL and no LS/PS, contribute **zero**: that file yields 0 malformed lines, where an amendment blaming NEL predicts 4.

Splitting the identical bytes on `\n` alone:

```
malformed when split with Node readline : 64
malformed when split on \n only         : 0
```

**So the corpus has never had a malformed line. Both measurements were measuring their own reader.**

**The implementation constraint, which is the part that matters.** §5 already requires the JSONL frontier reader to retain a trailing partial line and advance the offset only past the last complete one. Amendment: **it must also treat `\n` as the only line terminator.** A reader using `readline`, or any splitter honouring Unicode line terminators, silently destroys real messages — 64 of them on this machine today — and does so in the least visible way available, since each fragment is discarded as unparseable by the very error handling meant to make the reader robust. The skip-and-count rule then converts data loss into a log line nobody reads.

**A record can be torn into more than two pieces.** A record holding _k_ tearing separators becomes _k+1_ fragments, so an assertion written for "two halves" is wrong for the general case and wrong for the fixture DOR-681 mandates. Count fragments as _k+1_, and count only LS and PS toward _k_.

§5's partial-line rule keeps its justification on general grounds — a concurrent append genuinely can be observed mid-line — but it loses the empirical evidence §2.1 offered for it, and gains a different and sharper one.

**Two notes on technique, both paid for.** The script written to test this failed to _parse_ when a literal U+2028 was pasted into its source: U+2028 is a line terminator in JavaScript source too, so the same character breaks the data reader and the tool written to study it. **Build separator fixtures with code-point arithmetic — `chr(0x2028)` / `String.fromCharCode(0x2028)` — never a literal and never an escape sequence in a shell-bound string**, because an escape renders to a literal before it reaches the file and reintroduces the failure one level up. And the first version of this amendment folded NEL into the cause by assumption rather than by measurement, which is the exact error this document's provenance table exists to prevent.

## Amendment 4 — provenance: which figures were re-derived, and which were not

**The rule this table exists to enforce:** a figure in this document is safe to quote only if someone has re-run it. Everything below was checked on 2026-07-29 against the live corpus unless marked otherwise. **[not re-derived]** does not mean wrong — it means unverified, and it must not be cited as measured without re-running first.

**Re-derived and holding** (2026-07-29):

| Claim                                                                                           | §            | Result                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Whole corpus 2,458 files / 2,771.2 MB / 448,857 lines                                           | §1.1         | 2,451 / 2,771 MB / 448,925 — holds                                                                                                |
| Subagent+eval corpus 50,631 messages / 42.85 MB                                                 | §1.1         | 50,626 / 42.9 MB — holds                                                                                                          |
| Subagent transcripts 2,142 files / 2,096.0 MB                                                   | §2.1         | 2,140 / 2,095.4 MB — holds                                                                                                        |
| Eval sandboxes 37; plugin artifacts 38 / 1.2 MB                                                 | §2.1         | 37; 38 / 1.2 MB — **exact**                                                                                                       |
| `thinking` 57,375 blocks, 99.2% empty, 0.19 MB text, 161.5 MB signature                         | §1.2         | 57,408 / 99.21% / 0.19 MB / 161.7 MB — holds                                                                                      |
| `file-history-snapshot` 16.0 MB, 2,551 lines                                                    | §1.2         | 16.0 MB, 2,551 lines — **exact**                                                                                                  |
| `attachment` 153.6 MB; `skill_listing` 72.5 / `deferred_tools_delta` 29.4 / `hook_success` 26.3 | §1.2         | 153.4; 72.2 / 29.4 / 26.3 — holds                                                                                                 |
| Tool output ~1,980 MB across two encodings                                                      | §1.2         | 969.3 + 995.6 = 1,964.9 MB — holds                                                                                                |
| Compaction: 28 files, 74 markers, zero ending at a marker                                       | §5           | 28 / 74 / 0 — **exact**                                                                                                           |
| `relocated` 543 lines                                                                           | §5           | 543 — **exact**                                                                                                                   |
| Type-less lines 3,804, all outside the files v1 reads                                           | §2.1         | 3,804 corpus-wide, 0 in main sessions — **exact**                                                                                 |
| Vanished-`cwd` 33 files / 288 messages                                                          | §6.4         | 33 / 288 — **exact**                                                                                                              |
| Codex 16 files, 2,114 lines, 0 malformed, timestamps 2,114/2,114                                | §2.2         | all four — **exact**                                                                                                              |
| Codex two families: `response_item` vs `event_msg` double-count                                 | §2.2         | 223 vs 203 — the trap is real                                                                                                     |
| External content 29.1 MB vs 48.4 MB duplicated (39.9% smaller)                                  | §1.4         | `cmp-external.db` 29.14 MB vs `cmp-duplicate.db` 48.44 MB = **39.84%** — **exact**, corroborated by both surviving artifacts      |
| Index SIZE 29.2 MB over the v1 corpus                                                           | §Performance | `idx.db` and `final.db` are each **30,621,696 bytes = 29.20 MB** — **exact**, corroborated by two independent surviving artifacts |
| FTS5 / `bm25()` / `snippet()` / SQLite 3.53.2 present                                           | §Tech deps   | verified by running                                                                                                               |
| `porter unicode61` gives 3 hits where `unicode61` gives 1                                       | §6.2         | verified by running                                                                                                               |
| FTS5 column-name trap: `snippet()` fails, `MATCH` survives                                      | §4           | verified by running against a deliberate mismatch                                                                                 |
| `better-sqlite3` declared as the RANGE `^12.11.1`                                               | §Tech deps   | `packages/db/package.json:21` — exact                                                                                             |
| 37 migrations, zero FTS5 anywhere in `apps/` or `packages/`                                     | §Background  | verified                                                                                                                          |
| `joinedSeq` does not exist in any migration                                                     | §7           | verified 2026-07-29; **no longer true** — RP3 landed `joined_seq` (DOR-684, Amendment 7)                                          |
| `readFromOffset` advances to `stat.size` unconditionally                                        | §5           | verified, and it has no production consumer                                                                                       |

**Corrected by Amendments 1–3 and 5:** §6.3's latency headroom · §2.1's single root · §2.1's malformed-line explanation · G5/§8/Phase 5's claim on `search_room_history`.

**Corrected during review of this amendment block, and recorded because the provenance rule applies to the corrections too:**

- **U+0085 NEL was blamed for tearing records and does not tear.** Amendment 3's first draft named LS, PS and NEL as the cause; measured on Node v24.14.1, `readline` splits on LF, CR, U+2028 and U+2029 only, and NEL/VT/FF are inert. The arithmetic closes exactly without NEL (46 tearing separators over 19 records → 65 fragments − 1 empty = 64). NEL was folded in by assumption rather than measurement — the exact failure this table exists to prevent, committed inside the table's own commit.
- **Amendment 1's absolute latency figures do not reproduce and are no longer presented as if they might.** Three runs, three answers, one shape. See Amendment 1's opening paragraph.

**[not re-derived] — do not quote as measured:**

- **Rebuild TIMINGS: 2.69 s over the v1 corpus, and [operator] 8.25 s over 2,911 MB** (§Performance, §1.4). No rebuild was run during DECOMPOSE, and **no artifact on disk can evidence a duration** — which is why the timings sit here while the index SIZE they produced sits in the confirmed table above. That split is deliberate: the two are different kinds of claim with different kinds of evidence. DOR-681's corpus bench is what will confirm the timings, and it asserts `rebuildMs <= 30000` rather than 2.69 s, precisely because the figure is unverified.
- **[operator]'s "108 MB" full-corpus index** (§4.1 of the ideation, carried into §Performance's framing). The surviving `rebuild.db` artifact is **108,126,208 bytes**, which is 103.12 MiB — so the figure is corroborated as a **decimal** MB, and is the one place the document's stated "MB means MiB throughout" convention does not hold. Minor, but it is exactly the kind of unit slip that turns into a false comparison later.
- **Steady-state append: [operator] p50 0.07 ms at 494k rows; [measured] 1.29 ms single-row at ~18k** (§Performance). Not re-run.
- **[operator] top-20 at 500k rows = 3.3 ms** (§1.4, §6.3). Not re-run, and Amendment 1 argues it cannot be a common-term figure.
- **§1.4's "snippet() is 5–9× slower"** (§1.4). The direction is confirmed and the ratio is not: re-measured spreads span roughly 3–18× depending on hit count, and at 2 hits it is ~18×. Treat "slower" as established and the multiple as query-dependent.
- **OpenCode's 24 messages / `session` 6 / `part` 73** (§2.3). Not re-derived — the store was deliberately not opened, which is the rule working as intended. Inherited by DOR-688.
- **§6.4's breakdown of the 33 vanished-`cwd` files** into 12 legacy worktrees / 12 `~/.dork/workspaces` / 9 other (§6.4). The totals are exact; the three-way split was not re-derived.
- **§2.2's per-role Codex splits** (144 assistant / 79 user; 144 `agent_message` / 59 `user_message`) and the mtime-equals-last-timestamp claim on 16/16 files. The aggregate counts are exact; these breakdowns were not re-run.
- **Every `file:line` citation into other specs and into `apps/server/`** beyond the handful named as verified above. Line numbers move; several in this document already did.

## Amendment 5 — `search_room_history` is RP7's to build, not this ticket's (DOR-684)

**Amends G5, §8's "becomes a caller" paragraph, and Phase 5 of §Implementation Phases.**

This document states in three places that `search_room_history` becomes a caller of the index **as part of this work**. It is the one correction in this set that _removes_ scope, and it was the one that initially landed only in the tickets — which is precisely the failure this amendment block exists to prevent, since a reader reaches §64 long before they reach a Linear issue.

**`specs/room-participation/02-specification.md` owns that tool, and it says so twice.** Its §12 phasing table lists `read_room_history` and `search_room_history` under **RP7**, with dependencies **RP6, RP3 and DOR-672**. Its Amendment 1 is explicit about the ordering: _"RP7 lands after the index and lands directly as a caller"_, and _"what is forbidden is **shipping the scan and replacing it later**, not 'these two must be one PR.'"_

**So the division is:** DOR-672 delivers the index and the query service. **RP7 delivers the tool**, as a caller, and never writes the substring scan. The invariant both documents care about — exactly one search path over the room log, and nobody writes a second one intending to delete it — is preserved by the ordering, not by co-location.

**RP7 additionally needs `joinedSeq`, which does not exist.** Re-verified 2026-07-29: `grep joined_seq` across `packages/db/` and `apps/server/src/` returns nothing, and `room_members` carries only `joined_at` and `last_read_seq`. **RP3 lands it.** An index-backed `search_room_history` shipped before then would hand an agent a fast, ranked reader of everything said in its rooms before it joined — §7 already says this, and it is the reason the dependency is real rather than bookkeeping.

**[Amended 2026-08-24 (DOR-684) — it exists now; RP3 landed it, and DOR-684 applies it as a per-room floor. See Amendment 7.]**

**G5 as written is therefore not a goal this ticket can meet**, and no task in `03-tasks.json` claims it. What DOR-684 owes RP7 is a query service whose visible-set join is a parameter rather than an assumption, so that RP7 can pass a member-scoped room set without the service needing to know why.

## Amendment 6 — the room write-through is deferred, and the reconciler is the only path in v1 (DOR-680)

**Amends §5's reconciler paragraph.**

**[Discharged 2026-08-24 (DOR-684) — the write-through is built, on the seam and with the degradation contract this amendment specified. See Amendment 7.]**

§5 promises three things and DOR-680 shipped two: the 300,000 ms reconciler and the startup sweep are in `apps/server/src/services/search/indexer.ts`. **The immediate write-through on the room path is not built.** This amendment exists because a scope removal that lives only in a ticket is exactly the failure Amendment 5 was written to prevent — a reader reaches §5 long before they reach a Linear issue, and §5 as written would have them looking for code that is not there.

**Why it was not built, in the order the reasons actually weigh.**

1. **It cannot be observed yet.** Nothing a person can reach queries these rows in v1 — the route is DOR-684 and the palette is DOR-685 — so the five-minute lag has no surface on which to be visible. Building the mechanism now would mean writing coupling to serve a user-visible property that does not exist.
2. **The only correct seam is in a file being rewritten.** Every committed entry passes through exactly one place, `RoomService.publishEntry`, and that is the one hook a write-through can hang off without missing the agent-reply path (an entry posted by a turn runner never touches a route). `apps/server/src/services/rooms/` was under active edit by the DOR-634 thread-retirement work throughout, and `03-tasks.md` §2.1 already told this task to coordinate before modifying it.
3. **There is no in-process seam on the global stream.** `eventFanOut.broadcast('room_activity', …)` does fire on every committed entry, which looks like a zero-edit hook, but `EventFanOut` writes to Express `Response` objects and has no in-process listener API. Adding one would put a cross-cutting change into `services/core/` on behalf of a single consumer, and invert the dependency so the indexer subscribes to an SSE broadcaster.

**What this costs, stated precisely.** A message said in a room is findable up to five minutes later rather than immediately. That is ADR-0043's accepted staleness, applied to a source where DorkOS happens to be able to do better and chose not to yet.

**What it will take to land.** One call in `RoomService.publishEntry` to an indexer method that sweeps a single container, and one wiring line where the room subsystem is constructed. It belongs to whichever ticket can safely edit `services/rooms/` after DOR-634 lands — most naturally DOR-684, which is the first task with a surface that makes the latency visible.

**One thing this amendment does not do is soften §5.** The write-through remains the right design. It is deferred on sequencing and observability, not reconsidered on merit, and a v1 that ships the query surface without it should be read as carrying a known five-minute lag rather than as having settled the question.

## Amendment 7 — the visible set is PAIRS, and the benchmark's floor is derived (DOR-684)

**Amends §6.1's visibility clause, §7's `joinedSeq` paragraph, §5's reconciler paragraph (via Amendment 6), Amendment 5's closing claim, and the benchmark requirement in Amendment 1.**

**One word of SQL was missing, and the narrow scope paid for it.** §6.1's query is written `FROM messages_fts f JOIN messages m ON m.id = f.rowid`, and that is the shape that shipped. With a NARROW visibility clause — one container, which is what `search_room_history` sends and what an agent's search sends — SQLite drives the join from `messages` instead, using the covering index `(source_id, origin_key, ordinal)` and probing FTS5 once per row. **Measured on a 40,000-row index with one room in scope, term `the`: 7,786 ms.** The same query with `CROSS JOIN` — a join-ORDER directive, not a different join — is **4.5 ms**, and the owner path is unchanged (10.3 → 10.2 ms) because it was already on the FTS-driven plan. DorkOS never runs `ANALYZE`, so the planner has no statistics with which to reach that conclusion itself, and the directive is not a hint it may ignore. **`search_room_history` has been on the slow plan since DOR-680**; it shares this function, so it is fixed by the same word. The bench now measures the container-scoped shape as a third statement, and asserts it against the unscoped one rather than against a wall-clock ceiling.

**The minimum query length is not a cost threshold, and the measurement is what says so.** This document and an earlier draft of this amendment both justified `SEARCH_MIN_QUERY_LENGTH` as buying back the cost of a short query. Re-derived over 9,207 real messages: the worst one-character query (`a`) matches **42%** of the index, the worst two-character one (`it`) **47%**, the worst three-character one (`the`) **83%**. **Length does not predict cost.** What survives is the other half of Amendment 1's argument — a one-letter query is certainly useless AND certainly expensive — so the floor stands at two on that ground, and the bench asserts the fact it rests on (the queries the floor refuses are expensive ones) rather than a number. **It is also counted over the TOKENIZED form now**: `a,`, `%20a` and a string of spaces are all refused, and all three were 200s running one-letter ranked queries while the check was a `.min()` on the raw string.

**The room write-through is built, and Amendment 6 named this ticket correctly.** Amendment 6 defers it and says it "belongs to whichever ticket can safely edit `services/rooms/` after DOR-634 lands — most naturally DOR-684, which is the first task with a surface that makes the latency visible." It landed here, in the shape that amendment prescribed: one call at the END of `RoomService.publishEntry` through a `RoomEntryIndexer` port, one wiring line in `createRoomSubsystem`, and one indexer entry point that brings a SINGLE container up to date (`indexRowContainer`) — the sweep's own per-container function, reached with a by-key frontier read instead of the two whole-source scans, so nothing that scales with how many rooms exist sits on a write path.

**The degradation contract is the part worth stating, because it inverts the usual direction.** The room log is the truth and the index is a copy of it, so **an index write that fails must never fail the post**. It logs one warning and returns; the entry is durable, the room already has it, and the reconciler's next pass finds the container's watermark below its `max(seq)` and indexes what was missed — which is not a fallback bolted on, it is the sweep doing what it does for any room nobody has posted in for four minutes. Deliberately no `search_sources.last_error` on this path: a room that is four minutes behind is not a broken source, and warning about it would fill the search envelope with something nobody can act on. Both halves are guarded — the implementation catches, and `publishEntry` catches around the port anyway — and both are driven red before green in `services/search/__tests__/write-through.test.ts`.

**It is synchronous, and the number is the argument — with the precondition the number needs.** `better-sqlite3` has no asynchronous write to defer to, so a `setImmediate` would move identical blocking work later on the same event loop, buy a window in which a crash loses it, and turn "you can find what you just said" into a race. **Measured 2026-08-24 over a file-backed database: 300 posts cost 156.3 ms without the write-through and 227.4 ms with it — 0.237 ms per post**, against roughly half a millisecond for the post itself.

**That figure is the cost on a room the index is CAUGHT UP ON, and it was quoted for a while as though it were the cost of the feature.** It is not. The pass resumes where the index stopped, so the first post into a room with an unindexed backlog projects that whole backlog inside `publishEntry` — **406 ms for one post into a 20,000-entry room** (measured in review, through the room service; the standing bench measures the indexing pass alone at 169 ms for the same depth). So the write-through carries a bound: **a room more than 200 entries behind is left to the reconciler**, which is the same degradation a failed write-through takes and the same one §5 already defines. 200 is read off the curve rather than chosen — cold cost is linear at ~0.009 ms per projected entry, making the bound 2.5 ms of inline work, an order of magnitude under the ~50 ms at which a keystroke starts to feel slow, and far above the backlog a live room accumulates between two posts (which is one). `scripts/search-write-through-bench.ts` (`pnpm search:write-through`) measures both halves, so neither number is inherited again.

**`joinedSeq` exists now.** §7 and Amendment 5 both state, correctly at the time and re-verified on 2026-07-29, that `room_members` carries only `joined_at` and `last_read_seq`. RP3 has since landed the column (`packages/db/src/schema/rooms.ts`, `joined_seq INTEGER NOT NULL DEFAULT 0`), with a backfill and its own migration test. Every claim resting on its absence — that the index-backed room-history tool must wait for it, that DOR-684 could only leave a hole where it goes — is discharged rather than corrected: the floor is real and this task applies it.

**The visible set is `(roomId, joinedSeq)` PAIRS, and a single floor cannot express it.** §6.1 writes the agent path as `origin_key IN (...)` and §7 describes it as "member-only, at or after `joinedSeq`", which reads as one list and one number. It is not: a member joins different rooms at different points, so one floor across a multi-room search is wrong in both directions at once — it leaks what was said before they arrived in the rooms they joined late, and hides what is theirs in the rooms they joined early. `MessageQuery` therefore carries a floor per container, and the clause is emitted as one `origin_key IN (...) AND ordinal > ?` group per DISTINCT floor, so a caller in forty rooms who joined thirty-nine at the beginning costs two groups rather than forty. Both directions are asserted, over the same seeded rows, in `services/search/__tests__/query.test.ts` and `access.test.ts`.

`search_room_history`'s port (`RoomMessageFinder`) was migrated to the same shape rather than left beside it. Its only caller searches one room, so the old `roomIds[] + afterSeq` spelling was correct today and a trap tomorrow; two ways to say the same thing is the tolerated legacy pattern this codebase refuses.

**The benchmark's hit floor is derived on the machine it runs on, and 10,000 is not reachable on this one.** Amendment 1 requires a hit-count assertion before any latency assertion, and DOR-684's task text names 10,000 — a figure from the 18,114-row prototype index. The corpus a single Claude Code root actually holds today is **9,110 messages** (measured 2026-08-24, recorded in `scripts/search-corpus-bench.ts`), because Claude Code rotates transcripts older than `cleanupPeriodDays`: one root is a moving 30-day window, not a growing archive. `scripts/search-latency-bench.ts` therefore floors the commonest term at **5,000 hits**. The NUMBER is taken from its sibling's `MIN_MESSAGES` deliberately; the QUANTITY is not the same one, and saying so matters — that script floors the whole index at 5,000 **messages**, this one floors a single term at 5,000 **hits**, which is the stricter bar on the same corpus (the commonest term matched 7,656 of 9,182 on the run below). Both keep the floor's whole purpose — an empty or broken index answers in microseconds and would sail past a latency-only check — while sitting far enough below today's corpus that ordinary rotation never reddens either. DOR-682 (every root rather than the active one) roughly doubles the corpus and lets it rise.

**Two refinements to what that benchmark fits, both learned by running it.** The linearity fit is taken on `ORDER BY bm25()` **without** `snippet()`: ranking is charged per row that MATCHES and is the term that scales, while `snippet()` is charged per row RETURNED — twenty of them, always — so folding them together measures a constant as if it were slope (R² 0.886 combined, 1.000 split). And the flatness claim is asserted **comparatively** as well as absolutely: the unordered spread must be at least ten times smaller than the ranked spread over the same terms, which is scale-free and survives any load, where a bare ratio ceiling over 8–24 µs measurements is mostly measuring the scheduler.

**One run, 2026-08-24, on a workstation running several agents — illustration, not a budget, per Amendment 1's own instruction:** 9,182 messages indexed; `the` 7,656 hits; unordered p50 0.012–0.013 ms across 3.3 decades of hit count (spread 1.12×); ranked p50 0.032 → 3.476 ms across the same range (spread 109×); ranked slope 0.452 µs/row, inside the 0.375–1.03 µs/row range the three earlier runs bracketed; linearity R² 1.000. **The shape reproduced; no absolute was inherited.**

## Amendment 8 — codex as shipped: the corpus, the authorship gate, and one carve-out (DOR-683)

**Amends §2's source table, §2.2, §4's `origin_key` table, and §Testing Strategy's codex bullet.**

Recorded here rather than only in the ticket, for the reason every amendment header gives: whoever reads this section next will not read a Linear issue.

**The mechanism claim held.** `jsonl-frontier.ts` was not touched. The twin refusal, the shrink rebuild, the partial-line rule, the carry cap and the prune suppression all apply to Codex without a line of new code, which is what ADR `260728-214214` said would happen. What the source needed beyond "one registry row and one pure projection" is its own `discover` — which the `FileSource` port has always had, because a source is what knows where its files are. Calling that a third thing would be honest; calling it a mechanism would not.

**The corpus, re-measured 2026-08-25** (the figures in §2.2 are from 2026-07-28 and have grown): **18 rollout files** — 14 under `sessions/YYYY/MM/DD/`, 4 in the flat `archived_sessions/` — **7.0 MB, 2,200 lines, zero malformed, a top-level `timestamp` on 2,200 of 2,200.** Line types: `response_item` 1,179 · `event_msg` 928 · `turn_context` 68 · `session_meta` 18 · `world_state` 6 · `compacted` 1. Exactly one `session_meta`, always line 1; 18 session ids, none in two files. **The two-families trap reproduced exactly as §2.2 describes it**: 261 `response_item` messages against 219 in the `event_msg` family.

**The archive is a MOVE, and that is load-bearing.** None of the four archived session ids appears under `sessions/`. If a Codex release ever started copying instead, every archived thread would have a twin, and the M1 sweep refuses both — so those threads would drop out of the index loudly, with one failure each, rather than being double-counted. `__tests__/codex-source.test.ts` drives that case.

**§4's `origin_key` says "the session id from `session_meta`"; the shipped source takes the same id from the FILENAME.** The CLI writes it into both — `rollout-<ISO>-<sessionId>.jsonl` — and they agree on **18 of 18** files. The reason is cost, not preference: the frontier is keyed by container id, so an id that only the bytes carry cannot be consulted before reading those bytes, and every rollout would be head-read on every five-minute tick forever. A Codex `session_meta` record carries the CLI's whole `base_instructions` (largest measured: 34,956 bytes), so that is not a cheap read. The working directory still comes from the head record, and that read IS skipped for an unchanged file. A `.jsonl` in a rollout root whose name carries no id is reported as `not-a-rollout` rather than indexed under something invented.

**The authorship gate is new, and §2.2 did not anticipate needing one.** §2.2 says "role at `payload.role`, text at `payload.content[].text`" and stops there, which would index 261 messages. **214 are indexed.** The other 47, measured:

| Dropped                                              | Count | What it is                                                                                                                                        |
| ---------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `developer` role                                     | 20    | Codex's own instructions — `<permissions instructions>`, `<skills_instructions>`, `<collaboration_mode>`, `<model_switch>`                        |
| `user` records that are nothing but injected context | 22    | 9 × the `# AGENTS.md instructions for <path>` dump, 7 × `<environment_context>`, 3 × `<recommended_plugins>`, 2 × `<turn_aborted>`, 1 × `<skill>` |
| `user` records that are a widget click with no words | 5     | The `<ui_action>` block DorkOS injects on a generative-UI button press (five moves of one tic-tac-toe game)                                       |

**Why Codex needs this and claude-code does not**, which reads as an inconsistency until you see where each runtime puts the same text: claude-code delivers `<gen_ui>`, `<agent_identity>`, `<dorkos_context>` and the rest through `systemPromptAppend`, a channel the transcript never records. Codex has no per-turn system channel, so `codex/turn-input.ts` prepends the identical blocks to the user's own message — and they land inside the user's record in the rollout. The gate strips leading machine-written blocks by SHAPE (an opening tag with a newline after it, up to its closing tag) and keeps the remainder, which is the same position-sensitive move `stripRelayContext` already makes for claude-code, and which cannot drift when either side adds a block. Its stated cost: a message that is entirely a tag-shaped block and no prose indexes as nothing — 0 records on this corpus.

**Cross-checked against the family it does not read.** The gate's 214 differ from the `event_msg` family's 219 by exactly the five widget clicks. That is a genuinely independent oracle — a different record family, a different parse path — and it is what makes "we read one family and kept what people said" a measurement rather than a claim.

**§Testing Strategy's benchmark bullet asks the bench to assert equality with an independently computed `response_item` count. It asserts three separate things instead, and the middle one was got wrong first — which is the part worth recording.** `scripts/search-corpus-bench.ts --source codex` counts BOTH message families itself, with its own parser, over the same files, never through the projection.

- **Doubling** fails on `indexed > responseItems`. A projection reading both families lands at **166%** — verified by seeding exactly that defect: 433 rows against 261 records, exit 1.
- **Reading the WRONG family** fails on an EQUALITY against the `event_msg` count. An earlier version of this amendment, and of the script's own comments, claimed the share floor below caught this. **It does not, and no share floor can**: the two families hold the same messages, so an `event_msg`-reading projection lands at 219 of 261 — 84%, inside any sane band, exit 0. That was found by seeding it. What separates them is that the shipped projection's authorship gate makes its count differ from the other family's — 214 against 219 — while the defect's count matches it exactly. Both directions verified: 214 ≠ 219 passes, the seeded 219 = 219 fails with the message naming both numbers. Its one false positive (a corpus where the gate happens to drop exactly the difference) is written down beside the check; the script is run deliberately by a person who can read both counts off the line above it.
- **A projection that indexes almost nothing** fails on the share floor, which is what that floor is actually for, and which is derived rather than picked: 82% on this machine, floored at half.

The unit-test half of the same guard is `codex-projection.test.ts`'s two-families case, which asserts the BODIES are the `response_item` texts rather than only counting rows — a count alone passes for a projection that read the other family. Equality with the `response_item` count, as §Testing Strategy words it, would encode today's ratio of plumbing to speech as a rule. A machine with no Codex asserts nothing and says so.

**A head record too big to scan is now loud.** Found in review. Discovery reads a rollout's first 256 KiB for `session_meta.payload.cwd` — seven times the largest head measured (34,956 B) — but `base_instructions` grows with the CLI, so the window can be outgrown. When it was, the file indexed with no working directory and NOTHING said so: every one of that session's hits would open nowhere while the results looked healthy, which is this document's own G4 failure in miniature. The two cases are distinguishable — a window that FILLED without naming a directory is not a conversation that names none — so the first is warned about by path and the second stays silent. The file is still indexed either way: its messages are what search is for, and dropping a whole conversation to protect against an unknown directory is the larger loss. It is a log line rather than a `DiscoveryFailure` because a failure suppresses the prune for the whole source, and a head that is too big stays too big — that would freeze pruning forever over a container path.

**One carve-out was needed.** `os.homedir()` is banned in `apps/server/src` outside three files; this ticket makes it four. `services/runtimes/codex/codex-home.ts` mirrors the Codex CLI's own `$CODEX_HOME ?? ~/.codex` resolution 1:1, exactly as `claude-config-dir.ts` mirrors the Claude Agent SDK's — and for the identical reason: the index reads files another program wrote, so resolving anything else is DOR-250's split-brain in a second runtime. The carve-out is by filename, pinned in `scripts/test-homedir-guard.sh` alongside a case proving a SIBLING in the same directory is still refused.

**Bench, 2026-08-25, both legs on the machine this was written on:** `claude-code` 497 files / **19,211 messages** / 2.5 s; `codex` 18 files / **214 messages** / 33 ms / 1.8 MB. Codex is **1.1%** of the corpus, and §2.2's argument for it stands unchanged: the multi-runtime cockpit is the product's headline differentiator, and a search box covering one runtime undercuts the claim the product leads with.

**One thing this ticket did NOT do.** The client's scope copy (`message-search-scope.ts`) still lists Codex under what search does not cover. It ships in a separate branch (DOR-685) that had not merged when this landed, so the line moves from "not covered" to "covered" in a follow-up commit once both are on `main`.

## Amendment 9 — OpenCode is indexed, and the port promotion is refused (DOR-688)

**Amends §2.3 in full, the `opencode` row of §2's source table, §1's opening paragraph ("**OpenCode is not in that list**"), and §3's port trigger.**

§2.3 deferred OpenCode on four counts. Three of them still hold, and the design here is what
each of them forced.

**Count 1 — ADR-0308's ban — is narrowed, not dismissed.** The reason for it is real:
`opencode.db` holds `account.access_token`, `account.refresh_token` and `credential.value`
in the same file as its messages. What changed is that the danger turned out to be
answerable structurally. Each sweep copies the store and its `-wal`/`-shm` siblings into a
temp directory, opens the COPY `readonly` + `PRAGMA query_only`, reads through a frozen
allowlist of three tables and eight columns, and deletes the copy in a `finally`. **The live
file is never opened**, so DorkOS is not a participant in the WAL concurrency §2.3 worried
about — a stronger position than the SDK path offers, since the sidecar holds a live
connection and this does not. §9.1's rule ("every projection selects explicit fields") is
not weakened; it is enforced by construction, because `SELECT *` is not expressible when the
column list IS the allowlist. ADR `260825-110420` carries the decision and the amendment to 0308.

**Count 2 — the SDK path — is UNCHANGED and now explicitly forbidden for indexing.** It was
re-evaluated and still fails on its own merits: nothing boots the sidecar at startup, a cold
probe spawns a server as a side effect, and a `peekClient()`-gated indexer makes coverage
nondeterministic. A reconciler on a timer must never spawn somebody else's agent server.
**Every other source in this design reads bytes already at rest, and this one now does too**
— which also discharges the whole "SDK-surface decision blocks everything else" paragraph:
`before`, `start` and `scope: 'project'` are irrelevant to a source that does not use the
SDK, and neither DOR-673's 100-session cap nor DOR-674's exact-directory filter can be
inherited by a read that goes to the file.

**Count 3 — the corpus — is unchanged and was never the argument.** Re-measured 2026-08-25:
**50 messages across 63 top-level sessions**, against 19,124 from Claude Code. The July
figures (`session` 6, `message` 24, `part` 73) were not re-derived at the time because the
store was deliberately not opened, which was the rule working as intended. G4 is why size
does not decide this: a box that silently covers less for one runtime than another is the
failure this document exists to refuse.

**Count 4 — the port trigger — FIRED, and the promotion is REFUSED.** §3 named the arrival
of a third mechanism as the trigger, on the prediction that a third mechanism would need
frontier logic of its own. **It did not.** M3 reuses M2's entire watermark implementation
through a four-function `ContainerReader` seam and contributes ~40 lines
(`snapshot-frontier.ts`): the resume rule, the shrink rebuild, the frontier write and the
prune are shared. A port here would abstract three mechanisms that already share their
implementation. The re-trigger is written down in the ADR rather than left to taste — **a
fourth mechanism whose change detection is neither a byte offset nor a monotonic ordinal, or
a source that lives outside `apps/server`** — the second because the registry is a private
constant in one file, and the day a source must register from somewhere that cannot edit
that file, the registration surface IS the port.

**The `Session.time.updated` caveat was NOT discharged, and an earlier draft of this
amendment wrongly said it was.** §2.3 insisted the watermark be `>=` plus a forced re-read of
any session last seen non-idle. The shipped source does not read `Session.time.updated` — a
session's ordinals are its messages' positions in `(time_created, id)` order, so the
high-water mark is a row count — but **the count inherits the same disease from a different
direction, and adversarial review caught it.** OpenCode creates the assistant `message` row
at turn START and streams its `part` rows in underneath it, mutating them in place as tokens
arrive: measured on the operator's store 2026-08-25, **236 of 236 parts were created after
their message row, 55 of 80 text parts were updated in place, 91 of 94 message rows were
updated after creation, and the last part of a turn landed up to 62 seconds behind it.**

So the count rises at turn start and the content lands for a minute afterwards. Three misses
follow, all reproduced: a sweep landing mid-stream indexes a truncated body and serves it
forever, because the count never changes again; a revert plus a new turn inside one sweep
interval leaves the count exactly where it was; and an in-place `part` edit changes no count
anywhere. §2.3's instinct — force a re-read of anything recently active — was right, and what
was wrong was only its choice of column.

The shipped answer is `OPENCODE_VOLATILE_WINDOW_MS`: fifteen minutes, three sweep intervals,
measured against `message.time_updated` and `part.time_updated` (timestamps, both added to
the read allowlist) rather than the session's turn-start stamp. Any session touched inside
that window is **re-read from ordinal 1, deleting its rows first**, on every sweep until it
settles.

**The delete is not optional, and a first version that skipped it was wrong** — caught in
the verify pass. Letting the upsert rewrite each row in place looks equivalent and is not: a
message that projects to nothing writes no row, so it cannot overwrite what sits at its
ordinal, and a container whose count lands exactly on the index's high-water mark also fails
§5's shrink test (`maxOrdinal < indexedTo` is false at equality). The stale row then answers
at that ordinal forever. **25 of the 75 messages on the operator's store project to
nothing**, so it is reachable. The cost of folding is bounded by who raises the flag —
recently-touched conversations only, never settled ones.

**Two behaviours worth stating because they are the ones a careless version gets wrong.** A
session with a `parent_id` is a subagent's own transcript and is not a container, for the
same reason §2.1 walks past `subagents/**`. And **an absent `opencode.db` is not an empty
one**: it indexes nothing, prunes nothing, and reports no failure, because reading absence as
"every session is gone" would delete an entire indexed corpus the first time the runtime was
uninstalled.

**§1's product statement is now false and the client copy is the follow-up, tracked as
DOR-1556.** The scope copy task 5.2 shipped names OpenCode as not covered. That copy is
deliberately NOT changed in this ticket — the file is in flight on another branch — and
flipping it is the one piece of DOR-688 that lands separately.

**Codex landed first, and this amendment sits on top of it.** DOR-683 (Amendment 8 above)
added the Codex row while this was in review, so the registry is now `rooms`, `claude-code`,
`codex`, `opencode` — three mechanisms over four sources, and §1's sentence is true of every
runtime the product names.

## Amendment 10 — the client copy flip landed (DOR-1556, 2026-08-25)

Amendment 8's "did NOT do" note above and §927–930's "deliberately NOT changed" are resolved:
`message-search-scope.ts` now names Codex and OpenCode in `SEARCH_SCOPE_COVERED`, its pinned
test moved with it, and §1's product statement is true of every source this index registers.

## Amendment 11 — a channel hit lands on the message; a conversation hit does not (DOR-687, 2026-08-26)

Task 6.2 asked whether §8's coordinates can carry the ideation's headline promise — _"You click one
and land where it was said"_ — the rest of the way. The answer is **yes for rooms, no for
transcripts**, and the split is a property of the coordinate rather than a matter of effort.

**Rooms.** `ordinal` for the `rooms` source IS `room_entries.seq` (`projections/rooms.ts:94`), which
is the number the room's own timeline is built on. So the hit already carries an address, and the
client half is a `?entry=<seq>` on `/channels` (and on `/`, which is #team; the one-door redirect
carries it across). The room resolves the `seq` to a ROW, and the shared timeline gained one landing
precedence for it: an asked-for row outranks a remembered position, an unread rule and the newest
message, because it is the only one of the four somebody requested. **No field was added to the wire
and no column to the index**: D11 holds.

Three things that decision dragged in, each of which is a defect if left out:

- **A request is CONSUMED, not held.** The landing is armed once per conversation, and an in-place
  search-param navigation does not change the conversation — so without consumption, clicking a hit
  in the room you are already reading changes the URL and moves nothing. And a request that never
  expired would re-win every REMOUNT, so on a phone, closing a thread panel would throw a reader at
  message 300 back to the message they searched for — the exact thing `resumeRow` exists to prevent.
  The marker is keyed on room + `seq`; a new `seq` re-arms the landing exactly once, and an answered
  one stands down for good. A re-armed landing that cannot be honoured leaves the reader where they
  are rather than restarting the ordinary landing under them.
- **A reply opens its thread.** The room's flow draws the "↳ N replies" row rather than the reply,
  so landing the room and stopping there puts somebody on a collapsed count with the message they
  searched for nowhere in the document. The panel is opened and lands on the reply; the room behind
  lands on the thread's row. One request, two consumers, one consumed-marker each.
- **Focus is not the whole mark.** `scrollToRow`'s "focus IS the flash" holds for a keyboard reader,
  but a row focused PROGRAMMATICALLY after a MOUSE click does not match `:focus-visible` — and
  clicking a search result is the mouse path. So the row also wears a transient `data-landed`,
  styled unconditionally and faded out after ~2s, with a still version under
  `prefers-reduced-motion`. The caret is the durable mark; this is the one that paints.

**Transcripts.** `ordinal` for `claude-code`, `codex` and `opencode` is a running count of the
messages the projection KEPT — person-authored user records and non-sidechain assistant text, with
tool calls, tool results, thinking blocks and command records all skipped
(`projections/claude-code.ts:111-146`, `readSpeech`). The session view holds what `parseTranscript`
returns, which is all of those, and then drops one more class again (`filterKickoffHistory`). The two
numberings are unrelated, so `messages[ordinal]` there is reliably a **different message**. Landing
on the wrong line is worse than landing in the right conversation, so a transcript hit still opens
its conversation and nothing else. Closing that half means carrying a stable per-message id end to
end — the JSONL record `uuid` for Claude Code, and its equivalents elsewhere — rather than
re-deriving the projection's filter in the client; it is a schema change and its own ticket.

**One limit is stated in the product rather than only here.** A room hydrates its trailing page and
nothing pages backwards yet (`useRoomEntries`: _"Scrolling further back than that page is `?before=`,
which the server serves and no client surface asks for yet"_). So a hit older than that page has no
row to land on, and the room says so in one quiet line instead of opening at the bottom in silence —
which looks identical to a link that worked. Back-paging a room is the change that would retire that
sentence, and it is not this one.

## Amendment 12 — a conversation hit lands on the message too (DOR-1579, 2026-08-26)

Amendment 11 closed one half and named the other: _"Closing that half means carrying a stable
per-message id end to end — the JSONL record `uuid` for Claude Code, and its equivalents elsewhere —
rather than re-deriving the projection's filter in the client; it is a schema change and its own
ticket."_ This is that ticket, and the shape is exactly the one it named.

**One nullable column, `messages.message_id`, and it is not an identity.** The dedup key stays
`(source_id, origin_key, ordinal)` — a re-read of a container has to write over the row it wrote
last time, and an id is not what makes two reads of one message the same message here. D11 is
satisfied by a consumer shipping in the same change: the client's `?message=` landing. Nothing is
searchable that was not before; `messages_fts` still indexes `body` and nothing else.

**The backfill is a rebuild, in the same migration.** `0080_message_search_message_id.sql` adds the
column and then runs `DELETE FROM messages; DELETE FROM search_sources;`. The ids live in the stores
this index derives from, so no statement could fill them in — and G2 already says a delete plus a
rebuild is a complete, supported recovery. `DELETE` rather than `DROP`, because `messages_fts_ad` is
what retracts a row's terms from an external-content index and it fires per row. The operational
consequence, stated rather than discovered: **the first sweep after upgrading re-indexes every
container from scratch**, and older results are missing until it finishes.

**Native ids only, and never a synthesized one.** claude-code carries the JSONL record `uuid`, codex
the `response_item`'s `item.id`, opencode the `message.id` row it already read for diagnostics;
rooms carries `null`, because a room hit's `ordinal` IS its `seq` and it has landed since DOR-687. A
record without an id contributes `null`. The rule matters most where it is most tempting to break:
`parseTranscript` falls back to `crypto.randomUUID()` for a record with no `uuid`, which mints a
fresh id per parse — an indexed copy of one would name a message no later read agrees exists, while
looking exactly like an id that works.

**Carrying an id is not the same as being able to land on it, so the client keeps an allowlist.** The
two ids agreeing is a claim about two code paths per runtime, verified by reading both:

- **claude-code — verified.** `projections/claude-code.ts` stores the record `uuid`;
  `transcript-parser.ts` mints `ChatMessage.id` from the same field (`parsed.uuid ||
crypto.randomUUID()`), and `mapHistoryMessage` carries it to the client unchanged.
- **opencode — verified.** `opencode-store.ts` reads the `message.id` column and
  `projections/opencode.ts` carries it; `runtimes/opencode/session-mapper.ts` builds
  `HistoryMessage.id` from the SDK's `info.id`, which is the same id.
- **codex — deliberately NOT on the list.** The index stores a real `item.id` from the rollout file,
  and the session view never reads that file: a Codex conversation is rebuilt from DorkOS's own event
  log, which numbers messages `user-<seq>` / `assistant-<seq>`
  (`services/session/event-log-history.ts`). The two id spaces never intersect, so a `message` param
  would always miss. Codex joins the list the day the event log records the item id it was built
  from, and the id is stored now so that day is a client change alone.

A hit whose source is off the list, or whose id is `null`, opens its conversation exactly as it did
before. **That degrade is the design, not a fallback**: an id either names a row or it does not, and
a miss can never land on a different message, so the failure mode is the behaviour that shipped
in Amendment 11.

**One thing the ticket did not anticipate: the session view FOLDS an assistant turn and the index does
not.** `parseTranscript` emits one message per assistant record and then merges consecutive ones into
a single turn keeping the LAST id, while the projection indexes each record that carries text as its
own searchable message — which is right for search, since each is a separate thing that was said.
Carrying each record's own uuid therefore addressed the rendered turn only when the text happened to
sit in the last record of it, and an agentic turn's rarely does: it ends on a `tool_use` record.
**Measured over 120 real transcripts, 7,352 indexed messages: 23% of messages carried an id that
matched a rendered one** — 80% of what a person typed, 14% of what an agent said.

So `projections/claude-code.ts` folds the turn as it goes and gives every message in it the id of the
record that closes it, which took the same corpus to **90% overall and 92% for assistant messages**.
The fold reads against `parseTranscript` branch by branch, and it is safe to approximate because
**getting it wrong can only cost a landing, never move one**: every rendered id is the uuid of a
record that closed some turn, so a turn folded too short or too long yields an id that matches
nothing. The remaining 10% is mostly CLI-internal (`isMeta`) records, which are treated as turn
enders whether or not the parser emits for them — the conservative direction on purpose.

**Not done, deliberately.** A conversation says nothing when the id names no row, where a room says
one quiet line: a room's limit is real and nameable (it holds one trailing page), while a
conversation holds its history whole, so a miss there means the id no longer addresses anything and
there is nothing a reader could act on. And there is no browser test for this half: the e2e suite
reaches transcript search through no runtime it can seed — `test-mode` is not a search source, and
the three that are read another program's files.
