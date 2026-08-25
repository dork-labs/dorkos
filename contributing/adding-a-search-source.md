# Adding a Search Source

## Overview

Message search is a derived, rebuildable index over everything that was ever said — the room log, every Claude Code transcript, every Codex rollout, every OpenCode conversation. Adding a place to search is **one row in a registry array plus one pure projection**, because discovery, change detection and the incremental read are written once per _mechanism_ rather than once per source. This guide is what that costs, what it must not cost, and a worked example you can copy.

Read `specs/message-search/02-specification.md` §3 and §4 for the design, and ADR `260728-214214` for why it is a record rather than a port. This guide is the operating manual.

## Key Files

| Concept                               | Location                                                          |
| ------------------------------------- | ----------------------------------------------------------------- |
| The registry array + every source     | `apps/server/src/services/search/registry.ts`                     |
| Every shape you implement             | `apps/server/src/services/search/types.ts`                        |
| **M1** — JSONL tailed at byte offset  | `apps/server/src/services/search/jsonl-frontier.ts`               |
| **M2** — rows above a watermark       | `apps/server/src/services/search/row-frontier.ts`                 |
| **M3** — snapshot of a foreign store  | `apps/server/src/services/search/snapshot-frontier.ts`            |
| Writes every mechanism shares         | `apps/server/src/services/search/frontier-store.ts`               |
| Projections (one per source)          | `apps/server/src/services/search/projections/`                    |
| The sweep loop                        | `apps/server/src/services/search/indexer.ts`                      |
| Who may search what                   | `apps/server/src/services/search/search-service.ts`               |
| The ranked query                      | `apps/server/src/services/search/query.ts`                        |
| Tables (`messages`, `search_sources`) | `packages/db/src/schema/search.ts`                                |
| The allowlist that makes M3 safe      | `apps/server/src/services/search/opencode-store.ts`               |
| **The worked example, pinned**        | `apps/server/src/services/search/__tests__/guide-example.test.ts` |

## When to Use What

**The decision rule is the resumption primitive: does the source hand back a position it will honour, returning only what comes after it?**

