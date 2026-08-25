# Message search — task breakdown

**Spec:** `specs/message-search/02-specification.md` · **ADR:** `260728-214214` · **Tracker:** DOR-672
**Generated:** 2026-07-29 (DECOMPOSE) · **Canonical file:** `03-tasks.json` — this document is a projection of it, for browsing and diffs.

**11 tasks across 6 phases.** Every task is one PR's worth of work, states its dependencies, and names a verification you **run** — including task 6.2, whose two branches each end in a command even though its first output is a decision rather than code.

## The graph

```
1.1  tables + FTS5 migration
 └─▶ 2.1  rooms + the indexer core
      ├─▶ 3.1  JSONL mechanism + claude-code ──┬─▶ 3.2  every config root
      │                                        └─▶ 4.1  codex ──▶ 6.1  the guide ──▶ 6.3  opencode
      └─▶ 5.1  query + route + access ──▶ 5.3  transport (embed) ──▶ 5.2  the palette ──▶ 6.2  deep linking
```

**Critical path:** 1.1 → 2.1 → 5.1 → 5.3 → 5.2 (a person can search from the palette).
**Widest parallel front:** after 2.1, tasks **3.1** and **5.1** run at the same time — different files, and 5.1 only needs the room source to exercise every access assertion. After 3.1, **3.2** and **4.1** are independent of each other and of 5.1.

| #       | Outcome                                                  | Size   | Deps              |
| ------- | -------------------------------------------------------- | ------ | ----------------- |
| **1.1** | Searchable message storage ships with the database       | medium | —                 |
| **2.1** | Room messages findable; delete-and-rebuild is safe       | large  | 1.1               |
| **3.1** | Claude Code conversations findable, bare CLI included    | large  | 2.1               |
| **3.2** | Every Claude Code profile covered, not just one          | small  | 3.1               |
| **4.1** | Codex conversations in the same results                  | small  | 3.1               |
| **5.1** | One request answers the query, for whoever may see it    | large  | 2.1               |
| **5.3** | Search works in the Obsidian embed, not only the browser | small  | 5.1               |
| **5.2** | Search from the palette, with its scope stated           | medium | 5.1, 5.3          |
| **6.1** | Adding a source is a documented afternoon                | small  | 4.1               |
| **6.2** | Decide whether a result lands you on the message         | small  | 5.2               |
| **6.3** | OpenCode searchable, or the refusal recorded             | large  | 6.1 + DOR-673/674 |

## What DECOMPOSE changed against the specification

**Four findings.** Four things were re-measured and did not come back the way the documents said; all four are carried into the task bodies with their evidence.

1. **A single Claude Code config root is wrong on this machine** (new task 3.2). Three roots exist, all three were written within the last 7 days, and they hold 17,989 / 7,880 / 942 indexable messages. A single-root index sees at most **67%** of the operator's own Claude Code history — and **3.5%** if the server inherits `CLAUDE_CONFIG_DIR` pointing at a minor root, which is exactly what the environment this decomposition ran in had set.

2. **`ORDER BY bm25()` is O(hits), not O(limit)** (task 5.1). Unordered is flat across four orders of magnitude of hit count (0.012–0.017 ms here, 0.011–0.019 ms independently); ranked scales linearly with the number of matching rows. The slope is load-dependent and did not reproduce across three runs, so §6.3's "headroom of more than an order of magnitude" does not hold and no absolute figure from it is quotable. The index shape is right; the calling contract needs a minimum query length and a debounce, which follow from the shape alone.

3. **`search_room_history` is not this ticket's to build** (task 5.1). The spec's Phase 5 and G5 claim it, but `specs/room-participation` §12 lists it under **RP7**, depending on RP6, RP3 and DOR-672 — and RP's Amendment 1 says "RP7 lands after the index and lands directly as a caller". `joinedSeq`, which RP7 needs, still does not exist in any migration.

4. **The malformed-line story is wrong in both directions, and the truth is an implementation constraint** (task 3.1). The corpus has **64 lines that fail `JSON.parse` under Node's `readline` and 0 when the same bytes are split on `\n` alone**. None is a file's final line, and an immediate re-scan reproduces all 64 — so they are neither corruption nor in-flight truncation. **Exactly two characters tear a record: U+2028 and U+2029.** Measured on Node v24.14.1, `readline` splits on LF, CR, U+2028 and U+2029; **U+0085 NEL, VT and FF are inert**. The arithmetic closes without NEL — 34 LS + 12 PS across 19 records give 65 fragments, 1 empty, 64 malformed — and a main-session file holding 2 NEL and no LS/PS yields 0. The corpus has never had a malformed line; both earlier measurements were measuring their own reader. **The frontier reader must treat `\n` as the only line terminator**, and a record with _k_ tearing separators yields _k+1_ fragments, not two.

**All four are amended into `02-specification.md` itself, as five amendments** (Amendments 1–5 — four findings plus Amendment 4, which is the provenance table rather than a finding), not only recorded here — a reader who picks up DOR-684 opens §6.3, not this file. Amendment 5 carries finding 3: it removes scope, it initially landed only in the tickets, and that was the lapse this whole amendment block exists to prevent. Amendment 4 marks every remaining figure as re-derived or **[not re-derived]**, so nothing reads as measured when it is merely inherited.

**On the latency numbers specifically:** three independent runs produced three different absolute figures spanning ~2x, because all were taken on a loaded shared workstation. Only the **shape** — unordered flat, ranked linear in hits — reproduced. The absolutes are marked machine- and load-dependent and must not be used as a regression threshold; derive one on the machine you run on. This scoping applies to latency only: the index **size** figures are corroborated by surviving artifacts (`idx.db` and `final.db` are each 30,621,696 bytes = 29.20 MB) and are cited as measured.

## What was checked and held

- FTS5 present in `better-sqlite3@12.11.1` / SQLite 3.53.2; `bm25()`, `snippet()`, `highlight()` all callable.
- **The column-name trap is real**: with a mismatched FTS column name, `MATCH` and `bm25()` keep working while `snippet()` fails with `SQL logic error`.
- **Stemming is what makes the story work**: `MATCH 'dogs'` returns 1 hit under `unicode61` and 3 under `porter unicode61`.
- No FTS5, `bm25`, `snippet(` or virtual table anywhere in `apps/` or `packages/`; 37 migrations, none virtual.
- Codex reproduces exactly: 16 files, 2,114 lines, 0 malformed, timestamps on 2,114/2,114, **223** `response_item` messages against **203** `event_msg` — the double-count trap is real and worth its test.
- The vanished-`cwd` figures reproduce exactly: **33 files, 288 messages**.
- `readFromOffset` does advance to `stat.size` unconditionally and has no production consumer.
- The `not-admitted` obligation (§9.2) is genuinely recorded in `specs/community-adapter/02-specification.md` at three places, so it is not dropped — it is not a task here because the `not-admitted` path does not exist yet.

## Sequencing against open work

- **DOR-634 PR 3 has landed** (migration `0038`), and it handled this. It deletes both the `messages` rows and the `search_sources` rows of every room it retires, scoped to those rooms rather than to `source_id = 'rooms'` wholesale — so rooms that keep their entries keep their watermark, and a parent that received appended entries picks them up on the next sweep because they landed above it. Task 2.1 has nothing to work around.
- **DOR-673 / DOR-674** (OpenCode adapter: a silent 100-session cap, and sessions in subdirectories never listed) block **6.3**. An indexer over a session list that silently truncates inherits the truncation.
- `apps/server/src/services/rooms/`, `apps/e2e/` and `apps/client/` are under active edit by other agents as of 2026-07-28. Tasks 2.1 and 5.2 note the overlap.

## Next stage

**EXECUTE** — `/flow:execute specs/message-search/02-specification.md`.

---

# Tasks

> Parsed by the DECOMPOSE skill's recovery path (`^### Task (\d+)\.(\d+): (.+)$`) when `03-tasks.json` is missing or malformed. `03-tasks.json` stays canonical; these headings exist so the documented fallback can actually run.

### Task 1.1: Searchable message storage ships with the database

