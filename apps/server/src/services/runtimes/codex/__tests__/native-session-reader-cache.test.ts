import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexNativeSessionReader } from '../native-session-reader.js';

vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

/** Write one rollout whose head names `cwd` and a first user message. */
async function writeRollout(home: string, id: string, cwd: string): Promise<string> {
  const file = path.join(home, 'sessions', `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const records = [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id, cwd } },
    {
      type: 'response_item',
      timestamp: '2026-01-01T00:00:01Z',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `hi ${id}` }],
      },
    },
  ];
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('Codex native session listing cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads each rollout head once, however often the store is listed', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-cache-'));
    try {
      await mkdir(path.join(home, 'sessions'), { recursive: true });
      const ids = [
        '0195bfa1-e000-7000-8000-000000000001',
        '0195bfa1-e000-7000-8000-000000000002',
        '0195bfa1-e000-7000-8000-000000000003',
      ];
      for (const id of ids) await writeRollout(home, id, '/project');
      const reader = new CodexNativeSessionReader(() => home);
      const reads = vi.mocked(fs.createReadStream);
      reads.mockClear();

      expect(await reader.listSessions('/project')).toHaveLength(3);
      const afterFirst = reads.mock.calls.length;
      expect(afterFirst).toBeLessThanOrEqual(6);

      // Past the inventory window: the roots are walked again, but no head is re-read.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
      expect(await reader.listSessions('/project')).toHaveLength(3);
      expect(await reader.listSessions('/elsewhere')).toHaveLength(0);
      expect(reads.mock.calls.length).toBe(afterFirst);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps an appended rollout current without re-reading its head, and forgets a removed one', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'codex-cache-'));
    try {
      await mkdir(path.join(home, 'sessions'), { recursive: true });
      const id = '0195bfa1-e000-7000-8000-000000000001';
      const file = await writeRollout(home, id, '/project');
      const reader = new CodexNativeSessionReader(() => home);
      const reads = vi.mocked(fs.createReadStream);

      const [first] = await reader.listSessions('/project');
      expect(first?.title).toBe(`hi ${id}`);
      reads.mockClear();

      // The conversation goes on: the file grows and its mtime moves.
      await appendFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'x' } }) + '\n');
      const later = new Date('2026-06-01T00:00:00Z');
      await utimes(file, later, later);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);

      const [second] = await reader.listSessions('/project');
      expect(second?.title).toBe(`hi ${id}`);
      expect(second?.updatedAt).toBe(later.toISOString());
      expect(reads).not.toHaveBeenCalled();

      await rm(file);
      clock.mockReturnValue(now + 120_000);
      expect(await reader.listSessions('/project')).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
