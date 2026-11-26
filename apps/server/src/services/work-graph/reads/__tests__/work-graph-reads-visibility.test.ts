/**
 * Who may read what through the work graph's reads (W4, DOR-4970), as a
 * conformance table: every reader (the owner, a named agent, another agent,
 * an agent nobody could name, a program key the session gate verifies, and an
 * in-session MCP caller with no turn bound) against every kind of chat (an
 * agent's work, a person's own chat, a room chat with Scout its one agent
 * member), on all four reads, through the real mount, the real visibility
 * resolver and the real stores. The rule is the audit read side's (spec
 * `audit-trail` §3.4).
 */
import { describe, expect, it } from 'vitest';
import {
  bind,
  callInSession,
  get,
  link,
  RANGER,
  READERS,
  SCOUT,
  start,
  useWorkGraphReads,
  type ChatKind,
  type Reader,
} from './work-graph-reads-fixture.js';

useWorkGraphReads();

/** Whether `reader` may read a chat of `kind`: the expected answer for every row. */
function mayRead(reader: Reader, kind: ChatKind): boolean {
  if (reader === 'owner' || reader === 'api-key') return true;
  if (kind === 'space') return true;
  return kind === 'room' && reader === 'scout';
}

const KINDS: readonly ChatKind[] = ['space', 'private', 'room'];

/** One chat of each kind under Scout, each started by `root` and each linked to its own PR. */
function plant(): void {
  bind('root', 'space');
  for (const kind of KINDS) {
    start('root', `c-${kind}`);
    bind(`c-${kind}`, kind);
    link(`c-${kind}`, 'opened', 'pr', `acme/app#${KINDS.indexOf(kind) + 1}`);
  }
}

describe.each(READERS)('read as %s', (reader) => {
  it.each(KINDS)('agent_chats lists a %s chat only when the reader may read it', async (kind) => {
    plant();
    const res = await get(`/api/agents/${SCOUT.id}/chats`, reader);
    expect(res.status).toBe(200);
    const ids = res.body.chats.map((chat: { id: string }) => chat.id);
    expect(ids.includes(`c-${kind}`)).toBe(mayRead(reader, kind));
  });

  it.each(KINDS)(
    'chat_tree on a %s chat answers only when the reader may read it',
    async (kind) => {
      plant();
      const res = await get(`/api/sessions/c-${kind}/tree`, reader);
      if (mayRead(reader, kind)) {
        expect(res.status).toBe(200);
        expect(res.body.chatId).toBe(`c-${kind}`);
      } else {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('session_not_found');
      }
    }
  );

  it('chat_tree from the root shows each child only when readable', async () => {
    plant();
    const res = await get('/api/sessions/root/tree', reader);
    expect(res.status).toBe(200);
    const ids = res.body.descendants.map((d: { chatId: string | null }) => d.chatId);
    // A child with nothing below it that the reader may not read is left out, not a joint.
    expect(ids).toEqual(KINDS.filter((k) => mayRead(reader, k)).map((k) => `c-${k}`));
  });

  it.each(KINDS)(
    'chat_work on a %s chat answers only when the reader may read it',
    async (kind) => {
      plant();
      const res = await get(`/api/sessions/c-${kind}/work`, reader);
      expect(res.status).toBe(mayRead(reader, kind) ? 200 : 404);
    }
  );

  it.each(KINDS)('agent_work names a %s chat only when the reader may read it', async (kind) => {
    plant();
    const res = await get(`/api/agents/${SCOUT.id}/work`, reader);
    expect(res.status).toBe(200);
    const pr = `acme/app#${KINDS.indexOf(kind) + 1}`;
    const item = res.body.items.find((entry: { text: string }) => entry.text === pr);
    // The work itself is the space's to read; which chat did it is not.
    expect(item.links).toHaveLength(1);
    expect(item.links[0].chatId).toBe(mayRead(reader, kind) ? `c-${kind}` : null);
  });
});

describe('a key the session gate never issued', () => {
  it('is refused before any read', async () => {
    plant();
    for (const url of [`/api/agents/${SCOUT.id}/chats`, '/api/sessions/root/tree']) {
      expect((await get(url, 'bad-key')).status).toBe(401);
    }
  });
});

describe('read in session, with no turn bound to the call (an agent nobody could name)', () => {
  it('agent_chats leaves out a person’s own chat and a room chat', async () => {
    plant();
    const { body } = await callInSession('agent_chats', { agentId: SCOUT.id });
    expect((body.chats as { id: string }[]).map((c) => c.id).sort()).toEqual(['c-space', 'root']);
  });

  it('chat_tree and work_for_chat answer a private chat as one that does not exist', async () => {
    plant();
    for (const tool of ['chat_tree', 'work_for_chat']) {
      const hidden = await callInSession(tool, { chatId: 'c-private' });
      expect(hidden.isError).toBe(true);
      expect(JSON.stringify(hidden.body)).toContain('SESSION_NOT_FOUND');
    }
    expect((await callInSession('chat_tree', { chatId: 'c-space' })).isError).toBe(false);
  });

  it('work_for_agent keeps a private chat’s work and leaves the chat off', async () => {
    plant();
    const { body } = await callInSession('work_for_agent', { agentId: SCOUT.id });
    const item = (body.items as { text: string; links: { chatId: string | null }[] }[]).find(
      (entry) => entry.text === 'acme/app#2'
    );
    expect(item?.links).toEqual([expect.objectContaining({ chatId: null })]);
  });
});

describe('a chat the reader may not read, asked for by id', () => {
  it('answers exactly as a chat that does not exist', async () => {
    plant();
    const hidden = await get('/api/sessions/c-private/tree', 'ranger');
    const missing = await get('/api/sessions/no-such-chat/tree', 'ranger');
    expect(hidden.status).toBe(missing.status);
    expect(hidden.body).toEqual(missing.body);
  });
});

describe('ids and references', () => {
  it('takes a bare id or a dork: reference of the right kind, in the path', async () => {
    plant();
    expect((await get(`/api/agents/dork:agent:${SCOUT.id}/chats`)).status).toBe(200);
    expect((await get('/api/sessions/dork:chat:root/tree')).body.chatId).toBe('root');
    const wrongKind = await get('/api/sessions/dork:agent:root/tree');
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.code).toBe('invalid_request');
  });

  it('answers not_found for an agent nobody registered', async () => {
    const res = await get('/api/agents/01JNOBODY00000000000000000/chats');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect((await get(`/api/agents/${RANGER.id}/chats`)).body.chats).toEqual([]);
  });
});
