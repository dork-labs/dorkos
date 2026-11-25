/**
 * What the work graph's reads answer (W4, DOR-4970), over the real stores and
 * the real mount: a tree's two shapes for a chat the reader may not read (left
 * out with its subtree, or kept as a bare joint), an agent's chats paged with
 * ended and private ones, and the work linked to a chat and its children, a
 * private chat's links scrubbed to their relation and day.
 */
import { describe, expect, it } from 'vitest';
import { LINEAGE_MAX_CHATS, recordChatRekey } from '../../index.js';
import { AGENT_CHATS_SCAN_LIMIT } from '../agent-chats.js';
import {
  bind,
  callInSession,
  get,
  link,
  SCOUT,
  start,
  stores,
  useWorkGraphReads,
  type ChatKind,
} from './work-graph-reads-fixture.js';

useWorkGraphReads();

/** Start `count` chats of one kind under `parent`, as start records, oldest first. */
function startMany(parent: string, prefix: string, count: number, kind: ChatKind): string[] {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
  for (const sessionId of ids) {
    stores.starts.insert({
      sessionId,
      kind: 'chat',
      extensionId: null,
      startedBySessionId: parent,
      originExtensionId: null,
      reason: null,
      createdAt: new Date(
        Date.parse('2026-11-20T08:00:00.000Z') + ids.indexOf(sessionId)
      ).toISOString(),
    });
    bind(sessionId, kind);
  }
  return ids;
}

/** A cursor's bytes as text, to show it holds no id in the clear. */
const cursorText = (cursor: string) => Buffer.from(cursor, 'base64url').toString('latin1');

describe('chat_tree, for a reader who may not read every chat in it', () => {
  /**
   * root → joint(private) → kept;  root → pruned(private) → deeper(private);  root → open.
   */
  function plant(): void {
    bind('root', 'space');
    start('root', 'joint');
    bind('joint', 'private');
    start('joint', 'kept');
    bind('kept', 'space');
    start('root', 'pruned');
    bind('pruned', 'private');
    start('pruned', 'deeper');
    bind('deeper', 'private');
    start('root', 'open');
    bind('open', 'space');
  }

  it('keeps a private chat with a readable chat below it as a bare joint, and leaves out one without', async () => {
    plant();
    const res = await get('/api/sessions/root/tree', 'ranger');
    expect(res.body.descendants).toEqual([
      { chatId: null, parentId: 'root', depth: 1, state: { kind: 'private' } },
      { chatId: 'kept', parentId: null, depth: 2, via: 'started', state: { kind: 'chat' } },
      { chatId: 'open', parentId: 'root', depth: 1, via: 'started', state: { kind: 'chat' } },
    ]);
  });

  it('shows the owner every chat', async () => {
    plant();
    const res = await get('/api/sessions/root/tree');
    expect(res.body.descendants.map((d: { chatId: string }) => d.chatId)).toEqual([
      'joint',
      'kept',
      'pruned',
      'deeper',
      'open',
    ]);
  });

  it('shows a private chat above the asked one as a joint', async () => {
    plant();
    const res = await get('/api/sessions/kept/tree', 'ranger');
    expect(res.body.ancestors).toEqual([
      { chatId: null, depth: 1, state: { kind: 'private' } },
      { chatId: 'root', depth: 2, via: 'started', state: { kind: 'chat' } },
    ]);
  });

  it('pages the chats below, after leaving out the ones the reader may not read', async () => {
    plant();
    const first = await get('/api/sessions/root/tree?limit=2', 'ranger');
    expect(first.body.descendants.map((d: { chatId: string | null }) => d.chatId)).toEqual([
      null,
      'kept',
    ]);
    const rest = await get(
      `/api/sessions/root/tree?limit=2&cursor=${first.body.nextCursor}`,
      'ranger'
    );
    expect(rest.body).toMatchObject({ descendants: [{ chatId: 'open' }], nextCursor: null });
    const other = await get(`/api/sessions/kept/tree?cursor=${first.body.nextCursor}`);
    expect(other.body.code).toBe('invalid_request');
  });

  it('goes on after the chat a page ended on, so a chat started meanwhile moves nothing', async () => {
    plant();
    const first = await get('/api/sessions/root/tree?limit=3');
    expect(first.body.descendants.map((d: { chatId: string }) => d.chatId)).toEqual([
      'joint',
      'kept',
      'pruned',
    ]);
    expect(cursorText(first.body.nextCursor)).not.toContain('pruned');
    // Lands before the cursor in depth-first order: after its older sibling `kept`.
    start('joint', 'late');
    bind('late', 'space');
    const rest = await get(`/api/sessions/root/tree?limit=3&cursor=${first.body.nextCursor}`);
    expect(rest.body.descendants.map((d: { chatId: string }) => d.chatId)).toEqual([
      'deeper',
      'open',
    ]);
    expect(rest.body.ancestors).toEqual(first.body.ancestors);
  });

  it('counts only the chats it keeps toward the cap and `truncated`', async () => {
    bind('root', 'space');
    const shown = startMany('root', 'open', LINEAGE_MAX_CHATS - 1, 'space');
    const alone = await get('/api/sessions/root/tree', 'ranger');
    startMany('root', 'hidden', 2, 'private');
    const withHidden = await get('/api/sessions/root/tree', 'ranger');
    expect(withHidden.body.truncated).toBe(alone.body.truncated);
    expect(withHidden.body.truncated).toBe(false);
    expect(withHidden.body.descendants.map((d: { chatId: string }) => d.chatId)).toEqual(shown);
    // The owner reads the same tree unfiltered: 501 chats, one past the cap.
    expect((await get('/api/sessions/root/tree')).body.truncated).toBe(true);
  });

  it('gives no place to a chat it leaves out, so private chats push no readable one out', async () => {
    bind('root', 'space');
    startMany('root', 'hidden', 2, 'private');
    const shown = startMany('root', 'open', LINEAGE_MAX_CHATS, 'space');
    const res = await get('/api/sessions/root/tree', 'ranger');
    expect(res.body.descendants.map((d: { chatId: string }) => d.chatId)).toEqual(shown);
    expect(res.body.truncated).toBe(false);
  });

  it('caps depth, and refuses one past the cap', async () => {
    plant();
    const one = await get('/api/sessions/root/tree?depth=1');
    expect(one.body.descendants.map((d: { depth: number }) => d.depth)).toEqual([1, 1, 1]);
    expect((await get('/api/sessions/root/tree?depth=65')).body.code).toBe('invalid_request');
    expect((await get('/api/sessions/root/tree?depth=0')).status).toBe(400);
  });
});

