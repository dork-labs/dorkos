import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors, roomEntries, rooms, type Db } from '@dorkos/db';
import type BetterSqlite3 from 'better-sqlite3';
import { SearchIndexer } from '../indexer.js';
import {
  createClaudeCodeSource,
  createCodexSource,
  createOpenCodeSource,
  roomsSource,
  selectSearchSources,
  SEARCH_SOURCES,
} from '../registry.js';
import type { SearchSource } from '../types.js';

/**
 * A server told to read nobody's history reads nobody's history — measured in
 * rows, not asserted from the registry (DOR-1551).
 *
 * **The leak this closes.** The browser suite gives each Express leg its own
 * throwaway `DORK_HOME` under `/tmp`, wiped before every boot (DOR-1223). That
 * isolates everything DorkOS owns and nothing else: `resolveClaudeRootSet()`,
 * `resolveCodexRolloutRoots()` and `resolveOpenCodeStorePath()` all resolve from
 * the operator's HOME directory and do not move when `DORK_HOME` does. So every
 * `pnpm test:browser` swept ~9,250 of the operator's real Claude Code messages
 * (measured 2026-08-25) into a full-text index inside a world-readable temp
 * directory — read-only against the transcripts, and still a searchable copy of
 * everything that person ever said, written by a run nobody thought was reading
 * anything.
 *
 * **Why the sweep runs for real here.** The gate is a filter over an array, so a
 * test that only compared arrays would pass for a filter nothing ever calls.
 * These sweep a real `SearchIndexer` over a real migrated database and count the
 * rows each source landed — and the first test is the WITHOUT-the-gate
 * measurement the gated one is compared against, so deleting the filter's body
 * turns this file red rather than leaving it quietly green.
 *
 * **No real history is touched.** Every source is built through its `create*`
 * factory with a resolver pointed at a fixture tree, which is what those
 * parameters have always been for. The resolvers are spies as well as fixtures,
 * because "zero rows" and "never even looked" are different claims and the
 * second is the one that matters: a source that is never swept never calls the
 * function that would reach into `~/.claude`.
 */

let db: Db;
let raw: BetterSqlite3.Database;
let home: string;

/** Called whenever something asks where Claude Code's history lives. */
let claudeRoots: ReturnType<typeof vi.fn>;
/** Called whenever something asks where Codex's rollouts live. */
let codexRoots: ReturnType<typeof vi.fn>;
/** Called whenever something asks where OpenCode's store lives. */
let openCodeStore: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = createTestDb();
  raw = db.$client;
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-external-history-'));

  db.insert(authors)
    .values({
      id: 'author-human',
      kind: 'human',
      naturalKey: 'local',
      displayName: 'You',
      createdAt: '2026-09-01T09:00:00.000Z',
    })
    .run();
  db.insert(rooms)
    .values({
      id: 'room-1',
      kind: 'channel',
      slug: 'room-1',
      title: 'room-1',
      topic: null,
      createdAt: '2026-09-01T09:00:00.000Z',
      lastActivityAt: '2026-09-01T09:00:00.000Z',
    })
    .run();
  db.insert(roomEntries)
    .values({
      roomId: 'room-1',
      seq: 1,
      id: 'room-1-1',
      authorId: 'author-human',
      kind: 'post',
      body: JSON.stringify({ text: 'the room the suite seeded' }),
      mentions: '[]',
      sessionId: null,
      cascadeRoot: 'room-1-1',
      cascadeDepth: 0,
      createdAt: '2026-09-01T10:00:00.000Z',
    })
    .run();

  // A Claude Code transcript, in the layout discovery walks:
  // `<projectsRoot>/<slug>/<sessionId>.jsonl`.
  const transcript = path.join(home, 'claude', 'projects', '-repo-project', 'session-1.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(
    transcript,
    `${JSON.stringify({
      type: 'user',
      uuid: 'u-1',
      cwd: '/repo/project',
      message: { role: 'user', content: 'what the operator said in private' },
    })}\n`
  );

  // A Codex rollout, in the layout its discovery expects:
  // `<root>/rollout-<ISO>-<sessionId>.jsonl`, header record first.
  const rollout = path.join(home, 'codex', 'sessions', 'rollout-2026-09-01T10-00-00-cdx-1.jsonl');
  await fs.mkdir(path.dirname(rollout), { recursive: true });
  await fs.writeFile(
    rollout,
    `${JSON.stringify({
      timestamp: '2026-09-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'cdx-1', cwd: '/repo/project' },
    })}\n${JSON.stringify({
      timestamp: '2026-09-01T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'what the operator asked Codex' }],
      },
    })}\n`
  );

  claudeRoots = vi.fn(() => [path.join(home, 'claude', 'projects')]);
  codexRoots = vi.fn(() => [path.join(home, 'codex', 'sessions')]);
  // Answers "OpenCode has never run here", which is a legitimate production
  // answer. It indexes nothing either way — what discriminates for this source
  // is whether it is ASKED, which the spy records.
  openCodeStore = vi.fn(() => null);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/**
 * The four registry rows, each pointed at this test's fixtures instead of at
 * whatever this machine's operator has on disk.
 */
