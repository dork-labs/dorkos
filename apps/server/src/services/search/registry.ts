/**
 * The source array — one row per indexed source (message-search spec §3, D12).
 *
 * Adding a source means adding a row here and a pure projection beside it.
 * Nothing else varies: discovery, change detection and the incremental read are
 * written once per *mechanism* — `jsonl-frontier.ts` for M1, `row-frontier.ts`
 * for M2, `snapshot-frontier.ts` for M3 — and the writes every mechanism makes
 * (the upsert, the prune, the attempt stamp) are written once for ALL of them,
 * in `frontier-store.ts`.
 *
 * This is deliberately a record and not a `SearchAdapter` port. A port
 * abstracting three mechanisms and four functions is a class hierarchy standing
 * where a record would do. The trigger that would change that was written down
 * rather than left to taste — **the day a third mechanism is needed the
 * promotion fires** — and that day arrived with OpenCode (M3, the snapshot
 * read). **The promotion was refused**, on evidence rather than taste: M3 needed
 * none of M2's frontier logic rewritten, so the array held. ADR 260825-110420
 * records the refusal and the next trigger: a FOURTH mechanism, or a source that
 * lives outside `apps/server`.
 *
 * @module server/services/search/registry
 */
import path from 'path';
import { authors, roomEntries, rooms, and, asc, eq, gt, sql, type Db } from '@dorkos/db';
import { resolveClaudeRootSet } from '../runtimes/claude-code/claude-config-dir.js';
import { resolveCodexRolloutRoots } from '../runtimes/codex/codex-home.js';
import { resolveOpenCodeStorePath } from '../runtimes/opencode/opencode-data-dir.js';
import { discoverClaudeCodeTranscripts } from './claude-code-discovery.js';
import { discoverCodexRollouts } from './codex-discovery.js';
import { openOpenCodeSnapshot } from './opencode-store.js';
import { projectClaudeCodeLines } from './projections/claude-code.js';
import { projectCodexLines } from './projections/codex.js';
import { projectRoomEntries, type RoomEntrySourceRow } from './projections/rooms.js';
import type { FileSource, RowContainer, RowSource, SearchSource, SnapshotSource } from './types.js';

/**
 * The room log — **M2**, rows above a monotonic watermark.
 *
 * Rooms go first because DorkOS owns the write, so any bug here is ours and
 * cheap to see. It reads `room_entries` where it already lives and alters
 * nothing, which is the property that makes the index deletable.
 *
 * Archived rooms are indexed like any other. Archiving releases a channel's
 * slug; it does not unsay what was said, and a person searching their own
 * history is precisely the reader who has forgotten which room it was in.
 */
export const roomsSource: RowSource = {
  id: 'rooms',
  mechanism: 'rows',

  listContainers(db: Db): RowContainer[] {
    // One GROUP BY answers discovery AND change detection. A LEFT JOIN so a room
    // with no entries yet is still a container — it discovers as `maxOrdinal: 0`,
    // matches its absent watermark, and is skipped without a read.
    const rows = db
      .select({
        originKey: rooms.id,
        maxOrdinal: sql<number>`COALESCE(MAX(${roomEntries.seq}), 0)`,
      })
      .from(rooms)
      .leftJoin(roomEntries, eq(roomEntries.roomId, rooms.id))
      .groupBy(rooms.id)
      .all();

    return rows.map((row) => ({
      originKey: row.originKey,
      // A room is not a directory, so there is no working directory a hit could
      // open in (spec §4). The column is nullable for exactly this.
      containerPath: null,
      maxOrdinal: row.maxOrdinal,
    }));
  },

  readSince(db: Db, originKey: string, afterOrdinal: number) {
    // Explicit fields, never `SELECT *` — the index reads what it projects and
    // nothing else. A LEFT JOIN onto `authors` because dropping an entry whose
    // author row is missing would lose a real message to a broken join; the
    // projection reads a null kind as "not a human" instead.
    const rows: RoomEntrySourceRow[] = db
      .select({
        roomId: roomEntries.roomId,
        seq: roomEntries.seq,
        kind: roomEntries.kind,
        authorKind: authors.kind,
        body: roomEntries.body,
        createdAt: roomEntries.createdAt,
      })
      .from(roomEntries)
      .leftJoin(authors, eq(authors.id, roomEntries.authorId))
      .where(and(eq(roomEntries.roomId, originKey), gt(roomEntries.seq, afterOrdinal)))
      // Stated rather than inherited. `room_entries` is keyed `(room_id, seq)`,
      // so this ordering already falls out of the primary key and no test can
      // tell the clause apart from its absence — but the projection's contract
      // says "in ordinal order", and a contract that holds only because of the
      // shape of somebody else's index is one nobody can safely change.
      .orderBy(asc(roomEntries.seq))
      .all();

    return projectRoomEntries(rows);
  },
};

