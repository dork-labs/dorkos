// @vitest-environment jsdom
/**
 * A failed task read throws (DOR-3154). It used to answer `{ tasks: [] }`,
 * which the task fold reads as "this session has no tasks" and wipes the list
 * on screen; throwing lets the query keep the last good list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionMethods } from '../session-methods';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('getTasks', () => {
  it('rejects when the server fails, never answers an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: () => Promise.resolve({ error: 'boom' }),
      })
    );
    const methods = createSessionMethods('http://x/api', () => 'c', new Map(), new Map());

    await expect(methods.getTasks('s1')).rejects.toBeTruthy();
  });

  it('returns the tasks the server sends', async () => {
    const tasks = [{ id: 't1', subject: 'Write it', status: 'pending' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ tasks }),
      })
    );
    const methods = createSessionMethods('http://x/api', () => 'c', new Map(), new Map());

    await expect(methods.getTasks('s1')).resolves.toEqual({ tasks });
  });
});
