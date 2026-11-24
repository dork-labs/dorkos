/**
 * `link.resolve` (DOR-5046) through the real registry: each kind opens, a
 * re-keyed chat is followed, and everything that opens nothing gets the one
 * identical refusal, a 404 on every HTTP door.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { LINK_NOT_FOUND_CODE } from '@dorkos/shared/dork-link-schemas';
import {
  CapabilityToolError,
  composeRegistry,
  type CapabilityHandlerContext,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { toolErrorStatus } from '../../../../routes/capability-dispatch.js';
import { linkDomain } from '../link-capabilities.js';
import type { DorkLinkLookups, LinkedEntry } from '../resolve-dork-link.js';

const CHAT = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';
const RETIRED_CHAT = '11111111-2222-4333-8444-555555555555';
const PRIVATE_CHAT = '99999999-8888-4777-8666-555555555555';
const ROOM = '01JD3G5W7X9Y2Z4A6B8C0D1E2F';
const OTHER_ROOM = '01JD3G5W7X9Y2Z4A6B8C0D1E2G';
const ENTRY = '01JD3H0000000000000000ENTR';
const REPLY = '01JD3H0000000000000000REPL';
const AGENT = '01KJ0000000000000000000AGT';

/** Who asks: the person at the app, or an agent that may see less. */
const PERSON: CapabilityHandlerContext = {};
const AGENT_CALLER: CapabilityHandlerContext = {
  identity: { agentPath: '/agents/ana', displayName: 'Ana', createdAt: '2026-11-24T00:00:00Z' },
};

/**
 * An install with one of each thing. The person sees everything; the agent
 * caller is kept out of the private chat and the other room, as the real
 * checks keep an agent out of a person's chat and a room it is not in.
 */
function lookups(): DorkLinkLookups {
  const entries = new Map<string, LinkedEntry>([
    [ENTRY, { roomId: ROOM, seq: 7, threadRootEntryId: null }],
    [REPLY, { roomId: OTHER_ROOM, seq: 9, threadRootEntryId: ENTRY }],
  ]);
  const isAgent = (context: CapabilityHandlerContext) => context.identity !== undefined;
  return {
    followChatRekey: (id) => (id === RETIRED_CHAT ? CHAT : id),
    chatVisible: async (id, context) => id === CHAT || (id === PRIVATE_CHAT && !isAgent(context)),
    roomVisible: (id, context) => id === ROOM || (id === OTHER_ROOM && !isAgent(context)),
    entryVisible: (id, context) => {
      const entry = entries.get(id);
      if (!entry) return null;
      return entry.roomId === OTHER_ROOM && isAgent(context) ? null : entry;
    },
    agentVisible: (id) => id === AGENT,
  };
}

function registryOver(found: DorkLinkLookups): CapabilityRegistry {
  return composeRegistry([linkDomain], { logger: noopLogger, linkDeps: { lookups: found } });
}

/** Resolve through the registry, as every door does. */
function resolve(uri: string, context: CapabilityHandlerContext = PERSON) {
  return registryOver(lookups()).invoke('link.resolve', { uri }, context);
}

/** The refusal a call threw, as its payload. */
async function refusalOf(uri: string, context: CapabilityHandlerContext = PERSON) {
  try {
    await resolve(uri, context);
  } catch (err) {
    if (err instanceof CapabilityToolError) return err.payload;
    throw err;
  }
  throw new Error(`${uri} resolved; expected a refusal`);
}

