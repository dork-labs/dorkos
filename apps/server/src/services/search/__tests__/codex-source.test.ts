import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, searchSources, eq, type Db } from '@dorkos/db';
import { sweepFileSource } from '../jsonl-frontier.js';
import { createCodexSource } from '../registry.js';
import type { FileSource, SourceSweep } from '../types.js';

/**
 * The Codex registry row end to end: real files, real M1 mechanism, real
 * frontier — the proof that "one row and one projection" is the whole of what
 * this source added.
 *
 * The twin case is the one that needed a home. `jsonl-frontier.ts` refuses BOTH
 * files when two claim one container id, and Codex is where that stops being
 * hypothetical: archiving a thread is a MOVE today, so a release that started
 * copying instead would put every archived session id in two roots at once.
 * That must be loud and empty, never "whichever root came first".
 */

let db: Db;
let home: string;
let source: FileSource;

beforeEach(async () => {
  db = createTestDb();
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-codex-source-'));
  source = createCodexSource(() => [
    path.join(home, 'sessions'),
    path.join(home, 'archived_sessions'),
  ]);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** The `session_meta` header line, with its trailing newline. */
function metaLine(sessionId: string, cwd: string): string {
  return `${JSON.stringify({
    timestamp: '2026-08-08T10:32:17.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd },
  })}\n`;
}

/** One `response_item` message line, with its trailing newline. */
function messageLine(role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    timestamp: '2026-08-08T10:32:18.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
  })}\n`;
}

/** Write a rollout under `relativeRoot`, returning its path. */
async function writeRollout(
  relativeRoot: string,
  sessionId: string,
  lines: string[],
  cwd = '/repo/project'
): Promise<string> {
  const file = path.join(home, relativeRoot, `rollout-2026-08-08T10-32-17-${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, metaLine(sessionId, cwd) + lines.join(''));
  return file;
}

/** Sweep the fixture home once. */
async function sweep(at = '2026-08-08T12:00:00.000Z'): Promise<SourceSweep> {
  return sweepFileSource(db, source, at);
}

/** Every indexed body for one session, in ordinal order. */
function indexedBodies(originKey: string): string[] {
  return db
    .select({ ordinal: messages.ordinal, body: messages.body })
    .from(messages)
    .where(eq(messages.originKey, originKey))
    .orderBy(messages.ordinal)
    .all()
    .map((row) => row.body);
}

describe('the Codex source over the shared M1 mechanism', () => {
  it('indexes a rollout and records where a hit opens', async () => {
    await writeRollout('sessions/2026/08/08', 'aaaa-1111', [
      messageLine('user', 'why is the deploy stuck'),
      messageLine('assistant', 'The lock file is held by a dead job.'),
    ]);

    const result = await sweep();

    expect(result.sourceId).toBe('codex');
    expect(result.indexed).toBe(2);
    expect(result.failures).toEqual([]);
    expect(indexedBodies('aaaa-1111')).toEqual([
      'why is the deploy stuck',
      'The lock file is held by a dead job.',
    ]);

    const frontier = db
      .select({
        containerPath: searchSources.containerPath,
        lastOrdinal: searchSources.lastOrdinal,
        lastError: searchSources.lastError,
      })
      .from(searchSources)
      .where(eq(searchSources.sourceId, 'codex'))
      .all();
    expect(frontier).toEqual([{ containerPath: '/repo/project', lastOrdinal: 1, lastError: null }]);
  });

  it('reads only what a rollout gained since the last sweep', async () => {
    const file = await writeRollout('sessions/2026/08/08', 'bbbb-2222', [
      messageLine('user', 'first question'),
    ]);
    expect((await sweep()).indexed).toBe(1);

    // A no-op sweep must report 0, not "the same count as before": an unchanged
    // `count(*)` passes for a sweep that correctly did nothing AND for one that
    // re-read and re-upserted every row.
    expect((await sweep()).indexed).toBe(0);

    await fs.appendFile(file, messageLine('assistant', 'second answer'));
    const third = await sweep();

    expect(third.indexed).toBe(1);
    expect(indexedBodies('bbbb-2222')).toEqual(['first question', 'second answer']);
  });

  it('refuses BOTH files when a session id turns up in two roots', async () => {
    // The shape a Codex release that copied on archive instead of moving would
    // make, for every archived thread at once.
    await writeRollout('sessions/2026/08/08', 'cccc-3333', [messageLine('user', 'the live copy')]);
    await writeRollout('archived_sessions', 'cccc-3333', [
      messageLine('user', 'the archived copy'),
    ]);
    await writeRollout('sessions/2026/08/08', 'dddd-4444', [
      messageLine('user', 'an untouched neighbour'),
    ]);

    const result = await sweep();

    // Nothing from the contested id — not the first root's copy, not the
    // second's. Directory order is not stable across machines, so indexing
    // "whichever came first" would put a different half in the index on
    // different runs.
    expect(indexedBodies('cccc-3333')).toEqual([]);
    expect(indexedBodies('dddd-4444')).toEqual(['an untouched neighbour']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sourceId).toBe('codex');
    expect(result.failures[0]?.originKey).toBe('cccc-3333');
    // Named by full path, which is what tells an operator WHICH two roots
    // collided; a bare session id would leave them grepping for it.
    expect(result.failures[0]?.message).toContain('archived_sessions');
    expect(result.failures[0]?.message).toContain('sessions/2026/08/08');
  });

  it('carries an archived thread across, without re-reading it or losing its place', async () => {
    // Archiving is a MOVE, and the whole twin argument above rests on that —
    // so it is pinned rather than asserted in a comment. The container id is
    // the filename's session id and the filename does not change, so the same
    // thread arrives under the same id in the other root: nothing is re-read,
    // nothing is pruned, and an append after the move continues the numbering
    // rather than restarting it.
    const live = await writeRollout('sessions/2026/08/08', 'ffff-6666', [
      messageLine('user', 'said before it was archived'),
    ]);
    expect((await sweep()).indexed).toBe(1);

    const archived = path.join(home, 'archived_sessions', path.basename(live));
    await fs.mkdir(path.dirname(archived), { recursive: true });
    await fs.rename(live, archived);

    const afterMove = await sweep();
    expect(afterMove.indexed).toBe(0);
    expect(afterMove.pruned).toBe(0);
    expect(afterMove.failures).toEqual([]);
    expect(indexedBodies('ffff-6666')).toEqual(['said before it was archived']);

    await fs.appendFile(archived, messageLine('assistant', 'said after it was archived'));
    const afterAppend = await sweep();

    expect(afterAppend.indexed).toBe(1);
    expect(indexedBodies('ffff-6666')).toEqual([
      'said before it was archived',
      'said after it was archived',
    ]);
    // Ordinal 1, not 0: the move did not cost the thread its place.
    expect(
      db
        .select({ ordinal: messages.ordinal })
        .from(messages)
        .where(eq(messages.originKey, 'ffff-6666'))
        .orderBy(messages.ordinal)
        .all()
        .map((row) => row.ordinal)
    ).toEqual([0, 1]);
  });

  it('drops a rollout that is gone', async () => {
    const file = await writeRollout('sessions/2026/08/08', 'eeee-5555', [
      messageLine('user', 'said in a directory that later vanished'),
    ]);
    await sweep();
    expect(indexedBodies('eeee-5555')).toHaveLength(1);

    await fs.rm(file);
    const result = await sweep();

    expect(result.pruned).toBe(1);
    expect(indexedBodies('eeee-5555')).toEqual([]);
  });
});