- **Issue:** DOR-679 · **Phase 1** — P1 — Foundation: the tables · **Size** medium · **Priority** high
- **Depends on:** none · **Parallel with:** none
- **Active form:** Adding the message-search tables and the FTS5 migration

Add the two real tables and the one virtual table that every later task writes into, and prove through the real migrator that FTS5 behaves the way the design assumes.

## Scope

- `packages/db/src/schema/search.ts` — Drizzle definitions for `messages` and `search_sources`, exactly the columns in spec §4. `messages`: `id INTEGER PRIMARY KEY`, `source_id TEXT NOT NULL`, `origin_key TEXT NOT NULL`, `ordinal INTEGER NOT NULL`, `role TEXT NOT NULL`, `created_at TEXT` (nullable), `body TEXT NOT NULL`, `UNIQUE (source_id, origin_key, ordinal)`. `search_sources`: `source_id`, `origin_key`, `byte_offset`, `size_bytes`, `mtime_ms`, `last_ordinal`, `container_path`, `last_indexed_at TEXT NOT NULL`, `last_error`, `PRIMARY KEY (source_id, origin_key)`.
- Register the new schema file in BOTH places, which fail differently: the `schema` array in `packages/db/drizzle.config.ts` (omit it and `db:generate` silently ignores the table) and the barrel `packages/db/src/schema/index.ts` (omit it and generation still works while every typed query fails to compile).
- A hand-written migration `packages/db/drizzle/0037_message_search.sql`. Drizzle cannot express an FTS5 virtual table — `drizzle-orm@0.45.2/sqlite-core` exports no virtual-table builder. The precedent for hand-authoring is `0011_tasks_system_redesign.sql:1-5`; `0012` and `0013` are byte-identical to generated output and are not precedent. The migration creates:
  - `CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='porter unicode61');`
  - the three sync triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE` on `messages`), using the external-content `INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.id, old.body)` form for delete/update.
- The snapshot chain, which is the trap: copying the previous snapshot verbatim fails with a parent collision AND EXITS 0. The new snapshot needs a fresh `id` with `prevId` pointing at the previous snapshot, plus a `_journal.json` entry.

## Two facts that are load-bearing and were re-verified on 2026-07-28 by running them, not by reading

1. **The FTS5 column MUST be named `body`, matching the content table's column.** With `content='messages'`, FTS5 re-reads the original text by column name. Verified against a deliberately mismatched name: `MATCH` and `bm25()` keep working and `snippet()` fails at runtime with `SQL logic error`. A MATCH-only test passes straight through this bug.
2. **`porter unicode61` is what makes the user story work.** Verified: against bodies containing `dog`, `dogs` and `DOGGED`, `MATCH 'dogs'` returns **1** hit under bare `unicode61` and **3** under `porter unicode61`.

Also re-verified today on `better-sqlite3@12.11.1`: `sqlite_version() = 3.53.2`, `ENABLE_FTS5` present in `pragma compile_options`, and `bm25()`/`snippet()`/`highlight()` all callable. Note `packages/db/package.json` declares the RANGE `^12.11.1`, not a pin, so a minor bump can arrive without a commit here — the assertions below are what hold the guarantee, not the manifest.

## Verification (run these; each fails loudly if the feature is absent or subtly wrong)

```bash
pnpm --filter @dorkos/db build
bash scripts/assert-migrations-current.sh          # must print its success marker
pnpm vitest run packages/db/src/__tests__/message-search-migration.test.ts
```

The test builds its database by running the REAL Drizzle migrator over the committed migrations (never by executing raw SQL inline — that would test the test's SQL, not the shipped migration), then asserts:

- `snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)` returns a string containing `<mark>`. **Fails with `SQL logic error` if the FTS column is misnamed** — this is the assertion that catches trap 1.
- Rows with bodies `dog`, `dogs`, `DOGGED` all match `MATCH 'dogs'` — exactly 3 hits. **Returns 1 under the wrong tokenizer.**
- After `UPDATE messages SET body = 'cats'` on an indexed row, the old term no longer matches and the new one does; after `DELETE FROM messages`, `SELECT count(*) FROM messages_fts` is 0. **A missing `AFTER DELETE`/`AFTER UPDATE` trigger leaves orphan index rows and this goes red.**
- `PRAGMA integrity_check` returns `ok` AND `INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')` does not throw (the second is the FTS5-specific check; the pragma alone does not inspect FTS5 internals).

## Dependencies

None. This is the root of the graph and the only task with no predecessor.

**Do not collide with:** nothing in `packages/db/drizzle/` may be renumbered. If another branch lands a migration first, rebase and renumber this one to the next free index — the migration number is not semantic.

### Task 2.1: Room messages become findable, and deleting the index is a safe recovery

- **Issue:** DOR-680 · **Phase 2** — P2 — Rooms, and the indexer core · **Size** large · **Priority** high
- **Depends on:** 1.1 · **Parallel with:** none
- **Active form:** Indexing the room log and building the indexer core

Index the room log end to end, and land the shared machinery every later source reuses. Rooms go first because DorkOS owns the write, so any bug here is ours and cheap to see.

## Scope

New service domain `apps/server/src/services/search/` (warranted under `.claude/rules/server-structure.md`: a cohesive area with several related services, not an orphan file):

- `registry.ts` — the source array. One row per source: `{ id, mechanism, resolveRoots, project }`. Nothing else varies per source. This is deliberately a record, not a `SearchAdapter` port: a port abstracting two mechanisms and three functions is a class hierarchy standing where a record would do (spec §3, D12).
- `row-frontier.ts` — **M2**: discovery is the container list; change is `max(seq) > frontier`; incremental read is `WHERE seq > ?`.
- `projections/rooms.ts` — a PURE function (no filesystem, no database access) from `room_entries` rows to `messages` rows. `origin_key = roomId` (later `` `${communityRef}:${roomId}` `` — the projection composes it, the index never parses it), `ordinal = room_entries.seq`, `container_path = NULL` because a room is not a directory.
- `indexer.ts` — the reconciler and the startup sweep. Interval **300_000 ms**, matching the three that already exist (`mesh-core.ts:391`, `task-reconciler.ts:16`, `workspace-reconciler.ts:15`). One transaction per container, never one per row. Plus immediate write-through on the room path, where DorkOS already owns the write.
- Prune, which is two different things a single word hides (spec §6.4): a container that is **gone** has its frontier row and its `messages` rows deleted; a container that is **intact but whose working directory has vanished** is NEVER pruned. For rooms only the first case can arise.
- `last_error` on `search_sources` is written whenever a projection throws, and the sweep continues to other sources. This is not decoration — the ADR's sharpest recorded negative is that a projection broken by an upstream format change fails SILENTLY, and a source that stops contributing rows is otherwise indistinguishable from a source with nothing new.

## Verification

```bash
pnpm vitest run apps/server/src/services/search/__tests__/
pnpm --filter @dorkos/server typecheck
```

Four assertions, each written so it goes red when the mechanism is deleted:

1. **Rebuild equals incremental** — the highest-value test in the suite, because it is what makes "delete it and rebuild" a trustworthy recovery rather than a hope. Seed a fixture room, index incrementally across three separate sweeps with new entries between each, and capture `messages` ordered by `(source_id, origin_key, ordinal)`. Then `DELETE FROM messages; DELETE FROM search_sources;`, rebuild in one pass, and assert the two row sets are deep-equal on every column except the autoincrement `id`. **An off-by-one watermark shows up here as a duplicated or missing row and nowhere else.**
2. **A no-op sweep is genuinely a no-op.** After a full index, run another sweep with no new entries and assert the sweep REPORTS zero new rows. Do not assert only that `count(*)` is unchanged — a sweep that re-reads every row and upserts leaves the count unchanged too, so a count assertion passes for both the correct and the broken implementation. Assert the reported count.
3. **`last_error` becomes visible.** Register a source whose projection throws, run a sweep, and assert: that source contributes zero rows, its `search_sources.last_error` is non-null and names the failure, the OTHER source still indexed normally, and the sweep itself resolved rather than rejecting.
4. **The reconciler interval is 300_000.** Import the constant and assert it, so a stray edit to the timer is a red test rather than a silent five-minute-to-five-second change.

