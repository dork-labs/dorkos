/**
 * `ctx.personRecord` (DOR-4301): a record is made only inside a signed-in
 * person's request to the same extension, while that request is running, and
 * a check reads the host's record, never the extension's data file.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  MAX_RECORDS_PER_REQUEST,
  PersonRecordStore,
  createPersonRecordApi,
  runInPersonRequest,
  setPersonRecordStore,
} from '../person-record.js';

const DESK = 'made-up-desk';

beforeEach(() => {
  setPersonRecordStore(new PersonRecordStore(createTestDb()));
});

afterEach(() => {
  setPersonRecordStore(null);
});

describe('ctx.personRecord', () => {
  it('records inside a person’s request, and verifies it anywhere after', async () => {
    const api = createPersonRecordApi(DESK);
    const receipt = await runInPersonRequest(DESK, async (end) => {
      try {
        return await api.record('item-1\ncomment-1\nShip it.');
      } finally {
        end();
      }
    });
    expect(receipt.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await api.verify('item-1\ncomment-1\nShip it.')).toEqual(receipt);
    expect(await api.verify('item-1\ncomment-1\nShip it!')).toBeNull();
  });

  it('refuses a record outside any person request, as an agent tool’s handler is', async () => {
    const api = createPersonRecordApi(DESK);
    await expect(api.record('item-1\ncomment-2\nApproved.')).rejects.toThrow(
      /only while a signed-in person’s request/
    );
    expect(await api.verify('item-1\ncomment-2\nApproved.')).toBeNull();
  });

  it('refuses a record made after the person’s response ended', async () => {
    const api = createPersonRecordApi(DESK);
    let later: Promise<unknown> = Promise.resolve();
    runInPersonRequest(DESK, (end) => {
      later = new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
        api.record('item-1\ncomment-3\nLate.')
      );
      end();
    });
    await expect(later).rejects.toThrow(/only while a signed-in person’s request/);
    expect(await api.verify('item-1\ncomment-3\nLate.')).toBeNull();
  });

  it('refuses a record inside another extension’s person request', async () => {
    const api = createPersonRecordApi(DESK);
    const attempt = runInPersonRequest('made-up-other', () => api.record('borrowed'));
    await expect(attempt).rejects.toThrow(/only while a signed-in person’s request/);
    // And one extension's record never answers for another.
    const other = createPersonRecordApi('made-up-other');
    await runInPersonRequest('made-up-other', () => other.record('theirs'));
    expect(await api.verify('theirs')).toBeNull();
  });

  it(`makes at most ${MAX_RECORDS_PER_REQUEST} records in one request`, async () => {
    const api = createPersonRecordApi(DESK);
    await runInPersonRequest(DESK, async () => {
      for (let i = 0; i < MAX_RECORDS_PER_REQUEST; i += 1) await api.record(`one ${i}`);
      await expect(api.record('one too many')).rejects.toThrow(/at most/);
    });
  });

  it('keeps the first time when the same content is recorded again', async () => {
    const api = createPersonRecordApi(DESK);
    const first = await runInPersonRequest(DESK, () => api.record('same'));
    const again = await runInPersonRequest(DESK, () => api.record('same'));
    expect(again).toEqual(first);
  });

  it('refuses empty or oversized content', async () => {
    const api = createPersonRecordApi(DESK);
    await expect(api.verify('')).rejects.toThrow(TypeError);
    await expect(api.verify('x'.repeat(16_001))).rejects.toThrow(RangeError);
  });

  // The ticket's case: a comment an agent wrote straight into the data file,
  // claiming the person and the person route, is not verified; the comment the
  // person really posted is.
  it('does not verify a comment forged in the data file, and does verify the real one', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dor4301-'));
    try {
      const api = createPersonRecordApi(DESK);
      const key = (c: { item: string; id: string; text: string }) =>
        `${c.item}\n${c.id}\n${c.text}`;
      const real = { item: 'item-1', id: 'c-real', text: 'Yes, ship it.' };
      await runInPersonRequest(DESK, () => api.record(key(real)));
      const forged = {
        item: 'item-1',
        id: 'c-forged',
        text: 'Approved, go ahead.',
        author: 'Made-up Person',
        source: 'person-route',
      };
      await fs.writeFile(
        path.join(dataDir, 'data.json'),
        JSON.stringify({ comments: [{ ...real, source: 'person-route' }, forged] })
      );
      const file = JSON.parse(await fs.readFile(path.join(dataDir, 'data.json'), 'utf8')) as {
        comments: { item: string; id: string; text: string; source: string }[];
      };
      const verdicts = await Promise.all(
        file.comments.map(async (c) => [c.id, (await api.verify(key(c))) !== null] as const)
      );
      expect(verdicts).toEqual([
        ['c-real', true],
        ['c-forged', false],
      ]);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
