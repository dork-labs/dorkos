import { describe, expect, it } from 'vitest';
import { MAX_ENTRY_PAGES, isEntryPostFor, readAllEntries, type EntryPage } from '../entries.js';

const ORIGIN = 'http://localhost:4242';
const ENTRIES = `${ORIGIN}/api/communities/c1/rooms/r1/entries`;

describe('two-Desktop channel history', () => {
  it('follows the cursor past the oldest page, so a long held channel still shows this run', async () => {
    // Catches the single `?limit=100` read that only ever saw the first 100 messages ever posted.
    const pages: Record<string, EntryPage<string>> = {
      first: { entries: ['run 1', 'run 2'], nextCursor: 'c2' },
      c2: { entries: ['run 3 newest'], nextCursor: null },
    };
    const asked: Array<string | undefined> = [];
    const all = await readAllEntries(async (cursor) => {
      asked.push(cursor);
      return pages[cursor ?? 'first']!;
    });
    expect(all).toEqual(['run 1', 'run 2', 'run 3 newest']);
    expect(asked).toEqual([undefined, 'c2']);
  });

  it('refuses a cursor that comes back again instead of looping forever', async () => {
    await expect(
      readAllEntries(async () => ({ entries: ['x'], nextCursor: 'same' }))
    ).rejects.toThrow(/repeated a cursor/);
  });

  it('gives up after the page ceiling', async () => {
    let n = 0;
    await expect(
      readAllEntries(async () => ({ entries: [], nextCursor: `c${n++}` }))
    ).rejects.toThrow(new RegExp(`${MAX_ENTRY_PAGES} pages`));
    expect(n).toBe(MAX_ENTRY_PAGES);
  });
});

describe('two-Desktop send confirmation', () => {
  const body = (text: string) => JSON.stringify({ text, idempotencyKey: 'k' });

  it('recognises the app posting this message to a channel or a thread', () => {
    expect(isEntryPostFor('POST', ENTRIES, body('hello abc'), 'hello abc')).toBe(true);
    // The composer trims what it sends.
    expect(isEntryPostFor('POST', ENTRIES, body('hello abc'), ' hello abc\n')).toBe(true);
  });

  it('ignores reads, other routes, other messages and bodies it cannot parse', () => {
    // Catches a send "confirmed" by an unrelated request, such as the history read or an upload.
    expect(isEntryPostFor('GET', ENTRIES, null, 'hello')).toBe(false);
    // A non-POST carrying the very same body still is not a send.
    expect(isEntryPostFor('GET', ENTRIES, body('hello'), 'hello')).toBe(false);
    expect(isEntryPostFor('PUT', ENTRIES, body('hello'), 'hello')).toBe(false);
    // A longer message that merely contains this one is a different send.
    expect(isEntryPostFor('POST', ENTRIES, body('hello abc'), 'hello')).toBe(false);
    expect(isEntryPostFor('POST', ENTRIES, body('hello'), 'hello abc')).toBe(false);
    expect(
      isEntryPostFor(
        'POST',
        `${ORIGIN}/api/communities/c1/rooms/r1/attachments`,
        body('hello'),
        'hello'
      )
    ).toBe(false);
    expect(isEntryPostFor('POST', `${ENTRIES}/x`, body('hello'), 'hello')).toBe(false);
    expect(isEntryPostFor('POST', ENTRIES, body('a different message'), 'hello')).toBe(false);
    expect(isEntryPostFor('POST', ENTRIES, 'not json', 'hello')).toBe(false);
    expect(isEntryPostFor('POST', ENTRIES, null, 'hello')).toBe(false);
  });
});
