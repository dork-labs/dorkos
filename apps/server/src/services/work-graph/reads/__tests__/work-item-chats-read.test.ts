/**
 * `work-graph.work_item_chats` (DOR-4972): who worked on a ticket, and when,
 * through the real mount and both MCP servers, with the claims written by the
 * real claim service through the real recorder. One row for each of
 * Security's rules: a private span keeps only its relation and days; a caller
 * nobody named never reads as the owner, whatever user id it carries; two
 * private spans on the same days read as one, with no count; and a span handed
 * over to a chat the reader may not read ends on the day, naming no one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkClaimService } from '../../../session/claims/work-claim-service.js';
import { recordChatClaim } from '../../index.js';
import {
  bind,
  callInSession,
  get,
  getWith,
  invoke,
  RANGER,
  SCOUT,
  stores,
  useWorkGraphReads,
} from './work-graph-reads-fixture.js';

useWorkGraphReads();

/** A third agent's id: claims are per agent, so three agents' chats can claim one ticket. */
const OTHER_ID = '01JOTHERAGENT0000000000000';

let now: number;
let claims: WorkClaimService;

beforeEach(() => {
  now = Date.parse('2026-11-26T09:00:00.000Z');
  claims = new WorkClaimService({ db: stores.db, now: () => now, recordChange: recordChatClaim });
});

/** One minute on. */
function later(minutes = 1): void {
  now += minutes * 60_000;
}

/** A space chat that claimed and released DOR-1, then a private chat that still holds it. */
function plant(): void {
  bind('c-space', 'space');
  bind('c-private', 'private');
  claims.claim(SCOUT.id, 'c-space', 'DOR-1');
  later();
  claims.release(SCOUT.id, 'c-space', 'DOR-1');
  later();
  claims.claim(SCOUT.id, 'c-private', 'DOR-1');
}

const DAY = '2026-11-26';

const SPACE_SPAN = {
  relation: 'claims',
  chatId: 'c-space',
  claimedAt: '2026-11-26T09:00:00.000Z',
  startDay: DAY,
  endedAt: '2026-11-26T09:01:00.000Z',
  endDay: DAY,
  endedBy: 'released',
};

const PRIVATE_SPAN = { relation: 'claims', startDay: '2026-11-26', endDay: null };

