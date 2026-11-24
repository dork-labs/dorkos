/**
 * The live lookups behind `link.resolve` (DOR-5046), over the real rooms
 * service and database, the real session read rule and the real projector
 * re-key: each kind is visible exactly where its own read route lets the
 * caller see it.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry, type CapabilityHandlerContext } from '../../capabilities/index.js';
import type { AgentIdentity } from '../../agent-identity/index.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
  type SessionVisibility,
} from '../../../audit/session-visibility.js';
import { callerAuthor } from '../../../rooms/service/room-caller-author.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../rooms/__tests__/room-test-harness.js';
import {
  disposeProjector,
  getOrCreateProjector,
  rekeyProjector,
} from '../../../session/session-state-projector.js';
import { linkDomain } from '../link-capabilities.js';
import { createDorkLinkLookups } from '../link-lookups.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-11-24T12:00:00.000Z',
};
const BO: AgentIdentity = { ...ANA, agentPath: '/agents/bo', displayName: 'Bo' };

/** The person at the app: no agent token, no chat. */
const PERSON: CapabilityHandlerContext = {};
const AS_ANA: CapabilityHandlerContext = { identity: ANA };
const AS_BO: CapabilityHandlerContext = { identity: BO };

const AGENT_WORK = '0e5b3c1a-1111-4aaa-8bbb-000000000001';
const PERSONS_CHAT = '0e5b3c1a-2222-4aaa-8bbb-000000000002';
const NEW_CHAT_FIRST_ID = '0e5b3c1a-3333-4aaa-8bbb-000000000003';
const NEW_CHAT_RUNTIME_ID = '0e5b3c1a-4444-4aaa-8bbb-000000000004';
const SCOUT = '01KJ0000000000000000SC7T9Z';

/** Who may read which chat: agent work is every member's, the person's chat is theirs. */
const CHAT_VISIBILITY = new Map<string, SessionVisibility>([
  [AGENT_WORK, 'space'],
  [PERSONS_CHAT, 'participants'],
  [NEW_CHAT_RUNTIME_ID, 'space'],
]);
const CHATS_HERE = new Set(CHAT_VISIBILITY.keys());

