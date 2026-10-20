/**
 * @vitest-environment node
 *
 * The relayed caller's adapter: which chats the session relay serves, what a
 * relayed send may carry, that approvals without a passkey and answers are refused, the per-connection
 * limits, the stream's framing and teardown, and the audit entry for each op.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RelayComputerFrameSchema,
  RelayResultBodySchemas,
  SESSION_RELAY_MAX_INFLIGHT_REQUESTS,
  SESSION_RELAY_MAX_OPEN_STREAMS,
  type RelayComputerFrame,
  type RelayRequest,
} from '@dorkos/shared/session-relay';
import type { Session } from '@dorkos/shared/types';
import type { StreamFrame } from '@dorkos/shared/stream-socket';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { RecordAuditInput } from '../../../audit/audit-trail.js';
import type { DispatchSessionMessageOpts } from '../../../session/launch/launch-session.js';
import type { DurableStreamSink } from '../../streams/durable-stream-sink.js';
import type { SessionStreamPlan } from '../../streams/session-stream-delivery.js';
import {
  RELAY_SERVED_FEATURES,
  SessionRelayRequestServer,
  type RelayRequestServerDeps,
  RELAY_MAX_LIVE_NEW_CHATS,
} from '../relay-request-server.js';
import type { RelayAgent, RelaySessionFacts } from '../relay-serves.js';

const AGENT_ID = '01J0000000000000000000000A';
const SYSTEM_ID = '01J0000000000000000000000S';
const UNKNOWN_ID = '01J0000000000000000000000X';
const PROJECT = '/work/acme';
const AGENTS: RelayAgent[] = [
  { id: AGENT_ID, projectPath: PROJECT, isSystem: false },
  { id: SYSTEM_ID, projectPath: '/home/me/.dork/agents/dorkbot', isSystem: true },
];

/** A lowercase UUID for test chat `n`. */
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CHAT = sid(1);
const NEW_CHAT = sid(99);