## Dependencies

- **Blocked by 1.1** (the tables must exist).
- **Sequenced against DOR-634 PR 3, which has since landed as migration `0038`.** It retired `rooms.parentId` / `rooms.rootEntryId` / the `thread` room kind and reallocated seqs, which is what this task uses as both `ordinal` and the M2 watermark. Recorded because the shape recurs, not because anything is outstanding:
  - Rows moved out of a retired thread room reappear under the parent room's `roomId` with a NEW `seq`. Their old `messages` rows, keyed on the old `origin_key`, become orphans that no watermark will ever revisit.
  - The fix is cheap and is the ADR-0043 recovery story, but it is **two** statements rather than the one this bullet originally called for. Deleting the `search_sources` row alone resets the watermark and leaves the indexed `messages` copies behind for good, because the next sweep writes rows for rooms that exist and never revisits one that does not. `0038` deletes from `messages` first — as a plain statement, so the `messages_fts_ad` trigger retracts the text from FTS5 — and from `search_sources` second.
  - Had PR 3 landed BEFORE this task there would have been nothing to invalidate. It landed after the tables shipped in `0037` and before any indexer ran, so in practice both statements matched zero rows; they are there for the install where they would not.
- `apps/server/src/services/rooms/` is under active edit by another agent as of 2026-07-28. This task adds a new domain and should not need to modify `services/rooms/` at all; if it does, coordinate first.

### Task 3.1: Your Claude Code conversations become findable, including ones you ran from the bare CLI

- **Issue:** DOR-681 · **Phase 3** — P3 — Claude Code · **Size** large · **Priority** high
- **Depends on:** 2.1 · **Parallel with:** 5.1
- **Active form:** Adding the JSONL mechanism and the Claude Code source

Add the append-only-JSONL mechanism and the Claude Code source. This is where the corpus and the value are: re-measured on 2026-07-28 against `~/.claude`, this source contributes **17,989 indexable messages from 236 files (671.8 MB)**.

## Scope

- `jsonl-frontier.ts` — **M1**: discovery walks a root; change is `(size, mtime)` against the frontier; incremental read resumes at the stored byte offset.
  - **Line boundaries are this reader's problem and the shipped `readFromOffset` does not solve them.** `transcript-reader.ts:599-611` advances `newOffset` to `stat.size` unconditionally, so a read landing mid-line returns a truncated final record AND consumes its bytes. It is also claude-path-shaped (`getTranscriptsDir(vaultRoot) + '/' + sessionId + '.jsonl'` cannot express a Codex rollout path), allocates the whole delta into one buffer, and has no production consumer. Do not reuse it. What transfers is the `(mtimeMs, size)` idea from `getTranscriptETag` (`:507`), which is two lines. The new reader retains any trailing partial line and advances the offset only past the last COMPLETE line.
  - **Shrink means rebuild that file.** A file smaller than its recorded `size_bytes` was truncated or replaced; reset the frontier row and re-read from zero. A byte offset into a rewritten file points at the middle of a line.
- Recursive discovery that excludes by DECISION, not by glob depth:
  - Subagent transcripts (`<slug>/<sessionId>/subagents/**.jsonl`, nested as deep as `subagents/workflows/<wf>/`) are excluded — they are conversations the human never had. The shipped adapter already drops sidechain transcripts at list level (`transcript-reader.ts:310-325,438`), so this follows precedent.
  - Eval-harness sandboxes are excluded on the same test. Detection is the repo's own constant, not a heuristic: `SANDBOX_PREFIX = 'dorkos-evals-'` (`packages/evals/src/runner/sandbox.ts:23,59`). A main-session file is an eval sandbox iff its **head-record `cwd`** contains a path segment beginning `dorkos-evals-`. Test the `cwd`, NEVER the directory slug — `cwd.replace(/[^a-zA-Z0-9-]/g, '-')` (`transcript-reader.ts:51-53`) collapses `/`, `.` and `_` all to `-` and is non-invertible.
  - Plugin artifacts (`<slug>/vercel-plugin/skill-injections.jsonl`) are excluded.
  - **Discovery still WALKS the tree rather than globbing `projects/*/*.jsonl`**, because a one-level glob would exclude subagents by accident of depth rather than by decision — and the day someone wants them, the change must be a predicate, not a rewrite.
- `projections/claude-code.ts` — pure. `origin_key` = the session id (the JSONL filename stem), `ordinal` = index of the message within the file, `container_path` = the head record's `cwd` (`transcript-reader.ts:104-106`), never the lossy slug.
- The root is the ACTIVE Claude account's `projects/`. Use `resolveActiveClaudeRoot()` (`services/runtimes/claude-code/claude-config-dir.ts`); hardcoding `~/.claude` "silently split-brains" (DOR-250). **Single root only in this task — task 3.2 makes it a set, and 3.2 exists because a single root is measurably wrong on the operator's own machine. `resolveClaudeRootSet()` already returns that set (DOR-729 shipped it), so 3.2 is mostly a matter of calling it from the registry row.**
- `scripts/search-corpus-bench.ts` — a committed, env-gated script that rebuilds from the operator's real transcripts and prints `roots=… files=… messages=… rebuildMs=… dbBytes=…`. This is the artifact tasks 3.2, 4.1 and 5.1 all measure with.

## Verification

```bash
pnpm vitest run apps/server/src/services/search/__tests__/jsonl-frontier.test.ts
pnpm vitest run apps/server/src/services/search/__tests__/claude-code-projection.test.ts
pnpm vitest run apps/server/src/services/search/__tests__/discovery.test.ts
node --experimental-strip-types scripts/search-corpus-bench.ts   # real corpus, prints its numbers
```

Frontier tests, table-driven over temp fixtures:

- A file that GREW → resumes at the offset, no duplicate rows.
- **A file that grew by HALF A LINE** → write a complete record plus the first 20 bytes of the next one, re-index, and assert the complete record IS indexed, the partial is NOT, and `byte_offset` equals the position after the last newline — **not `stat.size`**. This is the assertion the shipped `readFromOffset` fails.
- A file that SHRANK → frontier row reset, full re-read, no duplicates.
- A file that VANISHED → its `messages` rows are deleted.
- **A file whose `cwd` vanished but which is intact → rows are KEPT.** This is the §6.4 asymmetry and it is the one a well-meaning cleanup gets wrong. Re-measured today: 33 files with a vanished `cwd` hold **288 messages** in `~/.claude` — 1.60% of that root's messages, not the "quarter of your history" an early draft claimed. The rule survives on a smaller and better argument: deleting recoverable data to avoid rendering a caveat is the wrong trade at any percentage.

Discovery test — the trap here is that a naive assertion cannot distinguish the two implementations. Build a fixture root holding a main session, a `<sessionId>/subagents/x.jsonl`, a nested `subagents/workflows/wf/y.jsonl`, a `vercel-plugin/skill-injections.jsonl`, and a main session whose head `cwd` is `/tmp/dorkos-evals-abc123/repo`. **Assert on the discovery function's reported skipped set, not only on the indexed count** — a one-level glob produces an identical indexed count while never having visited the nested paths, so a count-only assertion passes for the implementation this task exists to avoid.

Projection table test: a well-formed message; an empty-text message (skipped); a `tool_result`-bearing user record (its sibling `text` blocks suppressed, per `transcript-parser.ts:321-331`); a `thinking` block (skipped); a malformed line (skipped, counted, file continues).

Corpus bench, on the operator's machine today — these are the numbers to expect, re-derived by measurement on 2026-07-28 rather than carried forward: **236 files, ~17,989 messages, 16.8 MB of text** from `~/.claude` (the specification's 241/17,953/16.80 MB, one day older). Assert `messages >= 15000` and `rebuildMs <= 30000`; the spec measured 2.69 s for this corpus, so 30 s is an order of magnitude of headroom and still fails on a genuine regression.

