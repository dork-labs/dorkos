import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { codexThreads, eq, type Db } from '@dorkos/db';
import { CodexThreadMap } from '../thread-map.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = 'thread_abc123';

describe('CodexThreadMap', () => {
  let db: Db;
  let threadMap: CodexThreadMap;

  beforeEach(() => {
    db = createTestDb();
    threadMap = new CodexThreadMap(db);
  });

  it('returns undefined for an unknown session', () => {
    expect(threadMap.getThreadId('unknown-session')).toBeUndefined();
  });

  it('round-trips setThreadId then getThreadId', () => {
    threadMap.setThreadId(SESSION_ID, THREAD_ID);
    expect(threadMap.getThreadId(SESSION_ID)).toBe(THREAD_ID);
  });

  it('is first-write-wins — a second setThreadId for the same session is a no-op', () => {
    threadMap.setThreadId(SESSION_ID, THREAD_ID);
    threadMap.setThreadId(SESSION_ID, 'thread_other456');
    expect(threadMap.getThreadId(SESSION_ID)).toBe(THREAD_ID);
  });

  it('stores independent mappings for different sessions', () => {
    const otherSessionId = '22222222-2222-4222-8222-222222222222';
    threadMap.setThreadId(SESSION_ID, THREAD_ID);
    threadMap.setThreadId(otherSessionId, 'thread_other456');
    expect(threadMap.getThreadId(SESSION_ID)).toBe(THREAD_ID);
    expect(threadMap.getThreadId(otherSessionId)).toBe('thread_other456');
  });

  it('get returns the full binding including the persisted cwd', () => {
    threadMap.setThreadId(SESSION_ID, THREAD_ID, '/projects/demo');
    expect(threadMap.get(SESSION_ID)).toEqual({
      threadId: THREAD_ID,
      cwd: '/projects/demo',
    });
  });

  it('get returns undefined cwd for a legacy binding written without one (backward compat)', () => {
    threadMap.setThreadId(SESSION_ID, THREAD_ID);
    expect(threadMap.get(SESSION_ID)).toEqual({
      threadId: THREAD_ID,
      cwd: undefined,
    });
  });

  it('get returns undefined for an unknown session', () => {
    expect(threadMap.get('unknown-session')).toBeUndefined();
  });

  it('persists a createdAt timestamp in ISO 8601 text form', () => {
    threadMap.setThreadId(SESSION_ID, THREAD_ID);
    const row = db
      .select({ createdAt: codexThreads.createdAt })
      .from(codexThreads)
      .where(eq(codexThreads.sessionId, SESSION_ID))
      .get();
    expect(row).toBeDefined();
    expect(new Date(row!.createdAt).toISOString()).toBe(row!.createdAt);
  });

  it('never writes to session_metadata', () => {
    threadMap.setThreadId(SESSION_ID, THREAD_ID);
    const rows = db.$client.prepare('SELECT COUNT(*) AS n FROM session_metadata').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  describe('durable display metadata', () => {
    it('setThreadId persists initial metadata captured at bind time', () => {
      threadMap.setThreadId(SESSION_ID, THREAD_ID, '/projects/demo', {
        title: 'Fix the flaky test',
        updatedAt: '2026-07-05T10:00:00.000Z',
        lastMessagePreview: 'Fix the flaky test',
      });

      expect(threadMap.get(SESSION_ID)).toEqual({
        threadId: THREAD_ID,
        cwd: '/projects/demo',
        title: 'Fix the flaky test',
        updatedAt: '2026-07-05T10:00:00.000Z',
        lastMessagePreview: 'Fix the flaky test',
      });
    });

    it('updateMetadata updates an existing row', () => {
      threadMap.setThreadId(SESSION_ID, THREAD_ID, '/projects/demo');

      threadMap.updateMetadata(SESSION_ID, {
        title: 'Renamed session',
        updatedAt: '2026-07-05T11:00:00.000Z',
        lastMessagePreview: 'latest message',
      });

      expect(threadMap.get(SESSION_ID)).toMatchObject({
        threadId: THREAD_ID,
        title: 'Renamed session',
        updatedAt: '2026-07-05T11:00:00.000Z',
        lastMessagePreview: 'latest message',
      });
    });

    it('updateMetadata leaves omitted fields untouched (partial patch)', () => {
      threadMap.setThreadId(SESSION_ID, THREAD_ID, undefined, {
        title: 'Original title',
        lastMessagePreview: 'first message',
      });

      threadMap.updateMetadata(SESSION_ID, { updatedAt: '2026-07-05T12:00:00.000Z' });

      expect(threadMap.get(SESSION_ID)).toMatchObject({
        title: 'Original title',
        updatedAt: '2026-07-05T12:00:00.000Z',
        lastMessagePreview: 'first message',
      });
    });

    it('updateMetadata is a no-op when the row does not exist yet', () => {
      expect(() =>
        threadMap.updateMetadata('never-bound-session', { title: 'ghost' })
      ).not.toThrow();
      expect(threadMap.get('never-bound-session')).toBeUndefined();
      expect(threadMap.listAll()).toEqual([]);
    });

    it('listAll returns every persisted record for hydration', () => {
      const otherSessionId = '22222222-2222-4222-8222-222222222222';
      threadMap.setThreadId(SESSION_ID, THREAD_ID, '/projects/demo', {
        title: 'First session',
        updatedAt: '2026-07-05T10:00:00.000Z',
        lastMessagePreview: 'hello',
      });
      threadMap.setThreadId(otherSessionId, 'thread_other456');

      const records = threadMap.listAll();

      expect(records).toHaveLength(2);
      expect(records.find((r) => r.sessionId === SESSION_ID)).toMatchObject({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        cwd: '/projects/demo',
        title: 'First session',
        updatedAt: '2026-07-05T10:00:00.000Z',
        lastMessagePreview: 'hello',
      });
      const other = records.find((r) => r.sessionId === otherSessionId)!;
      expect(other.threadId).toBe('thread_other456');
      expect(typeof other.createdAt).toBe('string');
    });

    it('parses legacy rows with NULL metadata columns (backward compat)', () => {
      // A pre-migration row: only the original binding columns are populated.
      db.$client
        .prepare('INSERT INTO codex_threads (session_id, thread_id, created_at) VALUES (?, ?, ?)')
        .run(SESSION_ID, THREAD_ID, '2026-01-01T00:00:00.000Z');

      expect(threadMap.get(SESSION_ID)).toEqual({
        threadId: THREAD_ID,
        cwd: undefined,
        title: undefined,
        updatedAt: undefined,
        lastMessagePreview: undefined,
      });
      expect(threadMap.listAll()).toEqual([
        {
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          cwd: undefined,
          createdAt: '2026-01-01T00:00:00.000Z',
          title: undefined,
          updatedAt: undefined,
          lastMessagePreview: undefined,
        },
      ]);
    });
  });
});
