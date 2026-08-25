import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { discoverCodexRollouts } from '../codex-discovery.js';
import { logger } from '../../../lib/logger.js';

/**
 * Codex discovery has one job Claude Code's does not: it takes the container id
 * from the FILENAME, and the whole cost model of the sweep rests on that. A
 * frontier keyed by an id only the bytes carry could not be consulted before
 * reading those bytes, so every rollout would be head-read on every tick
 * forever. The head-read tests below are what pin it.
 */

let home: string;

beforeEach(async () => {
  vi.mocked(logger.warn).mockClear();
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-codex-discovery-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** The two roots a Codex home holds, in sweep order. */
function roots(): string[] {
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}

/** Write a rollout whose `session_meta` names `cwd`. */
async function writeRollout(
  relative: string,
  cwd: string | null,
  extraLines: unknown[] = []
): Promise<string> {
  const full = path.join(home, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const meta = {
    timestamp: '2026-08-08T10:32:17.000Z',
    type: 'session_meta',
    payload: {
      id: path.basename(relative, '.jsonl').split('-').slice(4).join('-'),
      ...(cwd === null ? {} : { cwd }),
    },
  };
  const lines = [meta, ...extraLines].map((record) => JSON.stringify(record));
  await fs.writeFile(full, `${lines.join('\n')}\n`);
  return full;
}

/** The reason discovery recorded for a path, or undefined when it indexed it. */
function reasonFor(
  skipped: { path: string; reason: string }[],
  filePath: string
): string | undefined {
  return skipped.find((entry) => entry.path === filePath)?.reason;
}

describe('discovering Codex rollouts', () => {
  it('reads live and archived threads as one corpus', async () => {
    // Archiving releases a thread from the day tree; it does not unsay what was
    // said, and the person searching is the one who has forgotten which state it
    // is in.
    const live = await writeRollout(
      'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-aaaa.jsonl',
      '/repo/live'
    );
    const archived = await writeRollout(
      'archived_sessions/rollout-2026-04-08T14-48-45-019d6ea3-bbbb.jsonl',
      '/repo/archived'
    );

    const found = await discoverCodexRollouts(roots());

    expect(found.files.map((file) => file.filePath)).toEqual([live, archived]);
    expect(found.files.map((file) => file.originKey)).toEqual(['019fe200-aaaa', '019d6ea3-bbbb']);
    expect(found.files.map((file) => file.containerPath)).toEqual(['/repo/live', '/repo/archived']);
    expect(found.skipped).toEqual([]);
    expect(found.failures).toEqual([]);
  });

  it('walks the whole day tree rather than one level of it', async () => {
    const deep = await writeRollout(
      'sessions/2026/07/22/rollout-2026-07-22T12-13-57-019f8ad1-cccc.jsonl',
      '/repo'
    );

    const found = await discoverCodexRollouts(roots());

    expect(found.files.map((file) => file.filePath)).toEqual([deep]);
  });

  it('reports a .jsonl that is not named like a rollout instead of indexing it', async () => {
    // `$CODEX_HOME` holds other newline-delimited files — `session_index.jsonl`
    // is the shipped example — and a file with no session id in its name has
    // nothing honest to be indexed under.
    const stray = path.join(home, 'sessions', 'session_index.jsonl');
    await fs.mkdir(path.dirname(stray), { recursive: true });
    await fs.writeFile(stray, '{"id":"whatever"}\n');

    const found = await discoverCodexRollouts(roots());

    expect(found.files).toEqual([]);
    expect(reasonFor(found.skipped, stray)).toBe('not-a-rollout');
  });

  it('takes the container id from the filename, not from the head record', async () => {
    // They agree on 18 of 18 files measured — and when they disagree the
    // FILENAME wins, because that is the id the frontier can be keyed by before
    // anything has been read.
    const file = path.join(
      home,
      'sessions/2026/08/08/rollout-2026-08-08T10-32-17-from-the-filename.jsonl'
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${JSON.stringify({
        timestamp: 'x',
        type: 'session_meta',
        payload: { id: 'from-the-head-record', cwd: '/repo' },
      })}\n`
    );

    const found = await discoverCodexRollouts(roots());

    expect(found.files.map((file) => file.originKey)).toEqual(['from-the-filename']);
  });

  it('finds the working directory in a record after the header, when the header has none', async () => {
    const file = await writeRollout(
      'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-dddd.jsonl',
      null,
      [{ timestamp: 'x', type: 'turn_context', payload: { cwd: '/repo/from-the-turn' } }]
    );

    const found = await discoverCodexRollouts(roots());

    expect(found.files[0]?.filePath).toBe(file);
    expect(found.files[0]?.containerPath).toBe('/repo/from-the-turn');
  });

  it('indexes a rollout that names no working directory, with a null container path', async () => {
    await writeRollout('sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-eeee.jsonl', null);

    const found = await discoverCodexRollouts(roots());

    expect(found.files.map((file) => file.originKey)).toEqual(['019fe200-eeee']);
    expect(found.files[0]?.containerPath).toBeNull();
  });

  it('carries the size and mtime that change detection runs on', async () => {
    const file = await writeRollout(
      'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-ffff.jsonl',
      '/repo'
    );
    const stat = await fs.stat(file);

    const found = await discoverCodexRollouts(roots());

    expect(found.files[0]?.sizeBytes).toBe(stat.size);
    expect(found.files[0]?.mtimeMs).toBe(stat.mtimeMs);
  });

  it('is empty and silent on a machine where Codex has never run', async () => {
    const found = await discoverCodexRollouts([
      path.join(home, 'nowhere', 'sessions'),
      path.join(home, 'nowhere', 'archived_sessions'),
    ]);

    // Silent specifically. An absent root is a runtime nobody has used, not a
    // fault, and a warning here would fire on every machine without Codex.
    expect(found).toEqual({ files: [], skipped: [], failures: [] });
  });

  it('reports a root that exists and will not be listed', async () => {
    // Then the corpus is short by an unknown amount, which is the failure this
    // feature refuses — and the sweep stops pruning on it.
    const sessions = path.join(home, 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    // A file where a directory belongs: `readdir` fails with ENOTDIR, which is
    // the "there but unreadable" case without needing a chmod that root ignores.
    const archived = path.join(home, 'archived_sessions');
    await fs.writeFile(archived, 'not a directory');

    const found = await discoverCodexRollouts(roots());

    expect(found.failures).toHaveLength(1);
    expect(found.failures[0]?.root).toBe(archived);
  });

  it('collapses two spellings of one root instead of giving every file a twin', async () => {
    // Twins are refused rather than preferred, so one directory reached two ways
    // would index NOTHING at all, forever.
    const file = await writeRollout(
      'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-1111.jsonl',
      '/repo'
    );
    const link = path.join(home, 'sessions-link');
    await fs.symlink(path.join(home, 'sessions'), link);

    const found = await discoverCodexRollouts([path.join(home, 'sessions'), link]);

    expect(found.files.map((entry) => entry.filePath)).toEqual([file]);
  });

  describe('a head record too big to scan', () => {
    /**
     * A rollout whose `session_meta` is padded past the 256 KiB scan window and
     * carries its `cwd` at the very end, where the scan cannot reach it.
     *
     * The realistic version of this is `base_instructions` growing with a Codex
     * release; the padding stands in for it.
     */
    async function writeOversizedHead(sessionId: string): Promise<string> {
      const file = path.join(
        home,
        'sessions/2026/08/08',
        `rollout-2026-08-08T10-32-17-${sessionId}.jsonl`
      );
      await fs.mkdir(path.dirname(file), { recursive: true });
      const meta = {
        timestamp: '2026-08-08T10:32:17.000Z',
        type: 'session_meta',
        // `base_instructions` first, `cwd` last, so the field really is past
        // the window rather than merely in a long record.
        payload: { id: sessionId, base_instructions: 'x'.repeat(400 * 1024), cwd: '/repo/late' },
      };
      await fs.writeFile(file, `${JSON.stringify(meta)}\n`);
      return file;
    }

    it('says so, by path, instead of quietly indexing a session that opens nowhere', async () => {
      // The quiet version of this is the failure the whole feature refuses: the
      // session indexes, the results look healthy, and every one of its hits
      // opens nowhere with nothing anywhere saying why.
      const file = await writeOversizedHead('019fe200-9999');

      const found = await discoverCodexRollouts(roots());

      // Still indexed — its messages are what search is for, and dropping the
      // whole conversation to protect against an unknown directory is worse.
      expect(found.files.map((entry) => entry.originKey)).toEqual(['019fe200-9999']);
      expect(found.files[0]?.containerPath).toBeNull();
      expect(found.skipped).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn).mock.calls[0]?.[1]).toMatchObject({ filePath: file });
    });

    it('stays silent for a rollout that honestly names no directory', async () => {
      // The distinction that makes the warning worth anything: `null` from a
      // window that filled and `null` from a session with no cwd are the same
      // value and opposite facts, and only the first is a fault anyone can fix.
      await writeRollout(
        'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-8888.jsonl',
        null
      );

      const found = await discoverCodexRollouts(roots());

      expect(found.files[0]?.containerPath).toBeNull();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('the head read an unchanged rollout must not pay for', () => {
    /** A head reader that counts its callers instead of touching the disk. */
    function countingReader(cwd: string | null = '/repo') {
      const calls: string[] = [];
      return {
        calls,
        read: async (filePath: string) => {
          calls.push(filePath);
          return cwd;
        },
      };
    }

    it('does not read the head of a file whose size and mtime are unchanged', async () => {
      // A Codex `session_meta` record carries the CLI's whole system prompt, so
      // this read is up to 256 KiB per file — charged every five minutes
      // against files nothing has happened to, if the id came from the bytes.
      const file = await writeRollout(
        'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-2222.jsonl',
        '/repo'
      );
      const stat = await fs.stat(file);
      const reader = countingReader();

      const found = await discoverCodexRollouts(
        roots(),
        new Map([
          [
            '019fe200-2222',
            { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, containerPath: '/repo' },
          ],
        ]),
        reader.read
      );

      expect(reader.calls).toEqual([]);
      expect(found.files.map((entry) => entry.originKey)).toEqual(['019fe200-2222']);
      expect(found.files[0]?.containerPath).toBe('/repo');
    });

    it('reads the head when the file grew, even by one byte', async () => {
      const file = await writeRollout(
        'sessions/2026/08/08/rollout-2026-08-08T10-32-17-019fe200-3333.jsonl',
        '/repo/moved'
      );
      const stat = await fs.stat(file);
      const reader = countingReader('/repo/moved');

      const found = await discoverCodexRollouts(
        roots(),
        new Map([
          [
            '019fe200-3333',
            { sizeBytes: stat.size - 1, mtimeMs: stat.mtimeMs, containerPath: '/repo/stale' },
          ],
        ]),
        reader.read
      );

      expect(reader.calls).toEqual([file]);
      expect(found.files[0]?.containerPath).toBe('/repo/moved');
    });
  });
});
