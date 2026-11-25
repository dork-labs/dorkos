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
  });
});