**Split on `\n` and nothing else. This is the trap that would otherwise ship.** §2.1's account of malformed lines is wrong in both directions and the truth is an implementation constraint (spec Amendment 3). Re-measured: the corpus contains **64 lines that fail `JSON.parse` when read with Node's `readline`, and 0 when the same bytes are split on `\n` alone.** None of the 64 is the final line of its file, and an immediate re-scan reproduces all 64 — so they are neither corruption nor the in-flight truncation §2.1 claims.

**Exactly two characters are responsible, and NEL is not one of them.** Measured on Node **v24.14.1**, one separator per file, counting lines emitted: `readline` splits on **LF, CR, U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR**. **U+0085 NEL, U+000B VT and U+000C FF are inert.** `JSON.stringify` escapes none of LS/PS/NEL and all three are legal raw inside a JSON string, so a runtime writing whole records emits them as-is — but only LS and PS tear a record apart.

The arithmetic closes exactly and closes without NEL: **34 × U+2028 and 12 × U+2029 across 19 records** → `46 + 19 = 65` fragments, of which **1 is empty** (two adjacent separators) and is skipped as blank → **64** unparseable fragments. The **44 × U+0085** in the corpus contribute **zero**; a main-session file carrying 2 NEL and no LS/PS yields **0** malformed lines.

So: **the frontier reader treats `\n` as the only line terminator** and never uses `readline`, or any splitter honouring Unicode line terminators. The corpus has never had a malformed line; both earlier measurements were measuring their own reader.

**Required test, with the counts stated because the obvious ones are wrong.** A record holding _k_ tearing separators becomes _k+1_ fragments — not two. Build a fixture record whose JSON string content contains **one U+2028, one U+2029 and one U+0085**:

- Under a correct `\n`-only reader: **1 row**, text intact, all three separators round-tripping.
- Under a `readline` reader: **3 fragments, 0 rows, 3 skipped-line counts** — because the two tearing separators cut the record into three, and NEL does not cut at all.
- Keep the U+0085 in the fixture deliberately, **as a control that must round-trip under BOTH readers**. Do not assert that NEL round-trips only after the fix: it round-tripped all along, and that assertion goes red against correct code.

**Build the fixture with code-point arithmetic** — `String.fromCharCode(0x2028)` — never a literal and never an escape sequence inside a shell-bound string. A literal U+2028 in a `.ts` file is itself a JavaScript source line terminator and a syntax error, and an escape renders to a literal before it reaches the file. This bug bites the tooling written to study it; it cost two people time already.

**Compaction test (spec §Testing Strategy, currently owned by no other task).** A fixture with an `isCompactSummary` marker followed by further content, asserting the marker is **not** treated as a truncation and that post-marker messages are indexed. This is load-bearing for M1 byte-offset correctness: §5's whole argument for a byte offset surviving compaction is that a compact boundary is a line in a growing file rather than a rewrite. Re-verified 2026-07-29 across the corpus — **28 files carry markers, 74 marker lines in total, and 0 files end at a marker** — so the fixture encodes the measured case.

## Dependencies

- **Blocked by 2.1** (the registry, indexer and prune live there; M1 has no consumer without them, and landing it earlier would be dead code).
- Can run in parallel with **5.1** — different files, and 5.1 only needs the rooms source to exercise its access join.

### Task 3.2: Search covers every Claude Code profile on the machine, not just whichever one the server started with

- **Issue:** DOR-682 · **Phase 3** — P3 — Claude Code · **Size** small · **Priority** high
- **Depends on:** 3.1 · **Parallel with:** 4.1, 5.1
- **Active form:** Making search cover every Claude Code config root

**This task exists because a measurement contradicted the spec, not because the spec asked for it.** The spec resolves ONE Claude Code projects root, via what was then `resolveClaudeConfigDir()` = `$CLAUDE_CONFIG_DIR ?? ~/.claude`. (DOR-729 has since replaced that helper with `resolveActiveClaudeRoot()` for the single active root and `resolveClaudeRootSet()` for the set, so this task is now largely a matter of reading from the set.) On the operator's own machine that silently loses most of the corpus the feature promises.

## The measurement (2026-07-28, this machine, read-only)

Three Claude config roots exist and **all three were written within the last 7 days** — 143, 78 and 28 main-session files modified respectively, so none is abandoned:

| Root         | Indexed files | Indexable messages |
| ------------ | ------------- | ------------------ |
| `~/.claude`  | 236           | 17,989             |
| `~/.claude2` | 120           | 7,880              |
| `~/.claude3` | 28            | 942                |
| **Total**    | **384**       | **26,811**         |

A single-root index sees at most **17,989 of 26,811 messages — 67%**. And the failure is not bounded at 67%: this very agent session runs with `CLAUDE_CONFIG_DIR=/Users/doriancollier/.claude3` inherited from its shell, so a DorkOS server launched the same way indexes **942 of 26,811 — 3.5%** — while reporting no error, because a short result list looks exactly like a complete one.

That is the failure shape the spec's own G4 refuses ("a search box that silently covers less for one runtime than another") applied to a case the spec did not anticipate: covering less for the SAME runtime, depending on an environment variable.

**Why the spec got this wrong is worth recording.** Resolving the single active root (`resolveActiveClaudeRoot()` today) is exactly right for its existing job — reading back a transcript for a session DorkOS itself just ran, where DorkOS must resolve the identical directory the SDK wrote to (DOR-250). The index asks a different question: where does the operator's history live? Those are different questions and the spec inherited the answer to the first.

## Scope

- The claude-code registry row's root resolver returns a **set of roots**, not one. **Call `resolveClaudeRootSet()`** — DOR-729 shipped it, and it already returns the active root, `$CLAUDE_CONFIG_DIR` when set, `~/.claude`, and every registered account, filtered to the directories that hold a `projects/` subdirectory. That alone fixes the catastrophic case (server inherits a minor root and indexes 3.5%).
- Additional roots come from user config, so `~/.claude2` and any future profile can be added without a code change. That config already exists: DOR-729 added `runtimes.claudeCode.accounts` (path plus label) and folds every registered account into the root set, so no new config field is needed here. Its default is `[]`, meaning "just the two above".
- **Do not auto-glob `~/.claude*`.** It is a guess, and on this machine it would sweep up `.claude-worktrees` and `.claudekit`, which are not config dirs.
- Roots that do not exist are skipped silently; a root that exists but fails to read contributes one `search_sources.last_error` and zero rows, per the per-source degradation rule (G3).
- Session ids are UUIDs, so `origin_key` collision across roots is not a practical risk — but `search_sources` is keyed `(source_id, origin_key)`, so if two roots ever did hold the same session id the second would silently overwrite the first's frontier. Assert distinctness in the test below rather than assuming it.

## Verification

```bash
pnpm vitest run apps/server/src/services/search/__tests__/claude-roots.test.ts

# Real machine, both orderings — the second is the one that fails today
node --experimental-strip-types scripts/search-corpus-bench.ts
CLAUDE_CONFIG_DIR=$HOME/.claude3 node --experimental-strip-types scripts/search-corpus-bench.ts
```

- The unit test builds two temp roots, points `CLAUDE_CONFIG_DIR` at the first and the stubbed home at the second, puts one distinct session in each, and asserts BOTH are indexed and their `origin_key`s differ. **Fails today: only one root is read.**
- The bench must PRINT the resolved root set, and the second invocation must report a message count within a few dozen of the first (both runs cover the union), not a count 19× smaller. Assert `roots.length >= 2` and `messages >= 18000` on the second invocation. **The `messages` floor is what makes this unfailable-proof — a root set of length 2 that still reads only one root would satisfy a `roots.length` assertion alone.**

## Dependencies

- **Blocked by 3.1** (the claude-code source and the bench script land there).
- Independent of 4.1, 5.1 and 5.2 — touches only the claude-code root resolver plus one config field.

## Open question resolved here

_Should DorkOS discover profiles automatically, or should the operator list them?_ **Resolved: neither alone.** The union of `$CLAUDE_CONFIG_DIR` and `~/.claude` is free and provably correct, because those are the only two paths the SDK itself can have written to in a given process. Anything beyond that is an operator fact DorkOS cannot infer without guessing, so it is configuration. Recorded here rather than deferred because a v1 that ships only `$CLAUDE_CONFIG_DIR ?? ~/.claude` would be wrong on the machine of the person who commissioned the feature.

