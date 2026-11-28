/** The read-cursor calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answer, firstRequest } from './request-stub';
import { createReadCursorMethods } from '../read-cursor-methods';

afterEach(() => vi.unstubAllGlobals());

describe('createReadCursorMethods', () => {
  const methods = createReadCursorMethods('/api');

  it('reads a thread’s cursor at its encoded id and unwraps a missing one to null', async () => {
    const fetchMock = answer({ cursor: null });
    await expect(methods.getReadCursor('room', 'r 1')).resolves.toBeNull();
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/read-cursors/room/r%201',
      method: 'GET',
      body: undefined,
    });
  });

  it('puts the last read seq', async () => {
    const fetchMock = answer({ lastReadSeq: 7 });
    await methods.setReadCursor('room', 'r/1', 7);
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/read-cursors/room/r%2F1',
      method: 'PUT',
      body: '{"lastReadSeq":7}',
    });
  });
});