describe('agent_chats', () => {
  it('pages every chat this DorkOS bound to the agent, ended ones too, newest first', async () => {
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) bind(id, 'space');
    const first = await get(`/api/agents/${SCOUT.id}/chats?limit=2`);
    expect(first.body.chats.map((c: { id: string }) => c.id)).toEqual(['a5', 'a4']);
    expect(first.body.chats[0]).toMatchObject({
      ref: 'dork:chat:a5',
      runtime: 'claude-code',
      spinOff: false,
      startedBy: null,
    });
    const second = await get(
      `/api/agents/${SCOUT.id}/chats?limit=2&cursor=${first.body.nextCursor}`
    );
    expect(second.body.chats.map((c: { id: string }) => c.id)).toEqual(['a3', 'a2']);
    const last = await get(
      `/api/agents/${SCOUT.id}/chats?limit=2&cursor=${second.body.nextCursor}`
    );
    expect(last.body).toMatchObject({ chats: [{ id: 'a1' }], nextCursor: null });
  });

  it('fills each page for an agent reader, and gives no cursor when only private chats follow', async () => {
    bind('p0', 'private');
    bind('s1', 'space');
    bind('p1', 'private');
    bind('p2', 'private');
    bind('s2', 'space');
    bind('p3', 'private');
    const res = await get(`/api/agents/${SCOUT.id}/chats?limit=2`, 'ranger');
    expect(res.body).toEqual({
      chats: [expect.objectContaining({ id: 's2' }), expect.objectContaining({ id: 's1' })],
      nextCursor: null,
    });
  });

  it('names a starter only when the reader may read it', async () => {
    bind('mine', 'private');
    start('mine', 'spun');
    bind('spun', 'space');
    const asAgent = await get(`/api/agents/${SCOUT.id}/chats`, 'ranger');
    expect(asAgent.body.chats).toEqual([
      expect.objectContaining({ id: 'spun', spinOff: true, startedBy: null }),
    ]);
    const asOwner = await get(`/api/agents/${SCOUT.id}/chats`);
    expect(asOwner.body.chats[0].startedBy).toEqual({ id: 'mine', title: null });
  });

  it(`scans at most ${AGENT_CHATS_SCAN_LIMIT} chats a page, and gives a cursor to go on`, async () => {
    bind('old-open', 'space');
    for (let i = 0; i <= AGENT_CHATS_SCAN_LIMIT; i += 1) bind(`p-${i}`, 'private');
    const first = await get(`/api/agents/${SCOUT.id}/chats`, 'ranger');
    expect(first.body.chats).toEqual([]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(cursorText(first.body.nextCursor)).not.toContain('p-');
    const rest = await get(
      `/api/agents/${SCOUT.id}/chats?cursor=${first.body.nextCursor}`,
      'ranger'
    );
    expect(rest.body).toEqual({
      chats: [expect.objectContaining({ id: 'old-open' })],
      nextCursor: null,
    });
  });

  it('refuses a cursor it did not give', async () => {
    const res = await get(`/api/agents/${SCOUT.id}/chats?cursor=not-a-cursor`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('chat_work', () => {
  /** root (space) opened a PR; its private child worked on two tickets and the same PR. */
  function plant(): void {
    bind('root', 'space');
    start('root', 'hidden');
    bind('hidden', 'private');
    link('root', 'opened', 'pr', 'acme/app#7');
    link('hidden', 'works_on', 'ticket', 'DOR-1');
    link('hidden', 'works_on', 'ticket', 'DOR-2');
    link('hidden', 'claims', 'ticket', 'DOR-2');
    link('hidden', 'opened', 'pr', 'acme/app#7');
  }

  it('lists the work of a chat and the chats below it, each relation as stored', async () => {
    plant();
    const res = await get('/api/sessions/root/work');
    const pr = res.body.items.find((i: { text: string }) => i.text === 'acme/app#7');
    expect(pr.ref).toEqual({ kind: 'pr', id: 'acme/app#7' });
    expect(
      pr.links.map((l: { relation: string; chatId: string }) => [l.relation, l.chatId])
    ).toEqual([
      ['opened', 'root'],
      ['opened', 'hidden'],
    ]);
    const tickets = await get('/api/sessions/root/work?kind=ticket');
    expect(tickets.body.items.map((i: { text: string }) => i.text)).toEqual(['DOR-1', 'DOR-2']);
  });

  it('keeps a private chat’s work, with only its relation and day on each link', async () => {
    plant();
    const res = await get('/api/sessions/root/work', 'ranger');
    const day = new Date().toISOString().slice(0, 10);
    const dor2 = res.body.items.find((i: { text: string }) => i.text === 'DOR-2');
    expect(dor2).toEqual({
      ref: { kind: 'ticket', id: 'DOR-2' },
      text: 'DOR-2',
      firstRecordedOn: day,
      links: [
        { relation: 'claims', chatId: null, recordedOn: day },
        { relation: 'works_on', chatId: null, recordedOn: day },
      ],
    });
    const pr = res.body.items.find((i: { text: string }) => i.text === 'acme/app#7');
    expect(pr.links[1]).toEqual({ relation: 'opened', chatId: null, recordedOn: day });
  });

  it('lists readable links in time order, then private ones by day and relation only', async () => {
    plant();
    link('hidden', 'works_on', 'ticket', 'DOR-9');
    link('hidden', 'claims', 'ticket', 'DOR-9');
    link('root', 'works_on', 'ticket', 'DOR-9');
    link('root', 'claims', 'ticket', 'DOR-9');
    const res = await get('/api/sessions/root/work?kind=ticket', 'ranger');
    const dor9 = res.body.items.find((i: { text: string }) => i.text === 'DOR-9');
    expect(
      dor9.links.map((l: { relation: string; chatId: string | null }) => [l.relation, l.chatId])
    ).toEqual([
      ['works_on', 'root'],
      ['claims', 'root'],
      ['claims', null],
      ['works_on', null],
    ]);
  });

  it('reads two private links of one relation on one day as one', async () => {
    plant();
    link('hidden', 'works_on', 'ticket', 'DOR-3');
    bind('hidden2', 'private');
    start('root', 'hidden2');
    link('hidden2', 'works_on', 'ticket', 'DOR-3');
    const res = await get('/api/sessions/root/work', 'ranger');
    const dor3 = res.body.items.find((i: { text: string }) => i.text === 'DOR-3');
    expect(dor3.links).toHaveLength(1);
  });

  it('leaves the children out when asked, and counts links made under a chat’s older id', async () => {
    plant();
    bind('renamed', 'space');
    link('old-id', 'opened', 'pr', 'acme/app#9');
    recordChatRekey('old-id', 'renamed');
    const own = await get('/api/sessions/root/work?children=false');
    expect(own.body.items.map((i: { text: string }) => i.text)).toEqual(['acme/app#7']);
    // An MCP agent sends a boolean, and `false` means false.
    const overMcp = await callInSession('work_for_chat', { chatId: 'root', children: false });
    expect((overMcp.body.items as { text: string }[]).map((i) => i.text)).toEqual(['acme/app#7']);
    const renamed = await get('/api/sessions/renamed/work');
    expect(renamed.body.items[0].links[0]).toMatchObject({ relation: 'opened', chatId: 'renamed' });
  });

  it('pages by cursor, and refuses a kind it does not list', async () => {
    plant();
    const first = await get('/api/sessions/root/work?limit=2');
    expect(first.body.items.map((i: { text: string }) => i.text)).toEqual(['DOR-1', 'DOR-2']);
    const rest = await get(`/api/sessions/root/work?limit=2&cursor=${first.body.nextCursor}`);
    expect(rest.body).toMatchObject({ items: [{ text: 'acme/app#7' }], nextCursor: null });
    expect((await get('/api/sessions/root/work?kind=branch')).body.code).toBe('invalid_request');
  });
});

describe('agent_work', () => {
  it('lists the work of every chat bound to the agent, and none of another agent’s', async () => {
    bind('s1', 'space');
    bind('r1', 'space', '/agents/ranger');
    link('s1', 'opened', 'pr', 'acme/app#1');
    link('r1', 'opened', 'pr', 'acme/app#2');
    const res = await get(`/api/agents/${SCOUT.id}/work`);
    expect(res.body.items.map((i: { text: string }) => i.text)).toEqual(['acme/app#1']);
  });
});