describe('the live link lookups', () => {
  let harness: RoomHarness;
  let channelId: string;
  let anaOnlyRoomId: string;

  beforeEach(() => {
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    channelId = harness.service.createRoom(
      { kind: 'channel', title: 'Build', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      harness.human
    ).id;
    anaOnlyRoomId = harness.service.createRoom(
      { kind: 'channel', title: 'Garden', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    ).id;
    initSessionVisibility(
      (ids) =>
        new Map(
          ids.flatMap((id) => (CHAT_VISIBILITY.has(id) ? [[id, CHAT_VISIBILITY.get(id)!]] : []))
        )
    );
  });

  afterEach(() => {
    resetSessionVisibility();
    disposeProjector(NEW_CHAT_RUNTIME_ID);
  });

  /** `link.resolve` over the real lookups, as boot wires it. */
  function resolve(uri: string, context: CapabilityHandlerContext) {
    const lookups = createDorkLinkLookups({
      db: harness.db,
      rooms: harness.service,
      // The real ladder for every caller it can name in a test. The person at the
      // app is its last rung (login off: the operator's own author), which reads
      // the install's login setting; this harness has no config to read, so that
      // one rung is answered with the operator author it would give.
      roomCaller: (ctx) =>
        ctx.identity || ctx.agentIdentityPresented || ctx.sessionId !== undefined
          ? callerAuthor(harness.service, ctx)
          : harness.authors.getById(harness.human)!,
      chatExists: async (id) => CHATS_HERE.has(id),
      agents: { get: (id) => (id === SCOUT ? { id } : undefined) },
    });
    const registry = composeRegistry([linkDomain], {
      logger: noopLogger,
      linkDeps: { lookups },
    });
    return registry.invoke('link.resolve', { uri }, context).then(
      (value) => value,
      (err: unknown) => ({ refused: (err as { payload?: { code?: string } }).payload?.code })
    );
  }

  const NOT_FOUND = { refused: 'LINK_NOT_FOUND' };

  describe('a chat', () => {
    it('opens agent work for an agent and the person alike', async () => {
      const opened = { kind: 'chat', sessionId: AGENT_WORK };
      expect(await resolve(`dork:chat:${AGENT_WORK}`, PERSON)).toEqual(opened);
      expect(await resolve(`dork:chat:${AGENT_WORK}`, AS_ANA)).toEqual(opened);
    });

    it('keeps a person’s own chat from an agent, as the session routes do', async () => {
      expect(await resolve(`dork:chat:${PERSONS_CHAT}`, PERSON)).toEqual({
        kind: 'chat',
        sessionId: PERSONS_CHAT,
      });
      expect(await resolve(`dork:chat:${PERSONS_CHAT}`, AS_ANA)).toEqual(NOT_FOUND);
    });

    it('keeps every chat from a chat that presented an agent token nobody could name', async () => {
      expect(await resolve(`dork:chat:${AGENT_WORK}`, { agentIdentityPresented: true })).toEqual({
        kind: 'chat',
        sessionId: AGENT_WORK,
      });
      expect(await resolve(`dork:chat:${PERSONS_CHAT}`, { agentIdentityPresented: true })).toEqual(
        NOT_FOUND
      );
    });

    it('is not found when this server has no such chat, even for the person', async () => {
      expect(await resolve('dork:chat:0e5b3c1a-9999-4aaa-8bbb-000000000009', PERSON)).toEqual(
        NOT_FOUND
      );
    });

    it('follows a new chat’s first id through the projector’s re-key', async () => {
      getOrCreateProjector(NEW_CHAT_FIRST_ID);
      expect(await resolve(`dork:chat:${NEW_CHAT_FIRST_ID}`, PERSON)).toEqual(NOT_FOUND);
      rekeyProjector(NEW_CHAT_FIRST_ID, NEW_CHAT_RUNTIME_ID);
      expect(await resolve(`dork:chat:${NEW_CHAT_FIRST_ID}`, AS_ANA)).toEqual({
        kind: 'chat',
        sessionId: NEW_CHAT_RUNTIME_ID,
      });
    });
  });

  describe('a room', () => {
    it('opens for the person and for an agent member', async () => {
      const opened = { kind: 'room', roomId: anaOnlyRoomId };
      expect(await resolve(`dork:room:${anaOnlyRoomId}`, PERSON)).toEqual(opened);
      expect(await resolve(`dork:room:${anaOnlyRoomId}`, AS_ANA)).toEqual(opened);
    });

    it('is not found for an agent that is not in it, the same as no room at all', async () => {
      expect(await resolve(`dork:room:${anaOnlyRoomId}`, AS_BO)).toEqual(NOT_FOUND);
      expect(await resolve('dork:room:01JD3G5W7X9Y2Z4A6B8C0D1EZZ', AS_BO)).toEqual(NOT_FOUND);
    });

    it('is not found for a caller rooms refuse to name', async () => {
      // A chat with no agent of its own cannot act in rooms (DOR-2863).
      expect(
        await resolve(`dork:room:${channelId}`, { sessionId: 'a-chat-with-no-agent' })
      ).toEqual(NOT_FOUND);
      // A revoked or unverifiable agent token.
      expect(await resolve(`dork:room:${channelId}`, { agentIdentityPresented: true })).toEqual(
        NOT_FOUND
      );
    });
  });

  describe('a message', () => {
    it('opens in its room, at its place, with the thread a reply hangs under', async () => {
      const root = harness.service.post(channelId, { authorId: harness.human, text: 'Ship it?' });
      const reply = harness.service.post(channelId, {
        authorId: harness.human,
        text: 'Yes.',
        replyTo: root.id,
      });
      expect(await resolve(`dork:entry:${root.id}`, PERSON)).toEqual({
        kind: 'entry',
        roomId: channelId,
        entryId: root.id,
        seq: root.seq,
      });
      expect(await resolve(`dork:entry:${reply.id}`, AS_ANA)).toEqual({
        kind: 'entry',
        roomId: channelId,
        entryId: reply.id,
        seq: reply.seq,
        threadRootEntryId: root.id,
      });
    });

    it('is not found for an agent outside the room it was said in', async () => {
      const said = harness.service.post(anaOnlyRoomId, {
        authorId: harness.human,
        text: 'Water the tomatoes.',
      });
      expect(await resolve(`dork:entry:${said.id}`, AS_ANA)).toMatchObject({ kind: 'entry' });
      expect(await resolve(`dork:entry:${said.id}`, AS_BO)).toEqual(NOT_FOUND);
      expect(await resolve('dork:entry:01JD3H000000000000000NOPE', AS_BO)).toEqual(NOT_FOUND);
    });

    it('is not found for an agent that joined the room after it was said', async () => {
      const said = harness.service.post(anaOnlyRoomId, {
        authorId: harness.human,
        text: 'The seed order goes in on Friday.',
      });
      harness.service.addMember(anaOnlyRoomId, harness.human, { agentPath: '/agents/bo' });
      // Bo is in the room now and may open it, but not a message from before he joined:
      // an agent reads a room only from its join onwards, as its own room tools do.
      expect(await resolve(`dork:room:${anaOnlyRoomId}`, AS_BO)).toEqual({
        kind: 'room',
        roomId: anaOnlyRoomId,
      });
      expect(await resolve(`dork:entry:${said.id}`, AS_BO)).toEqual(NOT_FOUND);
      // The person, for whom the room alone decides, still opens it.
      expect(await resolve(`dork:entry:${said.id}`, PERSON)).toMatchObject({ kind: 'entry' });
    });
  });

  describe('an agent', () => {
    it('opens a registered agent for anyone, and nothing else', async () => {
      expect(await resolve(`dork:agent:${SCOUT}`, AS_BO)).toEqual({
        kind: 'agent',
        agentId: SCOUT,
      });
      expect(await resolve('dork:agent:01KJ00000000000000NNBDY9ZZ', PERSON)).toEqual(NOT_FOUND);
    });
  });
});