### Task 4.1: Codex conversations show up in the same results as everything else

- **Issue:** DOR-683 · **Phase 4** — P4 — Codex · **Size** small · **Priority** medium
- **Depends on:** 3.1 · **Parallel with:** 3.2, 5.1
- **Active form:** Adding the Codex rollout-file source

Add Codex as one registry row and one pure projection inside the mechanism task 3.1 already built. This is the task that proves "adding a source is one function and one row" — if it turns out to be more than that, the claim in ADR 260728-214214 is wrong and that is worth saying out loud.

**The case for Codex is not volume.** Re-measured 2026-07-28: 16 files, 6.6 MB, 2,114 lines, **223 indexable messages** — about 1.2% on top of Claude Code's ~17,989. The case is that the multi-runtime cockpit is the product's headline differentiator, and a search box covering one runtime undercuts the claim the product leads with.

## Scope

- `projections/codex.ts` — pure, ~20 lines. Role at `payload.role`, text at `payload.content[].text`, timestamp from the top-level `timestamp`. `origin_key` = the session id from `session_meta`, `ordinal` = the index of the `response_item` within the file, `container_path` = `session_meta.payload.cwd`.
- One registry row: mechanism **M1** (append-only JSONL, byte-offset tail — identical to Claude Code), root `${CODEX_HOME ?? ~/.codex}/sessions/YYYY/MM/DD/` plus the flat `archived_sessions/`.

## The one trap, named so it is not discovered

**The same messages appear in TWO families and the projection must read exactly one.** Re-verified today across all 2,114 lines: `response_item` yields **223** messages; `event_msg` (`agent_message` / `user_message`) yields **203**. Reading both double-counts nearly every message. Read `response_item` ONLY.

Full line-type census, re-verified today and matching the spec exactly: `response_item` 1,151 · `event_msg` 882 · `turn_context` 60 · `session_meta` 16 · `world_state` 4 · `compacted` 1. **0 malformed lines**, and a top-level `timestamp` on **2,114 of 2,114** lines. Exactly one `session_meta`, always line 1; 16 distinct session ids, none in two files.

## Why this reads the rollout files rather than DorkOS's own event log

Recorded because it is the option a reviewer will otherwise propose. `session_events` fails on four counts: coverage (455 rows across 2 sessions, and Claude Code never writes there at all), permanent trimming (`EVENT_LOG_MAX_EVENTS = 5000` per session — and unlike JSONL, the trimmed table IS the original, so a rebuild does not bring it back), delta shape (assistant text arrives as `text_delta` fragments carrying no message identity, so a row in isolation is not a searchable unit), and no usable timestamp (455 rows carry 9 distinct `created_at` values — turn flush time, not message time).

And no ADR forbids the rollout files: the phrase "never read or written directly" occurs exactly once in the whole decisions corpus and it is about OpenCode. `codex-runtime.ts:732`'s "SDK-internal" is a TSDoc on one stub method explaining why it returns nothing — no rationale, no enforcement. Absence of a prohibition is not authorization, which is why the coupling is recorded in ADR 260728-214214 rather than assumed.

## Verification

```bash
pnpm vitest run apps/server/src/services/search/__tests__/codex-projection.test.ts
node --experimental-strip-types scripts/search-corpus-bench.ts --source codex
```

- **The double-count fixture is the gate.** One rollout file containing a `response_item` pair (one user, one assistant) AND the sibling `event_msg` pair (`user_message`, `agent_message`) carrying the same two texts. Assert **exactly 2 rows**, not 4, and assert the two bodies are the `response_item` texts. A projection reading both families produces 4 and goes red. This is the test most likely to catch a real regression.
- Table tests matching 3.1's shape: well-formed, empty-text (skipped), malformed line (skipped and counted, file continues), and a `session_meta`-only file (0 rows, no error).
- The bench must report a Codex message count equal to an independently computed `response_item` count over the same files — not a hardcoded 223, because the corpus grows. Compute both in the bench and assert equality; a double-count makes them differ by ~90%.

## Dependencies

- **Blocked by 3.1** (M1, the JSONL frontier and the bench script all land there). Codex adds no mechanism.
- Independent of 3.2 and 5.1; the only shared file is one line in `registry.ts`.

### Task 5.1: One request answers "where did we talk about X", and answers it only for whoever may see it

- **Issue:** DOR-684 · **Phase 5** — P5 — Query, access and surfaces · **Size** large · **Priority** high
- **Depends on:** 2.1 · **Parallel with:** 3.1, 3.2, 4.1
- **Active form:** Building the search query, route and access model

The query path, the access model, and the one route. Everything before this task fills a table nobody can read yet.

## Scope

- `search-service.ts` — the ranked query of spec §6.1: join `messages_fts` to `messages`, `ORDER BY bm25(messages_fts)`, `LIMIT`, with `snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)` as the excerpt.
- `apps/server/src/routes/search.ts` — `GET /api/search?q=&limit=&source=` returning `{ results: SearchHit[], warnings: SourceWarning[] }`. `warnings[]` is ADR-0310's envelope, reused rather than reinvented: a source whose projection failed contributes zero hits and one warning naming it, never a failed request and never a blank list. No existing route changes.
- **The visible-set join.** The caller's visible container set is resolved by the shipped `RoomService.requireVisibleRoom` path and applied as `source_id = 'rooms' AND origin_key IN (...)`. The **owner path omits the clause entirely** rather than building a set of every container — a filter that has to enumerate everything silently starts excluding things the day enumeration misses one.
- **Scope the clause by `source_id` as well as `origin_key`.** This is not cosmetic: `origin_key` is opaque and composed per source, so it is unique WITHIN a source and carries no guarantee across sources. A bare `origin_key IN (...)` would let a room key collide with a session key and leak a session row to an agent.
- **Sessions are owner-only in v1**, and no MCP caller reaches them. Two open holes are why: `mcp-server.ts:81-84` resolves ONE Relay sender identity for the whole external MCP surface (`EXTERNAL_MCP_SENDER = 'relay.external.mcp'`, DOR-514); and `middleware/agent-identity.ts:11-17` states "this middleware never rejects a request … identity is attribution, not authorization", so a caller omitting `X-DorkOS-Agent` falls through to `next()` and resolves at `routes/room-caller.ts:70` to the install owner — who "may see every room" (`room-service.ts:797-816`). Absence is never consent.
- **A minimum query length and a debounce on the caller-facing contract** — see the measurement below, which is the reason.

## The latency budget: assert the shape, derive the numbers

Spec §6.3 says top-20 with `snippet()` is 0.21–4.55 ms and claims "headroom of more than an order of magnitude". Spec Amendment 1 retires that conclusion. **Read Amendment 1, not this summary, and do not copy any absolute figure out of either.**

**Three independent runs of the same benchmark produced three different absolute figures, spanning roughly 2x in each direction**, because every one was taken on a shared workstation under whatever load the other agents were generating. **No absolute reproduced. The shape reproduced every time:**

1. **Unordered is flat** across four orders of magnitude of hit count — 0.011–0.019 ms in two independent runs. The join and the match are effectively free.
2. **`ORDER BY bm25()` is O(hits), not O(limit)** — linear in the number of matching rows, because bm25 must score every match before `LIMIT` can discard any. Measured slopes ranged 0.375–1.03 µs/row across runs; linearity held in all three, and hit counts were identical across runs (`opencode` 414, `migration` 886), so the runs differ only in machine conditions.

**Two consequences, both of which follow from the shape alone and need no absolute:**

- **A minimum query length and a debounce are part of this route's contract, not an optimisation.** Typing `t` → `th` → `the` fires three queries whose cost _rises_ as the query gets more specific, and the first two are simultaneously the most expensive and the least useful. G1's "fast enough to feel like typing" is a property of what the caller sends, not of FTS5.
- **The regression threshold is derived on the machine it runs on, never inherited from a document.** A millisecond budget hard-coded out of the spec is either meaninglessly loose or flaky. Measure the flat unordered baseline and the ranked slope in the same run and assert on the **ratio and the linearity**, which are stable across load, rather than on a wall-clock figure, which is not.