/**
 * Build a Claude Code source over a set of projects roots.
 *
 * The roots are a parameter rather than a call so a test can point the source at
 * fixture trees instead of at the operator's real history.
 *
 * @param resolveProjectsRoots - Called at the start of every sweep, never
 *   cached: an operator who registers or removes a Claude account mid-session
 *   must be indexed from the new set on the next tick rather than after a
 *   restart.
 * @returns The registry row.
 */
export function createClaudeCodeSource(resolveProjectsRoots: () => readonly string[]): FileSource {
  return {
    id: 'claude-code',
    mechanism: 'jsonl',
    discover: (known) => discoverClaudeCodeTranscripts(resolveProjectsRoots(), known),
    project: projectClaudeCodeLines,
  };
}

/**
 * Claude Code transcripts — **M1**, append-only JSONL tailed at a byte offset.
 *
 * This is where the corpus and the value are: sessions run inside DorkOS and
 * sessions run from the bare `claude` CLI land in the same place and are indexed
 * the same way, because the index reads what the SDK wrote rather than anything
 * DorkOS recorded.
 *
 * **The roots are resolved, never hardcoded.** A hardcoded `~/.claude` silently
 * split-brains the moment anything sets `CLAUDE_CONFIG_DIR` (DOR-250), and
 * `os.homedir()` is banned in this tree for the same reason: there is exactly
 * one module allowed to know where a home directory is.
 *
 * **And it is a SET, because one root is measurably wrong.** Measured on the
 * operator's machine 2026-07-29, when three Claude Code accounts were live:
 * indexing only the active root covered at most 67% of their Claude Code
 * history, and 3.5% when the server inherited a minor root from its shell —
 * which is how this feature's own decomposition ran. Re-measured 2026-08-25 with
 * two accounts registered: 9,110 messages of 19,124. Nothing reported an error
 * on any of those runs, because a short result list is indistinguishable from a
 * complete one. That is spec G4's refusal — "a search box that silently covers
 * less for one runtime than another" — landing on the same runtime twice over.
 *
 * **Which set is not this module's decision.** {@link resolveClaudeRootSet} owns
 * it, and it is deliberately not a glob: `~/.claude*` on this machine sweeps up
 * `.claude-worktrees` and `.claudekit`, which are not accounts. The set is the
 * active root, `$CLAUDE_CONFIG_DIR`, `~/.claude`, and every account registered
 * in `runtimes.claudeCode.accounts` — so a fourth profile is added by
 * configuration rather than by a code change, and none of it is guessed.
 *
 * Reading the SET rather than the active root is also the difference between the
 * two questions a Claude root resolver gets asked. `resolveActiveClaudeRoot()`
 * answers "where does new work run and bill", and a session listing or a
 * transcript read-back MUST match the SDK exactly. The index asks "where does
 * this person's history live", and the honest answer is all of it.
 */
export const claudeCodeSource: FileSource = createClaudeCodeSource(() =>
  resolveClaudeRootSet().map((root) => path.join(root, 'projects'))
);

/**
 * Build a Codex source over a set of rollout roots.
 *
 * The roots are a parameter for the same reason Claude Code's are: so a test can
 * point the source at fixture trees instead of at the operator's real history.
 *
 * @param resolveRolloutRoots - Called at the start of every sweep, never cached,
 *   so a `CODEX_HOME` that changes under a running server is picked up on the
 *   next tick rather than after a restart.
 * @returns The registry row.
 */
export function createCodexSource(resolveRolloutRoots: () => readonly string[]): FileSource {
  return {
    id: 'codex',
    mechanism: 'jsonl',
    discover: (known) => discoverCodexRollouts(resolveRolloutRoots(), known),
    project: projectCodexLines,
  };
}

/**
 * Build an OpenCode source over a store path.
 *
 * The path is a parameter rather than a call so a test can point the source at a
 * fixture store instead of at the operator's real OpenCode history.
 *
 * @param resolveStorePath - Called at the start of every sweep, never cached: an
 *   operator who sets `$OPENCODE_DB` or `$XDG_DATA_HOME` mid-session must be
 *   indexed from the new store on the next tick rather than after a restart.
 *   Answers `null` when OpenCode is configured to keep no file at all.
 * @param options - Test seams for the volatility window, passed straight through
 *   to {@link openOpenCodeSnapshot}. Production passes none.
 * @returns The registry row.
 */