| What your source can give you                                                                       | Mechanism                             | You implement                          | Already using it                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| A **byte offset** into an append-only file it will not rewrite                                      | **M1** `jsonl`                        | `discover()` + `project()`             | `claude-code`, `codex`                                             |
| A **monotonic ordinal** in a table DorkOS owns                                                      | **M2** `rows`                         | `listContainers()` + `readSince()`     | `rooms`                                                            |
| **Neither** — but the data is bytes at rest in a file you may copy                                  | **M3** `sqlite-snapshot`              | `open()` returning a `ContainerReader` | `opencode`                                                         |
| **None of the three** — e.g. an SDK that pages backwards from newest and needs a live child process | **Stop.** This is the port re-trigger | An ADR before any code                 | — (see [The port decision](#the-port-decision-inherited-not-open)) |

Two follow-on questions the table does not answer:

| Situation                                                     | Answer                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Your source spans several roots (one per account, per day…)   | Still one source. `discover()` reads all of them and reports unreadable ones in `failures` — it never rejects on the first. |
| A root is simply absent                                       | Not a failure. The runtime may never have run here; skip it silently.                                                       |
| A root exists and will not open                               | A `DiscoveryFailure`. A short result list looks exactly like a complete one, so this must be loud.                          |
| Your source mutates rows it already wrote (streams into them) | M2/M3 only: raise `RowContainer.rereadWhole` for the affected containers. It deletes and rewrites the container.            |
| You want to record that you deliberately walked past a file   | Add a member to the `SkipReason` union in `types.ts`. It is one union across every source on purpose.                       |

## The Registry Row

A source is a plain record, never a class. Every mechanism's row carries the same two mandatory fields plus the functions its mechanism needs:

| Field       | Type                                     | What it is for                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | `string`                                 | Stamped onto every row this source contributes, **from the registry, never from the projection** — so a projection cannot get its own source's name wrong. It is also the `?source=` filter value and the frontier's scope key. |
| `mechanism` | `'jsonl' \| 'rows' \| 'sqlite-snapshot'` | Which sweep runs it. The row **names** its mechanism; `indexer.ts` never infers one from the shape of the record.                                                                                                               |
| M1 only     | `discover(known)`, `project(lines, ctx)` | Discovery reaches the filesystem. The projection never does.                                                                                                                                                                    |
| M2 only     | `listContainers(db)`, `readSince(db, …)` | Discovery and change detection fold into one query — the container list carries each container's current high-water ordinal.                                                                                                    |
| M3 only     | `open()`                                 | Copies the store, opens the copy read-only, hands back a `ContainerReader` the sweep must `close()`.                                                                                                                            |

**Build the row from a factory that takes its roots as a parameter.** Every shipped source that reads a root does (`createClaudeCodeSource`, `createCodexSource`, `createOpenCodeSource`), for one reason: a test must be able to point the source at a fixture tree instead of at the operator's real history. The exported constant then binds the real resolver.

**Resolve roots at the start of every sweep, never at module load.** An operator who registers an account or changes `$CODEX_HOME` mid-session must be indexed on the next tick rather than after a restart.

## The Projection Contract

```ts
project(lines, { originKey, firstOrdinal }): { messages: ProjectedMessage[]; skipped: number }
```

**A projection is a pure function. No filesystem, no database, no clock, no SDK import.** That purity is not aesthetic — it is what makes projections table-testable, and it is what keeps "adding a source" honest at one function. If your projection needs to open something, that work belongs in `discover()` (M1) or in the reader (M2/M3).

Three details that are easy to get wrong:

- **Ordinals are handed in, not started from zero.** A container is read incrementally, so a batch continues the container's numbering. `firstOrdinal` is where it resumes.
- **`skipped` is not an error count; it is the drift signal.** A projection that _throws_ is loud: the sweep records it, writes `search_sources.last_error`, and stops that container. A projection handed a record whose shape drifted underneath it does not throw — it returns fewer rows, and fewer rows is exactly what a source with nothing to say returns. `skipped` is the only thing that tells the two apart. Count a record you **recognise as yours and cannot read**; drop everything that was never a message silently.
- **A missing timestamp is `null`, never invented.** A fabricated `createdAt` sorts results into an order nobody can explain.

## Rules That Are Not Style

### `origin_key` is opaque, and the projection composes it

The index never parses it, never splits it, never makes it a foreign key. This is the property that lets the schema survive changes nobody has made yet: the room projection sets `origin_key = roomId` today and `` `${communityRef}:${roomId}` `` once community scoping lands — and **nothing else changes**. Not the schema, not the query, not the ranking, not the frontier, and no migration.

| Source        | `origin_key`                       | `ordinal`                                            |
| ------------- | ---------------------------------- | ---------------------------------------------------- |
| `rooms`       | `roomId`                           | `room_entries.seq`                                   |
| `claude-code` | the session id (the filename stem) | the message's index within the file                  |
| `codex`       | the session id from `session_meta` | the `response_item`'s index within the file          |
| `opencode`    | the session id                     | the message's position in `(time_created, id)` order |

`origin_key` is unique **within** a source and carries no guarantee across sources — which is why every visibility clause and every path lookup keeps `source_id` beside it.

### `container_path` lives on `search_sources`, not on `messages`

The working directory a hit opens in is a **per-container constant**. It goes on `search_sources`, which is already keyed `(source_id, origin_key)` — exactly the container — so the column costs nothing new. Repeating it on ~19,000 message rows to save one join is the denormalization that later disagrees with itself.

`NULL` is a real answer: a room is not a directory, and neither is a source whose files never name one. **Read it from the file's own head record, never from a directory name** — Claude Code's slug is a lossy `cwd.replace(/[^a-zA-Z0-9-]/g, '-')` and cannot be inverted.

A container whose path no longer exists **keeps every one of its rows**. The result is still shown and says the directory is gone; it does not fail on a path.

### No column ships without a consumer

`messages` is rebuildable in seconds, so there is no reason to carry a column speculatively. Every column present today is consumed: `role` is rendered and filtered, `created_at` orders and displays, `source_id` labels a result and scopes the frontier, `origin_key` + `ordinal` are the navigation coordinates. **Widening later is one projection change and a rebuild — measured at 2.69 s over the v1 corpus — not a migration.** If you want a column, ship the consumer in the same change or do not ship the column.

### Never traverse generically

**Every projection selects explicit fields. No `SELECT *`, no "index all text columns", no recursive JSON walk.**

The counter-example is shipped reality, not a hypothetical: `opencode.db` holds `account.access_token`, `account.refresh_token` and `credential.value` in the same file as its messages. A generic indexer over it would write live OAuth tokens into a searchable table.

That is why M3's read is structural rather than filtered. `OPENCODE_READ_ALLOWLIST` (`opencode-store.ts`) is a frozen constant naming every table and column that may be reached, and every statement in the module is built by a helper that throws on anything outside it — so `SELECT *` is not expressible, and reaching a credential column takes a deliberate edit to a constant a test pins by name. It is an allowlist and not a denylist of credential tables on purpose: a denylist is a list somebody must remember to extend the day upstream adds `oauth_token_v2`.

If you are reading a store you do not own, copy this pattern rather than writing a filter.

## The Access Model

**A new source is owner-only session history until somebody decides otherwise, and that decision lives in one function**: `buildScopes()` in `search-service.ts`. It knows exactly one source by name — `rooms`, which is member-scoped above each member's `joinedSeq` — and every other registered source is reached only when `scope.sessions` is true, which is the operator alone.

So a new registry row is invisible to agents on the day it lands rather than on the day somebody remembers. That is the direction a default has to fail in, and it is the reason `buildScopes` iterates `SEARCH_SOURCES` instead of listing sources.

**A new source MUST add the negative access test**, and the negative alone is worthless: `expect(results).toHaveLength(0)` passes for a working filter, for an empty index and for a broken query alike. Pair it with an owner-path assertion over the same seeded rows, proving the row really is there and really does match the words asked for. `__tests__/access.test.ts` is written that way throughout — follow it.

If your source is rooms-like (its containers have members, and membership is what decides visibility), it needs a scope branch of its own and a spec amendment, not a quiet edit to `buildScopes`.

## Adding a Source, Step by Step

The example below adds a fictional `journal` runtime that appends one JSONL file per conversation, with a `session` head record naming the working directory:

```jsonl
{"type":"session","cwd":"/repo/app"}
{"who":"user","text":"why is the deploy stuck","at":"2026-08-25T10:00:00.000Z"}
{"who":"assistant","text":"The lock file is held by a dead job.","at":"2026-08-25T10:00:04.000Z"}
```

**This exact code is pinned by `apps/server/src/services/search/__tests__/guide-example.test.ts`**, which registers it verbatim and asserts it indexes and becomes searchable. If the registry shape or the projection contract drifts, the example stops compiling and the test reds — which is the only way a document stays true.

### 1. Imports

Paths are relative to where you put the file; in a real source the projection lives in `projections/` and the row in `registry.ts`.

```ts
import fs from 'fs/promises';
import path from 'path';
import type {
  DiscoveryFailure,
  FileContainer,
  FileDiscovery,
  FileSource,
  KnownContainer,
  ProjectedMessage,
  Projection,
} from '../types.js';
```

### 2. The projection — pure, and the only place the format is known

<!-- pinned-by: guide-example.test.ts -->

```ts
/**
 * The journal projection: raw lines in, searchable messages out.
 *
 * **Pure.** No filesystem, no database, no clock — which is what makes it
 * table-testable and what keeps "adding a source" honest at one function.
 *
 * @param lines - Complete lines from ONE journal file, in file order.
 * @param context - Which container these belong to, and the ordinal the first
 *   message produced should carry.
 * @returns The messages, plus how many records drifted.
 */
export function projectJournalLines(
  lines: readonly string[],
  context: { originKey: string; firstOrdinal: number }
): Projection {
  const messages: ProjectedMessage[] = [];
  let skipped = 0;
  let ordinal = context.firstOrdinal;

  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Counted, never thrown: one drifted record must not stop a container,
      // and `skipped` is the only thing that tells a broken projection apart
      // from a source with nothing to say.
      skipped += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') {
      skipped += 1;
      continue;
    }

    // Explicit fields, named one at a time. Never a walk over whatever keys the
    // record happens to carry — see "Never traverse generically".
    const record = parsed as { who?: unknown; text?: unknown; at?: unknown };

    // The head record is not a message. Dropped silently rather than counted:
    // it was never a message, so it is not evidence of drift.
    if (record.who !== 'user' && record.who !== 'assistant') continue;
    if (typeof record.text !== 'string' || record.text.trim() === '') continue;

    messages.push({
      // The projection COMPOSES the container id; the index never parses it.
      originKey: context.originKey,
      ordinal: ordinal++,
      role: record.who,
      // Whatever the record stamped, or null. A fabricated timestamp would sort
      // results into an order nobody can explain.
      createdAt: typeof record.at === 'string' ? record.at : null,
      body: record.text,
    });
  }

  return { messages, skipped };
}
```

### 3. The head read — where `container_path` comes from

<!-- pinned-by: guide-example.test.ts -->

```ts
/**
 * The working directory a journal file names, from its own head record.
 *
 * **Never derived from the directory name.** A path baked into a filename is
 * lossy and cannot be inverted, so a source that has no head record answers
 * `null` rather than guessing — and `null` is a supported answer.
 *
 * **The `open` is INSIDE the try.** A file can vanish between `readdir` and this
 * call — log rotation, a runtime's own cleanup — and an `open` outside the guard
 * rejects `discover()` for the whole source, which the sweep turns into zero
 * rows, no prune and no `last_error` for that tick.
 *
 * @param filePath - The journal file to peek at.
 * @returns The recorded working directory, or `null`.
 */
async function readJournalCwd(filePath: string): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      // The head, not the file. A discovery pass that read whole transcripts to
      // classify them would cost megabytes every five minutes.
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
      const parsed: unknown = JSON.parse(head);
      if (parsed === null || typeof parsed !== 'object') return null;
      const cwd = (parsed as { cwd?: unknown }).cwd;
      // Non-empty, matching the shipped readers: an empty string is not a
      // directory, and storing one would make a hit claim to open somewhere.
      return typeof cwd === 'string' && cwd !== '' ? cwd : null;
    } finally {
      await handle.close();
    }
  } catch {
    // A file that vanished, or one with no readable head, still costs the sweep
    // nothing: it simply opens nowhere.
    return null;
  }
}
```

### 4. Discovery — the only part that reaches the filesystem

<!-- pinned-by: guide-example.test.ts -->

```ts
/**
 * Every journal file under `roots`, with the two signals that say whether it
 * changed.
 *
 * **Resolves rather than rejecting when one root fails.** A source spanning
 * several roots that threw on the first unreadable one would contribute zero
 * rows from the roots that ARE readable, which is the opposite of the per-root
 * degradation the design asks for.
 *
 * @param roots - Directories holding `<conversationId>.jsonl` files.
 * @param known - What the frontier already holds, keyed by container id. A file
 *   whose `(size, mtime)` match an entry here has not changed, so it is
 *   classified from the last sweep's answer instead of by reading it again.
 * @returns What to index, and every root that could not be enumerated.
 */
export async function discoverJournalFiles(
  roots: readonly string[],
  known: ReadonlyMap<string, KnownContainer>
): Promise<FileDiscovery> {
  const files: FileContainer[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (err) {
      // A root that is simply absent is NOT a failure — the runtime may never
      // have run on this machine. A root that exists and will not open IS one,
      // because a short result list looks exactly like a complete one.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failures.push({ root, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(root, entry);
      const originKey = entry.slice(0, -'.jsonl'.length);

      // **A file can vanish between the readdir and this stat**, and letting
      // that throw would abandon every remaining file in every remaining root.
      // A vanished file is neither indexed nor reported: it is not a decision
      // this source made, so it earns no `SkipReason` and no failure — the
      // prune drops its rows because it is simply not in `files`.
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }

      // This is the whole reason `known` is handed in: an unchanged file costs
      // one readdir entry and one stat, and no head read at all.
      const seen = known.get(originKey);
      const unchanged =
        seen !== undefined && seen.sizeBytes === stat.size && seen.mtimeMs === stat.mtimeMs;

      files.push({
        originKey,
        filePath,
        containerPath: unchanged ? seen.containerPath : await readJournalCwd(filePath),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  // `skipped` is for files walked past DELIBERATELY, each with a `SkipReason`
  // member in `types.ts`. A name that was never ours is not a decision.
  return { files, skipped: [], failures };
}
```

### 5. The registry row

<!-- pinned-by: guide-example.test.ts -->

```ts
/**
 * Build a journal source over a set of roots.
 *
 * The roots are a parameter rather than a call so a test can point the source
 * at fixture trees instead of at the operator's real history.
 *
 * @param resolveRoots - Called at the start of every sweep, never cached, so a
 *   root that appears mid-session is indexed on the next tick rather than after
 *   a restart.
 * @returns The registry row.
 */
export function createJournalSource(resolveRoots: () => readonly string[]): FileSource {
  return {
    id: 'journal',
    mechanism: 'jsonl',
    discover: (known) => discoverJournalFiles(resolveRoots(), known),
    project: projectJournalLines,
  };
}
```

That is the whole source. `jsonl-frontier.ts` is untouched by it: the byte offset, the partial-line rule, the shrink rebuild, the twin refusal, the prune suppression and the failure recording all apply without a line of new code.

### 6. Register it

In `registry.ts`, bind the real resolver and add one entry:

```ts
export const journalSource: FileSource = createJournalSource(resolveJournalRoots);

export const SEARCH_SOURCES: readonly SearchSource[] = [
  roomsSource,
  claudeCodeSource,
  codexSource,
  openCodeSource,
  journalSource,
];
```

**The order is the sweep order.** Cheap and DorkOS-owned first; then filesystem walks, largest corpus first, so the source carrying most of the messages is not waiting behind the one carrying 1%.

The pinned test deliberately does **not** do this — a fixture source in `SEARCH_SOURCES` would sweep the operator's real machine every five minutes — and it asserts that it does not.

### 7. Verify

```bash
pnpm vitest run apps/server/src/services/search/__tests__/guide-example.test.ts
pnpm vitest run apps/server/src/services/search          # the whole search suite
pnpm --filter @dorkos/server typecheck
```

For a real source, add on top of that: a table-driven projection test (well-formed record, empty text, malformed line counted as `skipped`), a frontier test over real files (grew, grew by half a line, shrank, vanished, working directory vanished but the file is intact), and the paired access test described above.

## Anti-Patterns

| ❌ Never                                                           | ✅ Instead                                                                           | Because                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| A projection that reads a file, a database or the clock            | Do the reading in `discover()` / the reader and hand the projection parsed input     | Purity is what makes it table-testable and keeps a source at one function                       |
| `const [ref, id] = hit.originKey.split(':')`                       | Treat `origin_key` as one opaque string, always carried with its `source_id`         | The moment anything parses it, the schema depends on a shape nobody has decided                 |
| Copying `containerPath` onto every projected message               | Leave it on `search_sources`, one row per container                                  | It is a per-container constant; ~19,000 copies of one fact later disagree with themselves       |
| `for (const value of Object.values(record)) body += value`         | Name every field you read                                                            | This is the rule that keeps OAuth tokens out of a searchable table                              |
| `SELECT *` against a store you do not own                          | Build every statement from a frozen table-and-column allowlist (`opencode-store.ts`) | An allowlist cannot silently grow a credential column; a review of `SELECT *` cannot see one    |
| Letting `discover()` reject when one root of several will not open | Resolve, and report it in `FileDiscovery.failures`                                   | Otherwise the readable roots contribute nothing, and a short list looks exactly like a full one |
| Reading an absent store as an empty container list                 | Absent means index nothing **and** prune nothing                                     | It deletes the whole indexed corpus the first time a runtime is uninstalled                     |
| Adding a column now and its consumer later                         | Change the projection and rebuild when the consumer exists                           | A migration for a table that rebuilds in 2.69 s buys nothing                                    |
| Silently dropping a record you recognise and cannot read           | `skipped += 1`                                                                       | Dropping it makes a broken projection indistinguishable from a quiet source                     |
| Putting a fixture or test source in `SEARCH_SOURCES`               | Build it with a factory and register it only inside the test                         | The registry sweeps the operator's real machine every five minutes                              |

## The Port Decision, Inherited Not Open

The design named the arrival of a **third mechanism** as the trigger that would promote `SEARCH_SOURCES` from an array of records to a `SearchAdapter` port (spec §3, D12). That day came with OpenCode and M3.

**The promotion was refused, on evidence rather than taste** — ADR `260825-110420`. The prediction behind the trigger was that a third mechanism would need a third copy of the frontier logic. It did not: M3 reuses M2's entire watermark implementation through a four-line `ContainerReader` seam and contributes one function of its own (`snapshot-frontier.ts` — one exported sweep function, ~50 lines of code). The resume rule, the shrink rebuild, the frontier write and the prune are shared, not duplicated. A port introduced there would abstract three mechanisms that already share their implementation, which is a class hierarchy standing where a record does.

**The re-trigger is written down rather than left to taste. The promotion fires on either of:**

- **A fourth mechanism** — one whose change detection cannot be expressed as either a byte offset or a monotonic ordinal, so it needs frontier logic of its own rather than a `ContainerReader`. An SDK that pages backwards from newest, with a liveness precondition (a child process must be alive), is exactly that shape: "what is new" is not expressible, so you re-read and diff, and per-poll cost becomes a function of session length rather than of new content.
- **A source that lives outside `apps/server`** — a package, an extension, or a marketplace-installed indexer. The array is a private constant in one file; the moment a source has to be registered from somewhere that cannot edit that file, the registration surface **is** the port, and it should be built deliberately rather than grown as an `if`-chain in `indexer.ts`.

If you hit either, write the ADR before the code. If you hit neither, add the row.

## Troubleshooting

### `SQL logic error` from `snippet()` while `MATCH` and `bm25()` still work

**Cause**: `messages_fts` is an external-content table declared `content='messages'`, so FTS5 re-reads the original text from `messages` **by column name**. The column must be called `body` on both sides.
**Fix**: do not rename `messages.body`. A MATCH-only test passes straight through this failure, which is why `query.test.ts` asserts `snippet()` returns text.

### A source indexes nothing and reports no error

**Cause**: usually the frontier believes it is caught up. Check `search_sources` for that container — a stale `byte_offset` or `last_ordinal` with an emptied `messages` table is the classic shape.
**Fix**: it is already handled — both mechanisms read the index's own high-water ordinal alongside the frontier and rebuild when they disagree. If yours does not recover, you are reading the frontier as the only signal. `DELETE FROM messages; DELETE FROM search_sources;` and re-sweep is a **supported recovery**, not data loss.

### Sweep reports `skipped > 0` and the reconciler warns

**Cause**: your projection recognised records as its own and could not make messages out of them — an upstream format change.
**Fix**: that is the signal working. Read the source's current on-disk shape and update the projection; do not silence the count.

### `search_sources.last_error` is set and results carry a warning

**Cause**: a container failed to index. `searchForCaller` turns any `last_error` inside the caller's scope into one warning naming the source and nothing inside it.
**Fix**: the byte offset was deliberately left where it was, so the next sweep retries the same bytes. Fix the cause; the error clears on the next successful pass.

### A whole account's history disappears from search when a disk hiccups

**Cause**: it should not — the sweep refuses to prune when discovery reported any root failure, because a container absent because its root could not be listed is not a container that is gone.
**Fix**: if you wrote the discovery, make sure the unreadable root lands in `failures` rather than being absorbed. The cost of the current rule is stated plainly in `jsonl-frontier.ts`: one permanently unreadable root freezes pruning for every root until it is fixed or removed from the config.

### Two files claim one container id

**Cause**: a copied config directory, a symlinked account root, or a runtime that started copying on archive instead of moving.
**Fix**: nothing to do in your source — `jsonl-frontier.ts` refuses **both** files and records one failure naming the distinguishing locations. Indexing "whichever came first" is what it exists to prevent, because directory order is not stable across machines.

## Related Guides

- `contributing/adding-a-runtime.md` — the runtime adapter contract; a new runtime usually wants a search source too
- `contributing/adding-a-community-adapter.md` — the rooms port, and why bridged rooms are projections rather than backends
- `contributing/architecture.md` — the swappable seams this index reads behind
