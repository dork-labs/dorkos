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
});