Nothing in the design changes: external content, the tokenizer, the schema and the ranking are all unaffected. This is a budget correction, not a redesign.

## Verification

```bash
pnpm vitest run apps/server/src/routes/__tests__/search.test.ts
pnpm vitest run apps/server/src/services/search/__tests__/access.test.ts
node --experimental-strip-types scripts/search-latency-bench.ts
```

Every access assertion is written in a POSITIVE/NEGATIVE pair, because the obvious form cannot fail. `expect(results).toHaveLength(0)` passes for a working filter AND for an empty index AND for a broken query — so each negative case is paired with a positive one over the same seeded row proving the row is really there and really matches:

- **Non-member vs nonexistent room.** Seed a room the caller is not a member of, containing the query term. Assert the OWNER gets ≥1 hit for that term (the row exists and matches), the non-member gets 0, and the non-member's **entire response body is deep-equal** to the body for a room id that does not exist — not merely also-empty. A `warnings` entry naming the room in one case and not the other is exactly the oracle §9.5 forbids: a room id is not a capability, and neither is a query string.
- **Member scoping.** A member of room A but not room B gets hits from A and none from B, with the same positive control on B via the owner path.
- **No session rows over MCP.** Seed claude-code rows containing a term, query through the MCP-shaped caller, assert zero `source_id = 'claude-code'` rows, and assert the owner path returns ≥1 for the same term.
- **Per-source degradation.** With one source's frontier carrying a `last_error`, assert the request succeeds (200), returns hits from the healthy sources, and carries exactly one warning naming the failed source.

The latency bench must print `term=… hits=… p50_bare=… p50_snippet=… slope_us_per_row=…` and, in this order:

1. **Assert `hits >= 10000` first.** The hit-count floor is the whole point: an empty or broken index answers in microseconds and would sail past a latency-only assertion, passing most loudly exactly when the feature is most broken.
2. **Assert the shape, not a wall-clock number** — that the unordered baseline is flat across at least three hit-count decades (max/min within ~3x), and that the ranked slope is positive and linear. Both are stable across load; a millisecond ceiling is not.
3. Pick the term by measuring the corpus's most frequent token at bench time rather than hardcoding `the`, so the check keeps biting as the corpus changes.

## Dependencies

- **Blocked by 2.1** (needs the tables plus at least one populated source; rooms is enough to exercise every access assertion).
- **Runs in parallel with 3.1, 3.2 and 4.1** — this is the main parallelism opportunity in the graph. It touches `search-service.ts` and `routes/search.ts`; they touch the frontier and the projections.
- **NOT blocked by RP3/RP7.** See the scope correction below.

## A spec claim corrected here

Spec §Implementation Phases puts "`search_room_history` as a caller" inside Phase 5, and G5 states it as a goal of this spec. **That contradicts `specs/room-participation/02-specification.md`, which is the document that owns the tool.** RP's §12 phasing table lists `search_room_history` under **RP7**, depending on RP6, RP3 and DOR-672 — and RP's Amendment 1 says it plainly: "RP7 lands after the index and lands directly as a caller", and "what is forbidden is shipping the scan and replacing it later, not 'these two must be one PR'."

**Resolved: `search_room_history` is RP7's work and is out of scope for DOR-672.** This task delivers the query service RP7 will call. RP7 additionally needs `joinedSeq`, which **does not exist** — re-verified today, `grep joined_seq` across `packages/db/` and `apps/server/src/` returns nothing, and `room_members` has only `joined_at` and `last_read_seq`. RP3 lands it. Shipping an index-backed `search_room_history` before `joinedSeq` exists would hand an agent a fast, ranked reader of everything said in its rooms before it joined — which is why the dependency is real and why DOR-672 must not absorb it.

### Task 5.3: Search works in the Obsidian embed, not only in the browser

- **Issue:** DOR-691 · **Phase 5** — P5 — Query, access and surfaces · **Size** small · **Priority** medium
- **Depends on:** 5.1 · **Parallel with:** 3.2, 4.1
- **Active form:** Wiring search through the Transport boundary

**This task exists because the decomposition would otherwise have shipped a feature the Obsidian embed silently cannot use.** The specification defines `GET /api/search` returning `{ results: SearchHit[], warnings: SourceWarning[] }` and stops there — which is a complete server contract and an incomplete client one.

## What is actually missing, verified in the code

- **`SearchHit` and `SourceWarning` do not exist.** `grep` across `packages/shared/src` and `apps/server/src` returns nothing for either name. The route's own response type is unowned by any other task.
- **`Transport` is method-per-endpoint, with two implementations.** `packages/shared/src/transport.ts` declares a method per operation (`listSessions`, `getSession`, `getMessages`, …), and the two implementations are `apps/client/src/layers/shared/lib/transport/http-transport.ts` and `apps/client/src/layers/shared/lib/direct-transport.ts`.
- **The embed has no HTTP server.** `DirectTransport` is in-process (`contributing/architecture.md`), so a client that reaches search by raw `fetch` works on the web and returns nothing in Obsidian. The failure is silent — an empty result list is indistinguishable from no matches, which is the same failure shape this feature refuses everywhere else.

## Scope

- Define `SearchHit` and `SourceWarning` in `@dorkos/shared` as Zod schemas with inferred types, exported through the `exports` subpath map in `packages/shared/package.json` following the existing pattern. `SourceWarning` reuses ADR-0310's degradation envelope rather than inventing a second one.
- Add one `search(...)` method to the `Transport` interface.
- Implement it in **both** transports: `HttpTransport` calls `GET /api/search`; `DirectTransport` calls the search service in-process, with the same visible-set scoping the route applies — the embed must not become a way around the access model.
- Update the mock `Transport` in `@dorkos/test-utils` so client tests can exercise search.

## Verification

```bash
pnpm --filter @dorkos/shared build
pnpm --filter @dorkos/client typecheck
pnpm vitest run apps/client/src/layers/shared/lib/__tests__/transport-parity.test.ts
```

- A **parity test over the interface itself**, not over a hand-written list: enumerate `Transport`'s keys and assert both implementations define every one. A test that only checks `search` exists passes while the next method to be added is forgotten; this one goes red for any future gap too.
- Both transports return the same shape for the same query against the same seeded index — assert deep equality of the parsed response, not merely that each returned something.
- The access assertion from DOR-684 is re-run through `DirectTransport`: a non-member gets zero room hits and a byte-identical body to the nonexistent-room case. **Without this the embed is a documented bypass**, and the positive control (owner sees the same row) proves the row was there to leak.

## Dependencies

- **Blocked by 5.1** (the service and the route define the contract this exposes).
- **Blocks 5.2** — the palette calls `transport.search()`, not `fetch`, so this lands first.

## If this is cut

Cutting it is defensible; cutting it silently is not. If it is cut, the Obsidian embed ships without message search and **the scope copy in 5.2 must say so**, exactly as it says OpenCode is not covered. An uneven surface that nobody states is the failure G4 exists to prevent.

### Task 5.2: You can find a message by typing in the palette, and the box tells you what it cannot find

- **Issue:** DOR-685 · **Phase 5** — P5 — Query, access and surfaces · **Size** medium · **Priority** medium
- **Depends on:** 5.1, 5.3 · **Parallel with:** none
- **Active form:** Building the palette search surface and its scope copy

The surface a person actually touches, plus the honesty commitment that ships with it.

## Scope

