/**
 * The source array — one row per indexed source (message-search spec §3, D12).
 *
 * Adding a source means adding a row here and a pure projection beside it.
 * Nothing else varies: discovery, change detection and the incremental read are
 * written once per *mechanism* — `row-frontier.ts` for M2, `jsonl-frontier.ts`
 * for M1 — and the writes both mechanisms make (the upsert, the prune, the
 * attempt stamp) are written once for BOTH, in `frontier-store.ts`.
 *
 * This is deliberately a record and not a `SearchAdapter` port. A port
 * abstracting two mechanisms and three functions is a class hierarchy standing
 * where a record would do. The trigger that would change that is written down
 * rather than left to taste: **the day a third mechanism is needed the promotion
 * fires**, and the source that would introduce one (OpenCode, whose SDK poll has
 * no resumption primitive and requires a live child process) is deferred for
 * that reason among others.
 *
 * @module server/services/search/registry
 */
import path from 'path';
import { authors, roomEntries, rooms, and, asc, eq, gt, sql, type Db } from '@dorkos/db';
import { resolveClaudeRootSet } from '../runtimes/claude-code/claude-config-dir.js';
import { discoverClaudeCodeTranscripts } from './claude-code-discovery.js';
import { projectClaudeCodeLines } from './projections/claude-code.js';
import { projectRoomEntries, type RoomEntrySourceRow } from './projections/rooms.js';
import type { FileSource, RowContainer, RowSource, SearchSource } from './types.js';

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
 * Every source the indexer sweeps.
 *
 * Two entries, one per mechanism. Codex joins Claude Code on M1 with one more
 * row and one more projection; OpenCode is deferred, and its deferral — its SDK
 * poll has no resumption primitive and needs a live child process, which would
 * be a third mechanism — is what keeps this an array of records rather than a
 * port.
 */
export const SEARCH_SOURCES: readonly SearchSource[] = [roomsSource, claudeCodeSource];
