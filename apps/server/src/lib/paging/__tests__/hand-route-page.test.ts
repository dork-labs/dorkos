import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { answerPage } from '../hand-route-page.js';

const rows = ['a', 'b', 'c'].map((id) => ({ id, at: '2026-01-01T00:00:00.000Z' }));

/** A list a person and an agent read alike, but each with its own cursors. */
const app = new Hono().get('/list', (c) =>
  answerPage(c, {
    list: `list:${c.req.header('x-reader') ?? 'person'}`,
    noun: 'things',
    read: () => rows,
    keyOf: (row) => [row.at, row.id],
    show: (row) => row.id,
  })
);

const get = async (query: string, reader?: string) => {
  const res = await app.request(`/list${query}`, reader ? { headers: { 'x-reader': reader } } : {});
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('answerPage', () => {
  it('answers each page in the one shape and ends with a null cursor', async () => {
    const first = await get('?limit=2');
    expect(first.body).toEqual({ things: ['c', 'b'], nextCursor: expect.any(String) });
    const rest = await get(`?limit=2&cursor=${first.body.nextCursor as string}`);
    expect(rest.body).toEqual({ things: ['a'], nextCursor: null });
  });

  it('refuses a cursor another kind of reader was given, never answering page one', async () => {
    const mine = (await get('?limit=1')).body.nextCursor as string;
    const theirs = await get(`?cursor=${mine}`, 'agent');
    expect(theirs.status).toBe(400);
    expect(theirs.body).toMatchObject({ code: 'invalid_request' });
  });

  it('refuses a field the list does not page by, and a limit out of range', async () => {
    expect((await get('?state=open')).status).toBe(400);
    expect((await get('?limit=201')).status).toBe(400);
  });
});