- Message search in `apps/client/src/layers/features/command-palette/`, following Feature-Sliced Design (`shared ← entities ← features ← widgets`) and importing only from barrel `index.ts` files. Server state via TanStack Query, per `contributing/state-management.md`.
- **Navigation and message search stay different surfaces.** `specs/rooms/02-specification.md:517` carried two arguments and only one expired. The UX-separation argument — Slack keeps `Cmd+K` and `Cmd+F` apart, Teams merged them and is the cautionary example — is untouched and load-bearing. Only the cost argument ("we have no message index") expires. Rooms-in-the-palette is navigation; this is the second surface, not an addition to the first.
- A result renders its source, its container, its role, its timestamp and its `snippet()` excerpt with the match marked. **A result whose working directory no longer exists is still shown and says so** — the conversation happened and the transcript is on disk; what changes is that its open action reports the directory is gone rather than failing on a path.
- Clicking a result navigates to its **container**: `/channels?id=<roomId>` for a room, `/session?session=<sessionId>` for a session. Both route shapes already exist and take their id as a search param. Landing on the exact message is task 6.2 and is deliberately not attempted here — see that task for why.
- Debounce and a minimum query length, per the O(hits) shape recorded on task 5.1. Derive the threshold on the machine it runs on — the absolute latency figures move ~2x with load and must not be hard-coded out of this document.
- Calls `transport.search()` (task 5.3), never `fetch`, so the Obsidian embed works too.
- **The stated scope, in the product (G4).** A person must be able to learn what search does not cover without reading a spec. The copy follows the `writing-for-humans` skill — plain enough for a smart 9th grader who doesn't code — and says, in substance: search covers what you and your agents _said_; it does not cover tool output, error messages, stack traces, file contents or diffs. It should also name the runtimes covered, because coverage is uneven and the unevenness is not obvious: **OpenCode conversations are not searchable** (task 6.3).
- **The one query-syntax surprise must be disclosed too**: `porter unicode61` matches words, so **a fragment that is not a word finds nothing** — `ogs` does not find `dogs`, though `dog*`, `"pack of dogs"`, boolean and `NEAR` all work. The spec names this as a product commitment, not a footnote, and this is the only task that writes copy.
- **The changelog fragment lands here** (`changelog/unreleased/<id>-<slug>.md`), because this is the task that makes the feature user-visible and `fragment-present` is a required check. The spec deliberately shipped no fragment with itself.
- **The AGENTS.md line lands here too, and not before** — one line recording that message search exists, gated on it actually working, per the demo-claim gate.

## Verification

```bash
pnpm vitest run apps/client/src/layers/features/command-palette/__tests__/
pnpm --filter @dorkos/client lint
pnpm exec playwright test apps/e2e/tests/message-search.spec.ts
```