describe('who worked on a ticket', () => {
  it('answers the owner with every span, chat and time', async () => {
    plant();
    const res = await get('/api/work-items/chats?ref=DOR-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ref: { kind: 'ticket', id: 'DOR-1' },
      spans: [
        SPACE_SPAN,
        {
          relation: 'claims',
          chatId: 'c-private',
          claimedAt: '2026-11-26T09:02:00.000Z',
          startDay: DAY,
          endedAt: null,
          endDay: null,
          endedBy: null,
        },
      ],
      nextCursor: null,
    });
  });

  it('reads a ref as people write it', async () => {
    plant();
    expect((await get('/api/work-items/chats?ref=dor-1')).body.spans).toHaveLength(2);
  });

  it('answers an agent with a private chat’s span as its relation and days only', async () => {
    plant();
    const res = await get('/api/work-items/chats?ref=DOR-1', 'ranger');
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
    expect(Object.keys(res.body.spans[1]).sort()).toEqual(['endDay', 'relation', 'startDay']);
  });

  it('reads two private spans on the same days as one, with no count', async () => {
    bind('c-private', 'private');
    bind('c-private-2', 'private');
    claims.claim(SCOUT.id, 'c-private', 'DOR-1');
    later();
    claims.claim(RANGER.id, 'c-private-2', 'DOR-1');
    const res = await get('/api/work-items/chats?ref=DOR-1', 'ranger');
    expect(res.body.spans).toEqual([PRIVATE_SPAN]);
    expect(JSON.stringify(res.body)).not.toMatch(/count/i);
  });

  it('reads private spans with the same days as one row, ordered by days and never by time', async () => {
    for (const chat of ['p-1', 'p-2', 'p-3']) bind(chat, 'private');
    // Two closed on the same day, a minute apart; one still open.
    claims.claim(SCOUT.id, 'p-1', 'DOR-1');
    claims.claim(RANGER.id, 'p-2', 'DOR-1');
    claims.claim(OTHER_ID, 'p-3', 'DOR-1');
    later();
    claims.release(RANGER.id, 'p-2', 'DOR-1');
    later();
    claims.release(SCOUT.id, 'p-1', 'DOR-1');
    const res = await get('/api/work-items/chats?ref=DOR-1', 'ranger');
    expect(res.body.spans).toEqual([
      { relation: 'claims', startDay: DAY, endDay: DAY },
      PRIVATE_SPAN,
    ]);
  });

  it('answers a valid ref nobody claimed with no spans, never not found', async () => {
    const res = await get('/api/work-items/chats?ref=DOR-999');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ref: { kind: 'ticket', id: 'DOR-999' },
      spans: [],
      nextCursor: null,
    });
  });

  it('refuses a ref that is not a ticket or a pull request, naming the field', async () => {
    for (const ref of ['checkout-ff', 'dork:chat:c-space', '']) {
      const res = await get(`/api/work-items/chats?ref=${encodeURIComponent(ref)}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(JSON.stringify(res.body)).toContain('ref');
    }
    expect((await get('/api/work-items/chats')).status).toBe(400);
  });
});

describe('a caller nobody named', () => {
  it('reads as the space over the external MCP server, never as the owner', async () => {
    plant();
    const { isError, body } = await callInSession('work_item_chats', { ref: 'DOR-1' }, 'external');
    expect(isError).toBe(false);
    expect(body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
  });

  it('reads as the space through `/invoke` with no key (`dorkos call`)', async () => {
    plant();
    const res = await invoke('work-graph.work_item_chats', { ref: 'DOR-1' });
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
  });

  it('reads as the space in session with no turn bound to the call', async () => {
    plant();
    const { body } = await callInSession('work_item_chats', { ref: 'DOR-1' });
    expect(body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
  });

  it('reads as the space for a program key with login on, though the key names a user', async () => {
    plant();
    const res = await get('/api/work-items/chats?ref=DOR-1', 'api-key');
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
  });

  it('reads as the space for a REST read with login off that presents an x-api-key', async () => {
    plant();
    const res = await getWith('/api/work-items/chats?ref=DOR-1', { 'x-api-key': 'a-program-key' });
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
  });

  it('reads as the space for a /mcp call carrying a user id', async () => {
    plant();
    const { body } = await callInSession('work_item_chats', { ref: 'DOR-1' }, 'external', {
      userId: 'owner-user',
      mcpServer: 'external',
    });
    expect(body.spans).toEqual([SPACE_SPAN, PRIVATE_SPAN]);
  });
});

describe('a hand-over', () => {
  it('ends a readable span on the day only, naming no one, when the taker is private', async () => {
    bind('c-space', 'space');
    bind('c-private', 'private');
    claims.claim(SCOUT.id, 'c-space', 'DOR-1');
    later(7);
    claims.handOver(SCOUT.id, 'DOR-1', 'c-space', 'c-private');
    const res = await get('/api/work-items/chats?ref=DOR-1', 'ranger');
    expect(res.body.spans).toEqual([
      {
        relation: 'claims',
        chatId: 'c-space',
        claimedAt: '2026-11-26T09:00:00.000Z',
        startDay: DAY,
        endedAt: null,
        endDay: DAY,
        endedBy: 'handed-over',
      },
      PRIVATE_SPAN,
    ]);
    // The owner reads the same span exactly.
    const owner = await get('/api/work-items/chats?ref=DOR-1');
    expect(owner.body.spans[0].endedAt).toBe('2026-11-26T09:07:00.000Z');
  });

  it('starts a readable span on the day only, naming no one, when the giver is private', async () => {
    bind('c-space', 'space');
    bind('c-private', 'private');
    claims.claim(SCOUT.id, 'c-private', 'DOR-1');
    later(7);
    claims.handOver(SCOUT.id, 'DOR-1', 'c-private', 'c-space');
    const res = await get('/api/work-items/chats?ref=DOR-1', 'ranger');
    expect(res.body.spans).toEqual([
      {
        relation: 'claims',
        chatId: 'c-space',
        claimedAt: null,
        startDay: DAY,
        endedAt: null,
        endDay: null,
        endedBy: null,
      },
      { relation: 'claims', startDay: DAY, endDay: DAY },
    ]);
  });

  it('shows the owner the exact time a chat took a claim from a private chat', async () => {
    bind('c-space', 'space');
    bind('c-private', 'private');
    claims.claim(SCOUT.id, 'c-private', 'DOR-1');
    later(7);
    claims.handOver(SCOUT.id, 'DOR-1', 'c-private', 'c-space');
    const owner = await get('/api/work-items/chats?ref=DOR-1');
    expect(owner.body.spans.find((span: { chatId: string }) => span.chatId === 'c-space')).toEqual(
      expect.objectContaining({ claimedAt: '2026-11-26T09:07:00.000Z', startDay: DAY })
    );
  });

  it('stays exact between two chats the reader may read', async () => {
    bind('c-space', 'space');
    bind('c-space-2', 'space');
    claims.claim(SCOUT.id, 'c-space', 'DOR-1');
    later(7);
    claims.handOver(SCOUT.id, 'DOR-1', 'c-space', 'c-space-2');
    const res = await get('/api/work-items/chats?ref=DOR-1', 'ranger');
    expect(res.body.spans).toEqual([
      {
        relation: 'claims',
        chatId: 'c-space',
        claimedAt: '2026-11-26T09:00:00.000Z',
        startDay: DAY,
        endedAt: '2026-11-26T09:07:00.000Z',
        endDay: DAY,
        endedBy: 'handed-over',
      },
      {
        relation: 'claims',
        chatId: 'c-space-2',
        claimedAt: '2026-11-26T09:07:00.000Z',
        startDay: DAY,
        endedAt: null,
        endDay: null,
        endedBy: null,
      },
    ]);
  });
});

describe('the work reads', () => {
  it('list a claim once, as `claims`, and never its end', async () => {
    plant();
    const res = await get(`/api/agents/${SCOUT.id}/work`);
    const item = res.body.items.find((entry: { text: string }) => entry.text === 'DOR-1');
    expect(item.links.map((link: { relation: string }) => link.relation)).toEqual([
      'claims',
      'claims',
    ]);
  });
});

describe('pages', () => {
  it('orders by claimedAt then chat, and goes on from its cursor', async () => {
    for (const chat of ['c-b', 'c-a', 'c-c']) bind(chat, 'space');
    claims.claim(SCOUT.id, 'c-b', 'DOR-1');
    claims.claim(RANGER.id, 'c-a', 'DOR-1');
    later();
    claims.claim(OTHER_ID, 'c-c', 'DOR-1');
    const first = await get('/api/work-items/chats?ref=DOR-1&limit=2');
    expect(first.body.spans.map((s: { chatId: string }) => s.chatId)).toEqual(['c-a', 'c-b']);
    const rest = await get(
      `/api/work-items/chats?ref=DOR-1&limit=2&cursor=${first.body.nextCursor}`
    );
    expect(rest.body.spans.map((s: { chatId: string }) => s.chatId)).toEqual(['c-c']);
    expect(rest.body.nextCursor).toBeNull();
    const replayed = await get(
      `/api/work-items/chats?ref=DOR-1&cursor=${first.body.nextCursor}`,
      'ranger'
    );
    expect(replayed.status).toBe(400);
  });
});