describe('link.resolve', () => {
  it('opens a chat by its id', async () => {
    expect(await resolve(`dork:chat:${CHAT}`)).toEqual({ kind: 'chat', sessionId: CHAT });
  });

  it('follows a new chat’s first id to the id its runtime gave it', async () => {
    expect(await resolve(`dork:chat:${RETIRED_CHAT}`)).toEqual({ kind: 'chat', sessionId: CHAT });
  });

  it('opens a room', async () => {
    expect(await resolve(`dork:room:${ROOM}`)).toEqual({ kind: 'room', roomId: ROOM });
  });

  it('opens a message in its room, at its place', async () => {
    expect(await resolve(`dork:entry:${ENTRY}`)).toEqual({
      kind: 'entry',
      roomId: ROOM,
      entryId: ENTRY,
      seq: 7,
    });
  });

  it('opens a reply with the thread it hangs under', async () => {
    expect(await resolve(`dork:entry:${REPLY}`)).toEqual({
      kind: 'entry',
      roomId: OTHER_ROOM,
      entryId: REPLY,
      seq: 9,
      threadRootEntryId: ENTRY,
    });
  });

  it('opens an agent', async () => {
    expect(await resolve(`dork:agent:${AGENT}`)).toEqual({ kind: 'agent', agentId: AGENT });
  });

  describe('everything that opens nothing gets the same refusal', () => {
    const MISSING = { error: 'That link opens nothing you can see here.', code: 'LINK_NOT_FOUND' };

    it.each([
      ['an unknown chat', 'dork:chat:00000000-0000-4000-8000-000000000000'],
      ['an unknown room', 'dork:room:01JD3G5W7X9Y2Z4A6B8C0D1EZZ'],
      ['an unknown message', 'dork:entry:01JD3H000000000000000NOPE'],
      ['an unknown agent', 'dork:agent:01KJ000000000000000000NOPE'],
      ['an agent id that is no ULID', 'dork:agent:not-a-ulid'],
      ['a kind no screen opens', 'dork:space:01JD3G5W7X9Y2Z4A6B8C0D1E2F'],
      ['a turn', 'dork:turn:01JD3G5W7X9Y2Z4A6B8C0D1E2F'],
      ['a kind this build does not know', 'dork:banana:01JD3G5W7X9Y2Z4A6B8C0D1E2F'],
      ['an address', 'dork:acme/owl'],
      ['an address with a name', 'dork:acme/owl/launch'],
      ['no scheme', `chat:${CHAT}`],
      ['no id', 'dork:chat:'],
      ['a link, not a reference', `/r/dork:chat:${CHAT}`],
      ['an encoded reference', `dork%3Achat%3A${CHAT}`],
      ['a double-encoded reference', `dork%253Achat%253A${CHAT}`],
      ['an id with an escape left in it', `dork:chat:${CHAT}%2520`],
      ['an id with a slash', `dork:chat:../${CHAT}`],
      ['spaces around it', ` dork:chat:${CHAT} `],
      ['an empty string', ''],
      ['far longer than any reference', `dork:chat:${'a'.repeat(5000)}`],
    ])('%s', async (_what, uri) => {
      expect(await refusalOf(uri)).toEqual(MISSING);
    });

    it('a chat the caller may not read reads exactly as one that is not there', async () => {
      // The person can open it, so it exists; the agent is told only "nothing".
      expect(await resolve(`dork:chat:${PRIVATE_CHAT}`)).toEqual({
        kind: 'chat',
        sessionId: PRIVATE_CHAT,
      });
      expect(await refusalOf(`dork:chat:${PRIVATE_CHAT}`, AGENT_CALLER)).toEqual(
        await refusalOf('dork:chat:00000000-0000-4000-8000-000000000000', AGENT_CALLER)
      );
    });

    it('a room or a message the caller may not see reads as one that is not there', async () => {
      const missing = await refusalOf('dork:room:01JD3G5W7X9Y2Z4A6B8C0D1EZZ', AGENT_CALLER);
      expect(await refusalOf(`dork:room:${OTHER_ROOM}`, AGENT_CALLER)).toEqual(missing);
      expect(await refusalOf(`dork:entry:${REPLY}`, AGENT_CALLER)).toEqual(missing);
    });

    it('is a 404 on every HTTP door', () => {
      expect(LINK_NOT_FOUND_CODE).toBe('LINK_NOT_FOUND');
      expect(toolErrorStatus(LINK_NOT_FOUND_CODE)).toBe(404);
    });
  });
});