function row(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `Chat ${id.slice(-2)}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...over,
  } as Session;
}

function facts(id: string, over: Partial<RelaySessionFacts> = {}): RelaySessionFacts {
  return {
    sessionId: id,
    cwd: PROJECT,
    agentPath: PROJECT,
    launchOrigin: 'interactive',
    row: row(id),
    ownedBy: { room: false, task: false, beat: false },
    ...over,
  };
}

/** A server over fakes, the frames it emitted and the audit entries it wrote. */
function harness(
  opts: { chats?: RelaySessionFacts[]; deps?: Partial<RelayRequestServerDeps> } = {}
) {
  const known = new Map((opts.chats ?? [facts(CHAT)]).map((f) => [f.sessionId, f]));
  const frames: RelayComputerFrame[] = [];
  const audits: RecordAuditInput[] = [];
  const streams: { sink: DurableStreamSink; plan: SessionStreamPlan; done: () => void }[] = [];
  const runtime = {
    type: 'claude-code',
    interruptQuery: vi.fn(async () => ({
      outcome: 'not-running' as const,
      runtime: 'claude-code',
    })),
    submitAnswers: vi.fn(() => true),
    approveTool: vi.fn(() => true),
  };
  const dispatchSessionMessage = vi.fn(async (o: DispatchSessionMessageOpts) => ({
    accepted: true,
    canonicalId: o.sessionId,
    outcome: { requested: 'queue', applied: 'queue', messageId: 'm1' },
    queuePosition: 1,
    queued: false,
  }));
  const deps: RelayRequestServerDeps = {
    agents: () => AGENTS,
    locateSession: vi.fn(async (id: string) => known.get(id) ?? null),
    listAgentSessions: vi.fn(async () => [...known.values()]),
    resolveStreamPlan: vi.fn(async (f: RelaySessionFacts, resume: string | undefined) => ({
      sessionId: f.sessionId,
      runtime: {} as SessionStreamPlan['runtime'],
      ctx: { cwd: f.cwd!, permissionMode: 'default' },
      resume: resume ? { seq: 7, generation: 'g1' } : undefined,
    })),
    deliverSessionStream: vi.fn(
      (sink: DurableStreamSink, plan: SessionStreamPlan) =>
        new Promise<void>((resolve) => {
          streams.push({ sink, plan, done: resolve });
          sink.signal.addEventListener('abort', () => resolve());
        })
    ),
    dispatchSessionMessage:
      dispatchSessionMessage as unknown as RelayRequestServerDeps['dispatchSessionMessage'],
    meshCore: () => undefined,
    roomSessionPlace: () => undefined,
    resolveRuntime: vi.fn(async () => runtime),
    clearQueuedMessages: vi.fn(() => [
      { id: 'q1', content: 'later', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'x' },
    ]) as unknown as RelayRequestServerDeps['clearQueuedMessages'],
    recordAudit: (input) => {
      audits.push(input);
    },
    owner: () => ({ accountId: 'acct-owner', kind: 'person', name: 'Dorian' }),
    mintClientId: () => 'relay:test',
    approvalKeys: () => null,
    approvalPin: () => null,
    pendingApproval: () => null,
    approvableCard: () => true,
    approveTool: vi.fn(async () => true),
    bumpSignCount: vi.fn(async () => true),
    ...opts.deps,
  };
  const server = new SessionRelayRequestServer(deps);
  const emit = (frame: RelayComputerFrame) => {
    // Every frame the server sends is one the protocol accepts.
    expect(RelayComputerFrameSchema.safeParse(frame).success).toBe(true);
    frames.push(frame);
  };
  const send = (id: string, request: unknown) =>
    server.handle({ type: 'request', id, request: request as RelayRequest }, emit);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const answerTo = (id: string) => frames.find((f) => 'id' in f && f.id === id);
  return {
    server,
    deps,
    frames,
    audits,
    streams,
    runtime,
    dispatchSessionMessage,
    emit,
    send,
    settle,
    answerTo,
  };
}

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

    it('refuses an unrecorded chat whose row only reads as agent-started', async () => {
      const h = harness({
        chats: [facts(sid(4), { launchOrigin: null, row: row(sid(4), { origin: 'agent' }) })],
      });
      h.send('i', { op: 'session.interrupt', sessionId: sid(4) });
      await h.settle();
      expect(h.answerTo('i')).toMatchObject({ ok: false, error: { code: 'not_found' } });
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
      // Whatever the chat's own level, a relayed turn asks before anything
      // that needs a person (option 2).
      expect(call.permissionCeiling).toBe('runtime-default');
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
      expect(h.dispatchSessionMessage.mock.calls[0]![0].permissionCeiling).toBe('runtime-default');
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

  it('interrupts like the Stop button: the queue, then the turn', async () => {
    const h = harness();
    h.runtime.interruptQuery.mockRejectedValueOnce(new Error('boom'));
    h.send('i', { op: 'session.interrupt', sessionId: CHAT });
    await h.settle();
    const body = RelayResultBodySchemas['session.interrupt'].parse(
      (h.answerTo('i') as { body: unknown }).body
    );
    expect(body.receipt).toEqual({
      outcome: 'failed',
      reason: 'delivery-failed',
      runtime: 'claude-code',
    });
    expect(body.cancelledQueued).toHaveLength(1);
    expect(h.deps.clearQueuedMessages).toHaveBeenCalledWith(CHAT);
  });

  describe('interactions', () => {
    it('refuses every answer to a question, and never answers one', async () => {
      const h = harness();
      h.send('q', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'answer', toolCallId: 't1', answers: { '0': 'Blue' } },
      });
      await h.settle();
      expect(h.answerTo('q')).toEqual({
        type: 'error',
        id: 'q',
        ok: false,
        error: {
          status: 403,
          code: 'refused',
          message: 'Answers from the web need a newer version of this computer.',
        },
      });
      expect(h.runtime.submitAnswers).not.toHaveBeenCalled();
      expect(h.deps.resolveRuntime).not.toHaveBeenCalled();
      expect(h.audits.at(-1)).toMatchObject({
        action: 'relay.interaction.respond',
        outcome: 'refused',
        target: { type: 'session', id: CHAT },
      });
    });

    it('with no passkey pinned, refuses every approval and challenge, and never approves a tool', async () => {
      const h = harness();
      const proof = {
        challengeId: 'c1',
        credentialId: 'AA',
        clientDataJSON: 'AA',
        authenticatorData: 'AA',
        signature: 'AA',
      };
      h.send('a', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'approve', toolCallId: 't', proof },
      });
      h.send('d', {
        op: 'interaction.respond',
        sessionId: CHAT,
        answer: { kind: 'deny', toolCallId: 't', proof },
      });
      h.send('c', {
        op: 'interaction.challenge',
        sessionId: CHAT,
        toolCallId: 't',
        decision: 'approve',
      });
      await h.settle();
      for (const id of ['a', 'd', 'c']) {
        expect(h.answerTo(id)).toEqual({
          type: 'error',
          id,
          ok: false,
          error: {
            status: 403,
            code: 'refused',
            message: 'Add a passkey at this computer to approve from the web.',
          },
        });
      }
      expect(h.deps.approveTool).not.toHaveBeenCalled();
      expect(h.audits.filter((a) => a.action === 'relay.interaction.approval')).toHaveLength(2);
      expect(h.audits.filter((a) => a.action === 'relay.interaction.challenge')).toHaveLength(1);
    });
  });

  describe('limits and failures', () => {
    it('refuses past the unanswered-request limit', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = harness({
        deps: {
          locateSession: vi.fn(async () => {
            await gate;
            return facts(CHAT);
          }),
        },
      });
      for (let n = 0; n <= SESSION_RELAY_MAX_INFLIGHT_REQUESTS; n++) {
        h.send(`r${n}`, { op: 'session.interrupt', sessionId: CHAT });
      }
      expect(h.answerTo(`r${SESSION_RELAY_MAX_INFLIGHT_REQUESTS}`)).toMatchObject({
        ok: false,
        error: { status: 429, code: 'rate_limited' },
      });
      release();
      await h.settle();
      await h.settle();
      h.send('after', { op: 'session.interrupt', sessionId: CHAT });
      await h.settle();
      expect(h.answerTo('after')).toMatchObject({ ok: true });
    });

    it('refuses past the open-stream limit', async () => {
      const h = harness();
      for (let n = 0; n < SESSION_RELAY_MAX_OPEN_STREAMS; n++) {
        h.send(`s${n}`, { op: 'session.stream', streamId: `st${n}`, sessionId: CHAT });
        await h.settle();
      }
      h.send('over', { op: 'session.stream', streamId: 'over', sessionId: CHAT });
      expect(h.frames.at(-1)).toMatchObject({
        type: 'stream.end',
        streamId: 'over',
        error: { status: 429, code: 'rate_limited' },
      });
    });

    it('answers an internal failure with a plain 500 that leaks nothing', async () => {
      const h = harness({
        deps: {
          locateSession: vi.fn(async () => {
            throw new Error('ENOENT /Users/secret/.claude/projects');
          }),
        },
      });
      h.send('i', { op: 'session.interrupt', sessionId: CHAT });
      await h.settle();
      expect(h.answerTo('i')).toEqual({
        type: 'error',
        id: 'i',
        ok: false,
        error: { status: 500, code: 'internal', message: 'Something went wrong on this computer.' },
      });
      expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed' });
    });

    it('refuses a frame that is not a request it knows', async () => {
      const h = harness();
      h.send('x', { op: 'session.terminal', sessionId: CHAT });
      await h.settle();
      expect(h.answerTo('x')).toMatchObject({ ok: false, error: { status: 400, code: 'invalid' } });
    });
  });

  describe('session.stream', () => {
    it('streams frames as the relayed caller, resuming from the cursor', async () => {
      const h = harness();
      const cursor = `${CHAT}-1700000000000-g1-7`;
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT, resume: cursor });
      await h.settle();
      expect(h.deps.resolveStreamPlan).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: CHAT }),
        cursor
      );
      const [{ sink, plan }] = h.streams;
      expect(plan.principal).toEqual({ kind: 'relayed' });
      expect(plan.resume).toEqual({ seq: 7, generation: 'g1' });
      const frame: StreamFrame = {
        event: 'text_delta',
        data: { text: 'hi' },
        id: `${CHAT}-1-g1-8`,
      };
      await sink!.send(frame);
      await sink!.send({ event: 'snapshot', data: { messages: [] } });
      expect(h.frames).toEqual([
        { type: 'stream.frame', streamId: 'st', frame },
        {
          type: 'stream.frame',
          streamId: 'st',
          frame: { event: 'snapshot', data: { messages: [] } },
        },
      ]);
      expect(h.audits.map((a) => a.action)).toEqual(['relay.session.stream']);
    });

    it('ends on stream.close, once, and frees the slot', async () => {
      const h = harness();
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      h.server.handle({ type: 'stream.close', streamId: 'st' }, h.emit);
      await h.settle();
      expect(h.streams[0]!.sink.closed).toBe(true);
      expect(h.frames.filter((f) => f.type === 'stream.end')).toEqual([
        { type: 'stream.end', streamId: 'st' },
      ]);
      expect(h.audits.at(-1)).toMatchObject({ action: 'relay.session.stream.closed' });
      // The id is free again.
      h.send('s2', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      expect(h.streams).toHaveLength(2);
    });

    it('ends one stream from this side with one stream.end carrying the reason', async () => {
      const h = harness();
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      expect(h.server.endStream('st', { status: 429, code: 'rate_limited', message: 'x' })).toBe(
        true
      );
      await h.settle();
      expect(h.streams[0]!.sink.closed).toBe(true);
      expect(h.frames.filter((f) => f.type === 'stream.end')).toEqual([
        {
          type: 'stream.end',
          streamId: 'st',
          error: { status: 429, code: 'rate_limited', message: 'x' },
        },
      ]);
      expect(h.audits.at(-1)!.summary).not.toBe('Closed a chat on the web');
      expect(h.server.endStream('nope', { status: 429, code: 'rate_limited', message: 'x' })).toBe(
        false
      );
    });

    it('ends with stream.end when the session stream runs out', async () => {
      const h = harness();
      h.send('s', { op: 'session.stream', streamId: 'st', sessionId: CHAT });
      await h.settle();
      h.streams[0]!.done();
      await h.settle();
      expect(h.frames).toEqual([{ type: 'stream.end', streamId: 'st' }]);
    });

    it('tears every stream down when the connection closes, sending nothing', async () => {
      const h = harness();
      h.send('a', { op: 'session.stream', streamId: 'a', sessionId: CHAT });
      h.send('b', { op: 'session.stream', streamId: 'b', sessionId: CHAT });
      await h.settle();
      h.server.closeAll();
      await h.settle();
      expect(h.streams.every((s) => s.sink.closed)).toBe(true);
      expect(h.frames).toEqual([]);
      expect(h.audits.map((a) => a.action)).toContain('relay.connection.closed');
    });

    it('refuses a stream id already open', async () => {
      const h = harness();
      h.send('a', { op: 'session.stream', streamId: 'a', sessionId: CHAT });
      await h.settle();
      h.send('b', { op: 'session.stream', streamId: 'a', sessionId: CHAT });
      // An error for the request, never a stream.end: stream `a` is still live.
      expect(h.frames.at(-1)).toMatchObject({
        type: 'error',
        id: 'b',
        error: { code: 'invalid' },
      });
      expect(h.streams).toHaveLength(1);
    });
  });

  it('audits every op as the owner on the relay surface, naming the chat and never the words', async () => {
    const h = harness();
    h.send('l', { op: 'chats.list', agentId: AGENT_ID });
    h.send('m', { op: 'session.send', sessionId: CHAT, content: 'the secret plan' });
    h.send('i', { op: 'session.interrupt', sessionId: CHAT });
    h.send('q', {
      op: 'interaction.respond',
      sessionId: CHAT,
      answer: { kind: 'answer', toolCallId: 't1', answers: { '0': 'secret answer' } },
    });
    await h.settle();
    expect(h.audits.map((a) => a.action).sort()).toEqual([
      'relay.chats.list',
      'relay.interaction.respond',
      'relay.session.interrupt',
      'relay.session.send',
    ]);
    for (const entry of h.audits) {
      expect(entry.actor).toEqual({ accountId: 'acct-owner', kind: 'person', name: 'Dorian' });
      expect(entry.source?.surface).toBe('relay');
      expect(entry.visibility).toBe('participants');
      expect(entry.participants).toEqual(['acct-owner']);
    }
    expect(h.audits.find((a) => a.action === 'relay.session.send')?.source?.sessionId).toBe(CHAT);
    expect(JSON.stringify(h.audits)).not.toContain('secret');
  });
});
