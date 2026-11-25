/**
 * @vitest-environment node
 *
 * The relayed caller's adapter: which chats the session relay serves, what
 * a relayed send may carry, and how a new chat starts.
 */
import { describe, expect, it, vi } from 'vitest';
import { RelayResultBodySchemas } from '@dorkos/shared/session-relay';
import { RELAY_SERVED_FEATURES, RELAY_MAX_LIVE_NEW_CHATS } from '../../relay-request-server.js';
import type { RelaySessionFacts } from '../../relay-serves.js';
import {
  AGENT_ID,
  CHAT,
  NEW_CHAT,
  PROJECT,
  SYSTEM_ID,
  UNKNOWN_ID,
  facts,
  harness,
  row,
  sid,
} from './relay-request-server.fixtures.js';

describe('SessionRelayRequestServer', () => {
  it('with no passkey pinned, advertises everything but approvals and answers', () => {
    expect(harness().server.features()).toEqual(RELAY_SERVED_FEATURES);
    expect(RELAY_SERVED_FEATURES).not.toContain('interaction.approval');
    expect(RELAY_SERVED_FEATURES).not.toContain('interaction.question');
  });

  describe('which chats it serves', () => {
    const refused: [string, RelaySessionFacts][] = [
      ['a room turn', facts(CHAT, { ownedBy: { room: true, task: false, beat: false } })],
      ['a room by its row', facts(CHAT, { row: row(CHAT, { origin: 'room' }) })],
      ['a task run', facts(CHAT, { ownedBy: { room: false, task: true, beat: false } })],
      ['a scheduled run by launch', facts(CHAT, { launchOrigin: 'schedule' })],
      ['a heartbeat beat', facts(CHAT, { ownedBy: { room: false, task: false, beat: true } })],
      [
        'a beat chat by its label',
        facts(CHAT, { row: row(CHAT, { origin: 'agent', originLabel: 'Heartbeat' }) }),
      ],
      ['a bridged chat', facts(CHAT, { row: row(CHAT, { origin: 'channel' }) })],
      ['an outside sender', facts(CHAT, { launchOrigin: 'outside-sender' })],
      ['an unknown stored origin', facts(CHAT, { launchOrigin: 'something-new' })],
      ['no origin and no row', facts(CHAT, { launchOrigin: null, row: null })],
      ['a system agent', facts(CHAT, { cwd: '/home/me/.dork/agents/dorkbot', agentPath: null })],
      ['a folder no agent owns', facts(CHAT, { cwd: '/elsewhere', agentPath: null })],
      ['a folder outside the boundary', facts(CHAT, { cwd: null })],
      ['a different recorded agent', facts(CHAT, { agentPath: '/work/other' })],
      [
        'an unrecorded chat whose row only reads as agent-started',
        facts(CHAT, { launchOrigin: null, row: row(CHAT, { origin: 'agent' }) }),
      ],
    ];

    it.each(refused)('answers %s as not found, everywhere', async (_, chat) => {
      const h = harness({ chats: [chat] });
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      h.send('m', { op: 'session.send', sessionId: CHAT, content: 'hi' });
      h.send('i', { op: 'session.interrupt', sessionId: CHAT });
      h.send('q', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'answer', toolCallId: 't1', answers: { '0': 'yes' } },
      });
      h.send('l', { op: 'chats.list', agentId: AGENT_ID });
      await h.settle();
      const notFound = {
        status: 404,
        code: 'not_found',
        message: 'No such chat on this computer.',
      };
      expect(h.frames).toContainEqual({ type: 'stream.end', streamId: 'st', error: notFound });
      for (const id of ['m', 'i']) {
        expect(h.answerTo(id)).toEqual({ type: 'error', id, ok: false, error: notFound });
      }
      // Every relayed answer is refused, served chat or not, so this says nothing either.
      expect(h.answerTo('q')).toMatchObject({ ok: false, error: { code: 'refused' } });
      expect(h.answerTo('l')).toEqual({ type: 'result', id: 'l', ok: true, body: { chats: [] } });
      expect(h.dispatchSessionMessage).not.toHaveBeenCalled();
      expect(h.runtime.interruptQuery).not.toHaveBeenCalled();
      expect(h.runtime.submitAnswers).not.toHaveBeenCalled();
    });

    it('serves a person’s chat, one an agent started for them, and a CLI chat', async () => {
      const h = harness({
        chats: [
          facts(sid(1)),
          facts(sid(2), { launchOrigin: 'agent-launch', row: row(sid(2), { origin: 'agent' }) }),
          facts(sid(3), { launchOrigin: null, agentPath: null, cwd: `${PROJECT}/sub` }),
        ],
      });
      for (const n of [1, 2, 3]) h.send(`i${n}`, { op: 'session.interrupt', sessionId: sid(n) });
      await h.settle();
      for (const n of [1, 2, 3]) expect(h.answerTo(`i${n}`)).toMatchObject({ ok: true });
    });

    it('refuses an unknown or system agent for chats.list and a new chat', async () => {
      const h = harness({ chats: [] });
      h.send('a', { op: 'chats.list', agentId: SYSTEM_ID });
      h.send('b', { op: 'chats.list', agentId: UNKNOWN_ID });
      h.send('c', {
        op: 'session.send',
        sessionId: NEW_CHAT,
        content: 'hi',
        newChat: { agentId: SYSTEM_ID },
      });
      await h.settle();
      for (const id of ['a', 'b', 'c']) {
        expect(h.answerTo(id)).toMatchObject({
          ok: false,
          error: { status: 404, code: 'not_found' },
        });
      }
      expect(h.dispatchSessionMessage).not.toHaveBeenCalled();
    });
  });

  describe('chats.list', () => {
    it('lists the agent’s chats newest first, without paths, clipped to the schema', async () => {
      const long = 'x'.repeat(900);
      const h = harness({
        chats: [
          facts(sid(1), { row: row(sid(1), { updatedAt: '2026-10-01T00:00:00.000Z' }) }),
          facts(sid(2), {
            row: row(sid(2), {
              updatedAt: '2026-10-03T00:00:00.000Z',
              title: long,
              lastMessagePreview: long,
            }),
          }),
          facts(sid(3), { ownedBy: { room: true, task: false, beat: false } }),
          facts(sid(4), { row: null }),
        ],
      });
      h.send('l', { op: 'chats.list', agentId: AGENT_ID });
      await h.settle();
      const body = (h.answerTo('l') as { body: unknown }).body;
      const parsed = RelayResultBodySchemas['chats.list'].parse(body);
      expect(parsed.chats.map((c) => c.sessionId)).toEqual([sid(2), sid(1)]);
      expect(parsed.chats[0]!.title).toHaveLength(500);
      expect(parsed.chats[0]!.lastMessagePreview).toHaveLength(500);
      expect(JSON.stringify(body)).not.toContain(PROJECT);
    });
  });

  describe('session.send', () => {
    it('feeds an existing chat as session-relay, carrying nothing the caller named but words', async () => {
      const h = harness();
      h.send('m', {
        op: 'session.send',
        sessionId: CHAT,
        content: 'tidy up please',
        clientMessageId: 'c1',
        disposition: 'queue',
      });
      await h.settle();
      expect(h.answerTo('m')).toEqual({
        type: 'result',
        id: 'm',
        ok: true,
        body: { sessionId: CHAT },
      });
      const call = h.dispatchSessionMessage.mock.calls[0]![0];
      expect(call.origin).toEqual({ kind: 'session-relay' });
      expect(call.clientId).toBe('relay:test');
      // A relayed turn runs at the agent's own level (DOR-3440).
      expect(call.permissionCeiling).toBeUndefined();
      // The folder is the one this server placed the chat in, never the
      // caller's, and no disposition is passed on: the send path queues it.
      expect(call.request).toEqual({
        content: 'tidy up please',
        clientMessageId: 'c1',
        cwd: PROJECT,
      });
    });

    it.each(['stage', 'steer'] as const)(
      'refuses a %s, which would skip the turn ceiling',
      async (disposition) => {
        const h = harness();
        h.send('m', { op: 'session.send', sessionId: CHAT, content: 'hi', disposition });
        await h.settle();
        expect(h.answerTo('m')).toEqual({
          type: 'error',
          id: 'm',
          ok: false,
          error: {
            status: 400,
            code: 'invalid',
            message: 'Messages from the web wait their turn.',
          },
        });
        expect(h.dispatchSessionMessage).not.toHaveBeenCalled();
        expect(h.audits.at(-1)).toMatchObject({
          action: 'relay.session.send',
          outcome: 'refused',
        });
      }
    );

    it.each(['/compact please', '  /review', '/plugin:cmd arg', '/deploy'])(
      'refuses the slash command %j, whose allowed tools would skip the ask',
      async (content) => {
        const h = harness();
        h.send('m', { op: 'session.send', sessionId: CHAT, content });
        await h.settle();
        expect(h.answerTo('m')).toEqual({
          type: 'error',
          id: 'm',
          ok: false,
          error: {
            status: 403,
            code: 'refused',
            message: 'Slash commands run only at this computer.',
          },
        });
        expect(h.dispatchSessionMessage).not.toHaveBeenCalled();
      }
    );

    it.each(['look at /usr/bin', '/usr/bin is slow', '/ 2 is half'])(
      'sends %j, which is not a slash command',
      async (content) => {
        const h = harness();
        h.send('m', { op: 'session.send', sessionId: CHAT, content });
        await h.settle();
        expect(h.answerTo('m')).toMatchObject({ ok: true });
        expect(h.dispatchSessionMessage.mock.calls[0]![0].request.content).toBe(content);
      }
    );

    it('refuses a request naming a folder, a runtime or an agent path', async () => {
      const h = harness();
      for (const extra of [{ cwd: '/etc' }, { agentPath: '/etc' }, { runtime: 'codex' }]) {
        h.send('m', { op: 'session.send', sessionId: CHAT, content: 'hi', ...extra });
      }
      await h.settle();
      expect(h.frames.every((f) => f.type === 'error' && f.error.code === 'invalid')).toBe(true);
      expect(h.dispatchSessionMessage).not.toHaveBeenCalled();
    });

    it('starts a new chat in the agent’s folder from Mesh', async () => {
      const h = harness({ chats: [] });
      h.send('m', {
        op: 'session.send',
        sessionId: NEW_CHAT,
        content: 'hello',
        newChat: { agentId: AGENT_ID },
      });
      await h.settle();
      expect(h.answerTo('m')).toMatchObject({ ok: true, body: { sessionId: NEW_CHAT } });
      expect(h.dispatchSessionMessage.mock.calls[0]![0].request).toEqual({
        content: 'hello',
        create: true,
        cwd: PROJECT,
        agentPath: PROJECT,
      });
      expect(h.dispatchSessionMessage.mock.calls[0]![0].permissionCeiling).toBeUndefined();
      expect(h.audits.at(-1)).toMatchObject({ action: 'relay.session.send', operation: 'create' });
    });

    it('runs only a few new chats from the web at once, and frees a slot when a turn settles', async () => {
      const h = harness({ chats: [] });
      const ids = Array.from(
        { length: RELAY_MAX_LIVE_NEW_CHATS + 1 },
        (_, i) => `${NEW_CHAT.slice(0, -2)}${String(i).padStart(2, '0')}`
      );
      for (const [i, sessionId] of ids.entries()) {
        h.send(`m${i}`, {
          op: 'session.send',
          sessionId,
          content: 'hello',
          newChat: { agentId: AGENT_ID },
        });
        await h.settle();
      }
      expect(h.dispatchSessionMessage).toHaveBeenCalledTimes(RELAY_MAX_LIVE_NEW_CHATS);
      expect(h.answerTo(`m${RELAY_MAX_LIVE_NEW_CHATS}`)).toMatchObject({
        ok: false,
        error: { code: 'rate_limited' },
      });
      // One turn settles: one more new chat may start.
      h.dispatchSessionMessage.mock.calls[0]![0].onSettled?.('ok');
      h.send('again', {
        op: 'session.send',
        sessionId: ids.at(-1),
        content: 'hello',
        newChat: { agentId: AGENT_ID },
      });
      await h.settle();
      expect(h.answerTo('again')).toMatchObject({ ok: true });
    });

    it('records a send the dispatcher did not accept as failed, and holds no slot for it', async () => {
      const h = harness({ chats: [] });
      h.dispatchSessionMessage.mockResolvedValue({
        accepted: false,
        canonicalId: NEW_CHAT,
        outcome: { requested: 'queue', applied: 'queue', messageId: 'm1' },
        queuePosition: 1,
        queued: false,
      });
      for (let i = 0; i <= RELAY_MAX_LIVE_NEW_CHATS; i += 1) {
        h.send(`m${i}`, {
          op: 'session.send',
          sessionId: NEW_CHAT,
          content: 'hello',
          newChat: { agentId: AGENT_ID },
        });
        await h.settle();
      }
      expect(h.dispatchSessionMessage).toHaveBeenCalledTimes(RELAY_MAX_LIVE_NEW_CHATS + 1);
      expect(h.audits.at(-1)).toMatchObject({ action: 'relay.session.send', outcome: 'failed' });
    });

    it('never creates a chat without newChat, and never lands a newChat on another agent’s chat', async () => {
      const h = harness({
        chats: [facts(CHAT, { ownedBy: { room: true, task: false, beat: false } })],
      });
      h.send('a', { op: 'session.send', sessionId: NEW_CHAT, content: 'hi' });
      h.send('b', {
        op: 'session.send',
        sessionId: CHAT,
        content: 'hi',
        newChat: { agentId: AGENT_ID },
      });
      await h.settle();
      expect(h.answerTo('a')).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(h.answerTo('b')).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(h.dispatchSessionMessage).not.toHaveBeenCalled();
    });

    it('answers a launch refusal plainly, never with the refusal’s own text', async () => {
      const h = harness({
        deps: {
          dispatchSessionMessage: vi.fn(async () => ({
            refused: 'DESK_NOT_OWN' as const,
            message: 'This chat would run inside a room\'s files ("/secret/path")',
          })),
        },
      });
      h.send('m', { op: 'session.send', sessionId: CHAT, content: 'hi' });
      await h.settle();
      const answer = h.answerTo('m');
      expect(answer).toMatchObject({ ok: false, error: { status: 409, code: 'refused' } });
      expect(JSON.stringify(answer)).not.toContain('/secret');
    });
  });
});
