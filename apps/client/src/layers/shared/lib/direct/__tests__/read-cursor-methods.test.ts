// @vitest-environment jsdom
/**
 * Read state in the embed, where there is no DorkOS server to hold it.
 *
 * The contract under test is the one the unread rule depends on and is blind to
 * the storage behind: never-read answers `null`, a write comes back as the
 * position that now stands, and the position only ever moves forward.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { createLocalReadCursorMethods } from '../read-cursor-methods';

const { getReadCursor, setReadCursor } = createLocalReadCursorMethods();

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLocalReadCursorMethods', () => {
  it('answers null for a thread nobody has read here', async () => {
    expect(await getReadCursor('session', 's-1')).toBeNull();
  });

  it('reads back what it wrote', async () => {
    const written = await setReadCursor('session', 's-1', 4);

    expect(written.lastReadSeq).toBe(4);
    expect(written.threadKind).toBe('session');
    expect(written.threadId).toBe('s-1');
    expect((await getReadCursor('session', 's-1'))?.lastReadSeq).toBe(4);
  });

  it('refuses to move backwards, answering with what still stands', async () => {
    await setReadCursor('session', 's-1', 9);

    const refused = await setReadCursor('session', 's-1', 2);

    expect(refused.lastReadSeq).toBe(9);
    expect((await getReadCursor('session', 's-1'))?.lastReadSeq).toBe(9);
  });

  it('keeps kinds and threads apart', async () => {
    await setReadCursor('session', 'thing-1', 5);

    expect(await getReadCursor('room', 'thing-1')).toBeNull();
    expect(await getReadCursor('session', 'thing-2')).toBeNull();
  });

  it('stores a zero as a real position rather than as never-read', async () => {
    await setReadCursor('session', 's-zero', 0);

    expect((await getReadCursor('session', 's-zero'))?.lastReadSeq).toBe(0);
  });

  it('survives a browser that refuses to store at all', async () => {
    // A host with storage disabled throws on write. The rule is a nicety, so it
    // degrades to "not remembered" rather than to a rejected promise the caller
    // would treat as a refusal and stop writing over.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    await expect(setReadCursor('session', 's-1', 3)).resolves.toMatchObject({ lastReadSeq: 3 });
  });

  it('treats an unparseable stored value as never-read', async () => {
    window.localStorage.setItem('dorkos:read-cursor:session:s-1', 'not-a-number');

    expect(await getReadCursor('session', 's-1')).toBeNull();
  });
});