- A React Testing Library test with a mock `Transport` via `TransportProvider`: typing a term renders result rows carrying a marked excerpt; typing fewer than the minimum characters issues **no** request (assert on the mock transport's call count, not on the absence of rows — an empty result list looks the same either way).
- The browser test seeds a room through the test-mode runtime, opens the palette, types a term that exists in it, asserts a result row appears with the term marked, clicks it, and asserts the URL becomes `/channels?id=<roomId>`. **Assert the URL, not that a navigation happened** — a no-op navigation satisfies the weaker form.
- A test asserting the scope copy is rendered, names OpenCode as not covered, and states the not-a-word limitation. It is a product commitment, so it gets an assertion rather than a review comment.
- `pnpm exec python3 .claude/scripts/changelog_backfill.py --since origin/main --check --changed-only` exits 0 with the fragment counted, not skipped.
- Responsive: the results list works on mobile, tablet and desktop widths.

## Dependencies

- **Blocked by 5.1** (there is no route to call until it lands).
- **`apps/e2e/` is under active edit by another agent as of 2026-07-28.** Add a new spec file rather than modifying existing ones, and rebase before opening the PR. Consult the `browser-testing` skill before writing the Playwright test.
- Blocked-by-convention on 3.2 and 4.1 only in the sense that the scope copy should name the final runtime coverage. If they have not landed, the copy still ships and names what is true at that moment.

### Task 6.1: Adding a new place to search is an afternoon with a guide, not an archaeology project

- **Issue:** DOR-686 · **Phase 6** — P6 — Handover and deferred work · **Size** small · **Priority** low
- **Depends on:** 4.1 · **Parallel with:** 5.2
- **Active form:** Writing the add-a-search-source guide

The spec calls this "the single most valuable artifact for whoever indexes OpenCode", and that person is the one who will decide whether this design becomes a port. Write the guide while all three sources are fresh.

## Scope

`contributing/adding-a-search-source.md`, following the `writing-developer-guides` skill (guides are written for autonomous coding agents as much as for people), and listed in `contributing/INDEX.md`. It covers:

- **The registry row** — its four fields and what each one is for.
- **The projection contract** — a pure function with no filesystem and no database access, taking parsed input and returning rows. That purity is what makes projections table-testable and what keeps "adding a source" honest at one function.
- **Which mechanism to pick.** M1 (append-only JSONL tailed at a byte offset) versus M2 (SQLite rows above a monotonic watermark). The decision rule is the resumption primitive: does the source hand back a position it will honour, returning only what comes after it? If yes, it fits an existing mechanism.
- **`origin_key` is opaque and the projection composes it.** The index never parses it. This is the property that lets the schema survive changes it cannot see coming — the room projection sets `origin_key = roomId` today and `` `${communityRef}:${roomId}` `` when communities land, and nothing else changes: not the schema, not the query, not the ranking, not the frontier.
- **`container_path` lives on `search_sources`, one row per container, deliberately not on `messages`** — it is a per-container constant, and repeating it on ~18,000 message rows to save one join is the denormalization that later disagrees with itself.
- **The column rule.** In a table rebuildable in seconds, no column ships without a consumer. Widening later is one projection change and a rebuild, not a migration.
- **Never traverse generically.** Every projection selects explicit fields. No `SELECT *`, no "index all text columns", no recursive JSON walk. The counter-example is concrete: `opencode.db` holds `account.access_token`, `account.refresh_token` and `credential.value` in the same database as its messages, so a generic indexer over it would write live OAuth tokens into a searchable table.
- **The port trigger, stated as an inherited decision rather than a caveat.** There is no port today because two mechanisms plus pure projections are enough. A source needing a THIRD mechanism promotes the shape to a port. An SDK poll is that third mechanism: it has no resumption primitive (it pages backwards from newest, so "what is new" is not expressible — you re-read and diff, making per-poll cost a function of session length rather than of new content) and it carries a liveness precondition the other two lack (a child process must be alive). **The day OpenCode is indexed, the promotion fires.**

## Verification

```bash
pnpm vitest run apps/server/src/services/search/__tests__/guide-example.test.ts
grep -q 'adding-a-search-source' contributing/INDEX.md
```

A guide whose only check is "a human read it" is not checked at all. So the guide's worked example is **copy-runnable and pinned by a test**: `guide-example.test.ts` registers the exact fourth source the guide walks through — a trivial fixture source over a temp JSONL file — using the code from the guide verbatim, and asserts it indexes and becomes searchable. If the registry shape or the projection contract drifts, the guide's example stops compiling and the test goes red, which is the only way a document stays true.

## Dependencies

- **Blocked by 4.1.** Write it once both mechanisms and all three sources exist, so the guide describes what shipped rather than what was planned. Codex in particular is the evidence for the "one row and one function" claim — if Codex turned out to cost more than that, the guide must say so instead of repeating the claim.

### Task 6.2: Decide whether clicking a search result can land you on the message itself

- **Issue:** DOR-687 · **Phase 6** — P6 — Handover and deferred work · **Size** small · **Priority** low
- **Depends on:** 5.2 · **Parallel with:** 6.1, 6.3
- **Active form:** Deciding on message-level deep linking

**Filed rather than dropped, because the ideation's headline journey promises it and the specification quietly does not deliver it.**

`01-ideation.md` §1 states the user story as: "You click one and land where it was said." The specification carries the coordinates to make that possible — §8's "a result carries what it needs to be opened: source, container, ordinal, role, timestamp" — but its Non-Goals say "Not a new UI surface", and nothing in the spec defines what opening a result at a particular message actually does. So the promise and the plan disagree, and the disagreement is invisible unless someone looks for it.

## What was checked before filing this

Both container routes exist and both take their id as a search param: `/session?session=<id>` (`sessionSearchSchema`) and `/channels?id=<roomId>` (`channelsSearchSchema`). **Neither has any message-level anchor** — verified today, there is no scroll-to-message, no `messageId` search param, and no anchor mechanism on either page.

## The resolution taken for v1, and why

**Task 5.2 navigates to the container, not to the message.** A result opens the session or the room it came from; it does not scroll to the matched line. That keeps 5.2 landable and honest, and it is a real product: you find the conversation, and you are in it.

It is also materially weaker than the story the ticket opens with, which is why this is a filed decision rather than a silent omission.

## What this task must decide and then build

1. **Is a message anchor worth its cost?** The room case is cheap — `room_entries.seq` is already the ordinal and the timeline already renders by seq. The session case is not: session transcripts hydrate over a durable SSE stream and are virtualized, so "scroll to message 4,312 of a session you have not loaded" is a real piece of work, not a URL parameter.
2. **If yes, the shape.** Likely `?entry=<seq>` on `/channels` and `?message=<ordinal>` on `/session`, with the coordinates already carried by every `SearchHit`.
3. **The degraded case is already decided and must be honoured**: a hit whose working directory no longer exists is still shown and still readable, and its open action reports that the directory is gone rather than failing on a path. Re-measured today: 33 files holding 288 messages in `~/.claude` are in this state.

## Verification

This is a decision task, so its first output is a decision — but it still ends in a command, and which command depends on the answer.

**If the decision is to build it:**

```bash
pnpm exec playwright test apps/e2e/tests/message-search-deeplink.spec.ts
```

The test searches for a term appearing only in an OLD entry of a long room, clicks the result, and asserts the matched entry is **in the viewport**. Asserting that the room opened is the check that cannot fail, because task 5.2 already makes that true — the assertion has to be on the scroll position or on the entry's visibility, or it passes without the feature.

**If the decision is not to build it:**

```bash
/adr:create                       # record the refusal and its trigger
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts get message-search
```

The ADR records the refusal with the condition that would reverse it, and `specs/message-search/01-ideation.md`'s "you click one and land where it was said" is amended so the promise and the product agree. **Amending that sentence is not optional in this branch**: leaving it would be the same false-completeness failure this decomposition exists to correct.

## Dependencies

- **Blocked by 5.2** (there is nothing to click until the surface exists).
- No dependency on the remaining sources.

### Task 6.3: Make OpenCode conversations searchable, or record why they stay unreachable

- **Issue:** DOR-688 · **Phase 6** — P6 — Handover and deferred work · **Size** large · **Priority** low
- **Depends on:** 6.1, DOR-673, DOR-674 · **Parallel with:** 6.2
- **Active form:** Deciding and building the OpenCode search source

**The deferred source, filed as explicit work rather than left as an omission — and the task that will decide whether this design becomes a port.**

OpenCode is out of the first cut and the product says so (task 5.2's scope copy names it). This task is where that changes, and it is blocked on a decision nobody has made yet.

> **2026-08-25 — the decision landed.** ADR `260825-110420` (DOR-688) narrows ADR-0308's read ban to admit a snapshot-based, allowlisted read, keeps the SDK path forbidden for indexing, and **refuses** the port promotion this task predicted would fire. The four counts below are answered in spec Amendment 8; the count-based watermark it describes needed a volatility window on top, because OpenCode mutates a turn's parts in place after creating the message row. The remaining piece is the client scope copy, tracked as DOR-1556. Everything below is left as written — it is the reasoning the ticket inherited, not a record of what shipped.

## Why it was deferred — four counts, none of them "we ran out of time"

1. **ADR-0308:24 forbids the direct read**: "OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly." The file itself is the argument — `opencode.db` holds `account.access_token`, `account.refresh_token` and `credential.value` in the same database as its messages. The security instinct and the ADR converge and **the ADR got there first**; the credentials are evidence it was right, not grounds for an exception. Message text also lives in opaque JSON `data` blobs on `message`, `part` and `session_message`, so indexing it means parsing a private schema, and the file is in WAL mode against a store ADR-0308:37 records as having upstream reliability issues.
2. **The SDK path was then evaluated on its merits and fails on its own.** A background read must spawn someone else's agent server: nothing boots the sidecar at startup ("the sidecar spawns lazily on first use"), and `check-dependencies.ts:12-14` refuses even to probe because "a cold probe would spawn a server as a side effect". The adapter has two accessors for exactly this distinction — `peekClient()` never boots and returns `null` when cold; `getClient()` boots (`session-mapper.ts:59-76`) with a 15 s startup budget, a six-attempt restart ladder, and one cached instance per directory with no idle eviction. A reconciler on a timer must therefore spawn a child process purely to read, or throw on every tick. **Every other source in this design reads bytes already at rest.**
3. **The corpus is 24 messages** (`session` 6, `message` 24, `part` 73), against ~17,989 from Claude Code.
4. **It would be the third mechanism**, which under this design's own rule promotes the whole shape to a port. Doing that for 24 messages is the tail wagging the dog.

## What this task inherits, written down so it is not rediscovered

- **The SDK-surface decision blocks everything else.** The OpenCode server supports `before` (message keyset), `start` (sessions-updated-since) and `scope: 'project'`; **none is in the pinned v1 SDK types.** So an indexer built on v1 gets whole-session re-reads and exact-directory-only listing. Fixing that means widening the v1 types, adopting v2 types against the same URL, or waiting for `/experimental/session` — and that revisits ADR-0308's "build on v1", which is a larger decision than a search feature should be making.
- **Whether the reconciler may boot the sidecar is a product decision, not an implementation one.** A `peekClient()`-only indexer is cheap and safe but makes coverage nondeterministic — you index whatever happened to be warm — which is the wrong trade for a feature whose entire promise is recall.
- **One caveat that must be written down before anyone polls:** `Session.time.updated` is stamped at **turn start, not on message write** (`prompt.ts:1160-1161` in the local OpenCode snapshot; `updateMessage`/`updatePart` never patch it). A naive `updated > lastSeen` poll therefore misses the assistant half of any turn in flight. The watermark must be `>=`, plus a forced re-read of any session last seen non-idle.
- The projection itself is already written and reusable (`session-mapper.ts:201-246`).
- **If this ships, the port trigger fires.** A third mechanism promotes the registry-array shape to a real port. That is not a caveat, it is the trigger the design named — see task 6.1's guide.

## Dependencies

> `dependencies` carries `6.1` plus the tracker ids **DOR-673** and **DOR-674**. Mixing tracker ids into a task-id array is deliberate: the alternative leaves the canonical file claiming this task is unblocked once 6.1 lands, which is false, and a scheduler that skips an unrecognised dependency fails in the safe direction while one that never sees it does not.

- **Blocked by DOR-673** — OpenCode sessions silently stop listing past 100 (a server-side default cap DorkOS never overrides). An indexer built on top of a session list that silently truncates would inherit the truncation and produce exactly the failure this feature refuses: a short result list that looks complete.
- **Blocked by DOR-674** — OpenCode sessions started in a subdirectory never appear, because the adapter's directory filter is exact string equality. Same reasoning: the index would inherit an invisible gap.
- **Blocked by 6.1** (the guide) only in the weak sense that the guide is what this task should be able to follow. If the guide turns out not to be enough, that is a finding worth reporting back.
- Both DOR-673 and DOR-674 were found while surveying runtime stores for DOR-672 and are search-independent bugs that deserve fixing on their own terms.

## Verification

Whichever way this goes, it ends in a command someone runs:

```bash
pnpm vitest run apps/server/src/services/search/__tests__/opencode-source.test.ts
node --experimental-strip-types scripts/search-corpus-bench.ts --source opencode
pnpm vitest run apps/client/src/layers/features/command-palette/__tests__/scope-copy.test.tsx
```

- **If OpenCode is indexed:** the corpus bench reports a non-zero OpenCode message count matching an independent count taken through the SDK, the sidecar-boot behaviour is asserted (either it never boots, or it boots exactly once per sweep — assert on the spawn count, not on the absence of an error), and the port promotion is either done or explicitly refused in an ADR.
- **If it stays deferred:** an ADR recording the refusal with its trigger, and task 5.2's scope copy still naming OpenCode as not covered — with a test asserting that copy, so the product cannot silently start implying coverage it does not have.
