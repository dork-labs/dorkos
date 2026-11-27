/**
 * The work graph reads' page cursors (W4, DOR-4970; Security and the API lead
 * on round 3): each is bound to the reader it was given to, is one fixed size
 * whatever page it ends, and is refused before decryption when too short; and
 * a tree page goes on from where its last chat was when that chat is gone
 * from the next read (deleted, re-keyed or no longer readable), neither
 * starting over nor failing. Over the real stores and the real mount.
 */
import { describe, expect, it } from 'vitest';
import { eq, sessionMetadata } from '@dorkos/db';
import { recordChatRekey } from '../../index.js';
import { cursorLayout } from '../../../../lib/paging/sealed-cursor.js';
import {
  bind,
  get,
  link,
  SCOUT,
  start,
  stores,
  useWorkGraphReads,
  type Reader,
} from './work-graph-reads-fixture.js';

useWorkGraphReads();

/** Space chats under Scout, a tree and linked work, so every read has a second page. */
function plant(): void {
  bind('root', 'space');
  for (const id of ['a', 'b', 'c']) {
    start('root', id);
    bind(id, 'space');
    link(id, 'opened', 'pr', `acme/app#${id.charCodeAt(0)}`);
  }
}

/** Each read's first page of one, and the URL of the page after a cursor. */
const READS = {
  agent_chats: (cursor?: string) =>
    `/api/agents/${SCOUT.id}/chats?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
  chat_tree: (cursor?: string) =>
    `/api/sessions/root/tree?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
  chat_work: (cursor?: string) =>
    `/api/sessions/root/work?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
} as const;

describe.each(Object.entries(READS))('%s’s cursor', (_name, url) => {
  it.each<[Reader, Reader]>([
    ['owner', 'scout'],
    ['scout', 'ranger'],
  ])(
    'given to %s is refused for %s, and goes on for the reader it was given to',
    async (got, replays) => {
      plant();
      const first = await get(url(), got);
      const cursor = first.body.nextCursor as string;
      expect(cursor).toEqual(expect.any(String));
      const replayed = await get(url(cursor), replays);
      expect(replayed.status).toBe(400);
      expect(replayed.body.code).toBe('invalid_request');
      expect((await get(url(cursor), got)).status).toBe(200);
    }
  );

  it('is one length whatever page it ends', async () => {
    plant();
    const first = await get(url());
    const second = await get(url(first.body.nextCursor));
    expect(second.body.nextCursor.length).toBe(first.body.nextCursor.length);
  });
});

describe('a cursor too short to hold an IV and a tag', () => {
  it('is refused before anything is decrypted', async () => {
    expect(cursorLayout(Buffer.alloc(27))).toBeNull();
    expect(cursorLayout(Buffer.alloc(28))).toMatchObject({ body: Buffer.alloc(0) });
    const res = await get(`/api/agents/${SCOUT.id}/chats?cursor=AAAA`);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('a tree page whose last chat is gone from the next read', () => {
  /** root → a → a1, a2;  root → b.  Ranger's first page of two ends on `a1`. */
  async function firstPage(): Promise<string> {
    bind('root', 'space');
    start('root', 'a');
    bind('a', 'space');
    start('a', 'a1');
    bind('a1', 'space');
    start('a', 'a2');
    bind('a2', 'space');
    start('root', 'b');
    bind('b', 'space');
    const first = await get('/api/sessions/root/tree?limit=2', 'ranger');
    expect(first.body.descendants.map((d: { chatId: string }) => d.chatId)).toEqual(['a', 'a1']);
    return first.body.nextCursor;
  }

  const next = async (cursor: string) =>
    (await get(`/api/sessions/root/tree?limit=2&cursor=${cursor}`, 'ranger')).body.descendants.map(
      (d: { chatId: string }) => d.chatId
    );

  it('goes on after it when it was deleted', async () => {
    const cursor = await firstPage();
    stores.db.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, 'a1')).run();
    expect(await next(cursor)).toEqual(['a2', 'b']);
  });

  it('goes on after it when it was re-keyed', async () => {
    const cursor = await firstPage();
    // As the durable re-key does: the edge, and the binding and start row moved to the new id.
    recordChatRekey('a1', 'a1-renamed');
    stores.db
      .update(sessionMetadata)
      .set({ sessionId: 'a1-renamed' })
      .where(eq(sessionMetadata.sessionId, 'a1'))
      .run();
    stores.starts.move('a1', 'a1-renamed');
    const tree = await get('/api/sessions/root/tree', 'ranger');
    expect(tree.body.descendants.map((d: { chatId: string }) => d.chatId)).toContain('a1-renamed');
    expect(await next(cursor)).toEqual(['a2', 'b']);
  });

  it('goes on after it when the reader may no longer read it', async () => {
    const cursor = await firstPage();
    stores.db
      .update(sessionMetadata)
      .set({ launchOrigin: 'interactive' })
      .where(eq(sessionMetadata.sessionId, 'a1'))
      .run();
    expect(await next(cursor)).toEqual(['a2', 'b']);
  });

  it('goes on after the chat above it when that one is gone too', async () => {
    const cursor = await firstPage();
    for (const id of ['a', 'a1', 'a2']) {
      stores.db.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).run();
    }
    expect(await next(cursor)).toEqual(['b']);
  });
});