function fixtureSources(): readonly SearchSource[] {
  return [
    roomsSource,
    createClaudeCodeSource(claudeRoots as () => readonly string[]),
    createCodexSource(codexRoots as () => readonly string[]),
    createOpenCodeSource(openCodeStore as () => string | null),
  ];
}

/** How many indexed rows each source landed, keyed by source id. */
function rowsBySource(): Record<string, number> {
  const rows = raw
    .prepare('SELECT source_id, COUNT(*) AS n FROM messages GROUP BY source_id')
    .all() as { source_id: string; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.source_id, row.n]));
}

/** Sweep once with the gate in the given position. */
async function sweepWith(excludeExternalHistory: boolean): Promise<void> {
  const sources = selectSearchSources({ excludeExternalHistory }, fixtureSources());
  await new SearchIndexer(db, sources).sweep();
}

describe('a sweep with the external-history gate open', () => {
  it('indexes every runtime — the measurement the gated sweep is compared against', async () => {
    await sweepWith(false);

    // Not `toBeGreaterThan(0)`: the exact counts are what make the gated
    // assertion below mean something. One room entry, one Claude Code message,
    // one Codex message.
    expect(rowsBySource()).toEqual({ rooms: 1, 'claude-code': 1, codex: 1 });
    expect(claudeRoots).toHaveBeenCalled();
    expect(codexRoots).toHaveBeenCalled();
    expect(openCodeStore).toHaveBeenCalled();
  });
});

describe('a sweep with the external-history gate closed', () => {
  it('writes zero rows from any corpus DorkOS does not own', async () => {
    await sweepWith(true);

    // The room the suite seeded is still indexed — the gate narrows the index to
    // this data directory, it does not switch search off.
    expect(rowsBySource()).toEqual({ rooms: 1 });
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE source_id != 'rooms'").get()
    ).toEqual({ n: 0 });
  });

  it('never even asks where another program keeps its history', async () => {
    await sweepWith(true);

    // Stronger than the row count, and the claim DOR-1551 is really about: these
    // three resolvers are the ones that reach into the operator's home
    // directory, and an unswept source never calls them. Zero rows could also be
    // an empty corpus; zero calls cannot.
    expect(claudeRoots).not.toHaveBeenCalled();
    expect(codexRoots).not.toHaveBeenCalled();
    expect(openCodeStore).not.toHaveBeenCalled();
  });

  it('leaves no frontier row behind for an unswept source', async () => {
    await sweepWith(true);

    // A frontier row records "we have read this container up to here". A source
    // that was never swept must own none — otherwise a later ungated run would
    // resume from a watermark nothing wrote.
    const frontier = raw
      .prepare('SELECT DISTINCT source_id FROM search_sources ORDER BY source_id')
      .all() as { source_id: string }[];
    expect(frontier.map((row) => row.source_id)).toEqual(['rooms']);
  });
});

describe('the registry says which sources read somebody else', () => {
  it('tags every row, and tags the three runtime sources external', () => {
    // Asserted as pairs rather than as a filtered list: this is the field the
    // gate reads, so a row that silently flipped to `dorkos` would leak the
    // corpus it names while every count assertion above stayed green.
    expect(SEARCH_SOURCES.map((source) => [source.id, source.corpus])).toEqual([
      ['rooms', 'dorkos'],
      ['claude-code', 'external'],
      ['codex', 'external'],
      ['opencode', 'external'],
    ]);
  });

  it('narrows the REAL registry to the room log, without being handed a list', () => {
    // The production call site passes no source list, so the default parameter
    // is what a booted server actually gets. Asserted separately from the
    // fixture sweeps above for exactly that reason.
    expect(
      selectSearchSources({ excludeExternalHistory: true }).map((source) => source.id)
    ).toEqual(['rooms']);
    expect(selectSearchSources({ excludeExternalHistory: false })).toBe(SEARCH_SOURCES);
  });
});