export function createOpenCodeSource(
  resolveStorePath: () => string | null,
  options: { now?: () => number; volatileWindowMs?: number } = {}
): SnapshotSource {
  return {
    id: 'opencode',
    mechanism: 'sqlite-snapshot',
    open: () => {
      const storePath = resolveStorePath();
      // Resolved to nothing, or nothing at the path: OpenCode may never have run
      // here. The sweep indexes nothing and prunes nothing.
      return Promise.resolve(storePath === null ? null : openOpenCodeSnapshot(storePath, options));
    },
  };
}

/**
 * Codex rollout files — **M1**, the same mechanism Claude Code rides.
 *
 * **This is the row the design's central claim was written to be tested by.**
 * ADR 260728-214214 says adding a source is one registry row and one pure
 * projection because discovery, change detection and the incremental read are
 * written once per MECHANISM. Codex needed no mechanism: `jsonl-frontier.ts` is
 * untouched by this source, and the twin refusal, the shrink rebuild, the
 * partial-line rule and the prune suppression all apply to it without a line of
 * new code. What it did need beyond "one row, one projection" is its own
 * `discover` — which the {@link FileSource} interface has always had, because a
 * source is what knows where its files are and which of them are real.
 *
 * **Two roots, and both are somebody's history.** `sessions/` holds live threads
 * under `YYYY/MM/DD/`; `archived_sessions/` holds the ones the operator
 * archived, flat. Reading only the first would be DOR-682's failure in a new
 * place — a box that covers less than the person's history and says nothing
 * about it.
 *
 * **The corpus is small and that is not the argument.** Measured 2026-08-25: 18
 * files, 7.0 MB, **214 indexable messages** beside Claude Code's 19,124 — about
 * 1.1%. The case is that the multi-runtime cockpit is the product's headline
 * differentiator, and a search box covering one runtime undercuts the claim the
 * product leads with.
 */
export const codexSource: FileSource = createCodexSource(() => resolveCodexRolloutRoots());

/**
 * OpenCode conversations — **M3**, another program's SQLite store read through a
 * throwaway snapshot.
 *
 * **This reverses one line of ADR-0308**, which held that `opencode.db` is
 * "never read or written directly", and the reversal is narrow on purpose. The
 * reason for that line has not gone away: the file holds `account.access_token`,
 * `account.refresh_token` and `credential.value` beside its messages. What
 * changed is that the read can be made structurally incapable of reaching them —
 * a copy of the file, opened read-only, with every statement built from a frozen
 * table-and-column allowlist that carries no credential table
 * (`opencode-store.ts`). ADR 260825-110420 carries the full argument, including
 * the part that did NOT change: **the SDK path stays forbidden for indexing**,
 * because a reconciler on a timer must never spawn somebody else's agent server
 * to read what is already at rest on disk.
 *
 * The corpus is small — 50 messages across 63 top-level sessions on the
 * operator's machine, 2026-08-25, against 19,124 from Claude Code — and that is
 * not the point. A search box that silently covers less for one runtime than
 * another is the failure this feature exists to refuse (spec G4), and "one place
 * for every AI agent you run" is a claim search has to be able to keep.
 */
export const openCodeSource: SnapshotSource = createOpenCodeSource(resolveOpenCodeStorePath);

/**
 * Every source the indexer sweeps.
 *
 * Four entries over three mechanisms. Claude Code and Codex share M1 (append-only
 * JSONL tailed at a byte offset); the room log is M2 (rows above a monotonic
 * watermark); OpenCode is M3 (another program's SQLite store, read through a
 * throwaway snapshot).
 *
 * M3's arrival is what the design named as the trigger for promoting this array
 * to a `SearchAdapter` port. **The promotion was refused**, on evidence rather
 * than taste: M3 reuses M2's whole frontier implementation through a
 * `ContainerReader` seam. ADR 260825-110420 records the refusal and the next
 * trigger — a FOURTH mechanism, or a source living outside `apps/server`.
 *
 * **The order is the sweep order.** Rooms first: DorkOS owns that write, so it
 * is cheap to reconcile and any bug in it is ours. Then the filesystem walks,
 * largest corpus first, so the source carrying 99% of the messages is not
 * waiting behind the one carrying 1%. OpenCode last: it copies a file before it
 * reads one, and it carries the fewest messages of the three.
 */
export const SEARCH_SOURCES: readonly SearchSource[] = [
  roomsSource,
  claudeCodeSource,
  codexSource,
  openCodeSource,
];
