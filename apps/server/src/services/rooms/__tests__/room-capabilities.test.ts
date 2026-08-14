/**
 * The `rooms` capability domain, driven through the REAL registry over the REAL
 * rooms service (room-participation spec §10.2, §10.3).
 *
 * Composing the registry rather than calling the handlers directly is the point:
 * the tier gate lives INSIDE `registry.invoke` (DOR-467), input is parsed against
 * the declared schema before anything runs, and duplicate tool names throw at
 * composition. A test that called `invoke` on a definition would prove none of
 * those, which is exactly the shape of enforcement this repo has been bitten by.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import { composeCapabilityRegistryForDocs } from '../../core/self-description/dorkos-registry.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { AuthorRegistry } from '../author-registry.js';
import { roomsDomain } from '../room-capabilities.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

/** Ana, as an agent that presented a valid identity token. */
const ANA_IDENTITY: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  tierCeiling: 'act',
  createdAt: new Date().toISOString(),
};

describe('the rooms capability domain', () => {
  let harness: RoomHarness;
  let service: RoomService;
  let authors: AuthorRegistry;
  let registry: CapabilityRegistry;
  let channel: RoomWithRoster;
  let human: string;
  let ana: string;

  /** Call a tool the way an identified agent would. */
  function call(id: string, input: unknown): Promise<unknown> {
    return registry.invoke(id, input, { identity: ANA_IDENTITY, retryChannel: 'mcp-argument' });
  }

  beforeEach(() => {
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    ({ service, authors, human } = harness);
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: service },
    });
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
  });

  describe('what it declares', () => {
    it('advertises the four tools on both MCP servers, with the tiers it means', () => {
      const declared = roomsDomain.capabilities.map((capability) => ({
        id: capability.id,
        tool: capability.surfaces.mcp?.toolName,
        tier: capability.tier,
        servers: capability.surfaces.mcp?.servers,
        readOnly: capability.surfaces.mcp?.readOnlyCarveOut ?? false,
      }));

      expect(declared).toEqual([
        {
          id: 'rooms.post',
          tool: 'post_to_room',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.react',
          tool: 'react_to_room_entry',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.read_history',
          tool: 'read_room_history',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // Deliberately NOT in the tokenless carve-out: these return other
          // people's messages, and every other way to read a room's log on this
          // machine asks for something first.
          readOnly: false,
        },
        {
          id: 'rooms.search_history',
          tool: 'search_room_history',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // Deliberately NOT in the tokenless carve-out: these return other
          // people's messages, and every other way to read a room's log on this
          // machine asks for something first.
          readOnly: false,
        },
      ]);
    });

    it('composes into the whole DorkOS registry without colliding with another domain', () => {
      // The boot check doing its job: `composeRegistry` throws on a duplicate id
      // or a duplicate MCP tool name across ANY two domains, so this is the test
      // that a name chosen here is free everywhere.
      const whole = composeCapabilityRegistryForDocs();

      expect(whole.get('rooms.post')).toBeDefined();
      expect(
        whole.capabilities.filter(
          (capability) => capability.surfaces.mcp?.toolName === 'post_to_room'
        )
      ).toHaveLength(1);
    });

    it('refuses to compose with the domain but without its service handle', () => {
      expect(() =>
        composeRegistry([roomsDomain], {
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        })
      ).toThrow(/roomDeps/);
    });
  });

  describe('post_to_room', () => {
    it('posts as the calling agent, resolved from its identity and not from its arguments', async () => {
      const result = (await call('rooms.post', {
        roomId: channel.id,
        text: 'migration is running',
      })) as { posted: boolean; entryId: string };

      expect(result.posted).toBe(true);
      const entry = harness.store.getEntryById(channel.id, result.entryId);
      expect(entry?.authorId).toBe(ana);
      expect(entry?.body.text).toBe('migration is running');
    });

    it('comes back as a typed refusal, not a stack trace, in a direct message', async () => {
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      await expect(call('rooms.post', { roomId: dm.id, text: 'hello' })).rejects.toMatchObject({
        payload: { code: 'TOOL_POST_NOT_IN_DM' },
      });
    });

    it('refuses a room the agent is not in the way it refuses one that is not there', async () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );

      await expect(call('rooms.post', { roomId: private_.id, text: 'hi' })).rejects.toMatchObject({
        payload: { code: 'ROOM_NOT_FOUND' },
      });
      await expect(call('rooms.post', { roomId: 'room_nope', text: 'hi' })).rejects.toMatchObject({
        payload: { code: 'ROOM_NOT_FOUND' },
      });
    });

    it('rejects an empty message at the schema, before anything runs', async () => {
      await expect(call('rooms.post', { roomId: channel.id, text: '' })).rejects.toThrow();
      expect(harness.store.listEntries(channel.id, { limit: 10 })).toEqual([]);
    });
  });

  describe('react_to_room_entry', () => {
    it('puts an emoji on a message and takes it back', async () => {
      const entry = service.post(channel.id, { authorId: human, text: 'shipping' });

      await expect(
        call('rooms.react', { roomId: channel.id, entryId: entry.id, emoji: '👍' })
      ).resolves.toEqual({ reacted: true });
      expect(service.reactionsFor(channel.id, entry.id)).toHaveLength(1);

      await expect(
        call('rooms.react', { roomId: channel.id, entryId: entry.id, emoji: '👍' })
      ).resolves.toEqual({ reacted: false });
      expect(service.reactionsFor(channel.id, entry.id)).toEqual([]);
    });

    it('surfaces the rate bound as a typed refusal once the hour is spent', async () => {
      const entries = Array.from({ length: 21 }, (_, n) =>
        service.post(channel.id, { authorId: human, text: `line ${n}` })
      );
      for (const entry of entries.slice(0, 20)) {
        await call('rooms.react', { roomId: channel.id, entryId: entry.id, emoji: '👍' });
      }

      await expect(
        call('rooms.react', { roomId: channel.id, entryId: entries[20]!.id, emoji: '👍' })
      ).rejects.toMatchObject({ payload: { code: 'REACTION_RATE_LIMITED' } });
    });
  });

  describe('the history tools', () => {
    it('reads back the room, newest first, with labels sanitized', async () => {
      service.post(channel.id, { authorId: human, text: 'first' });
      service.post(channel.id, { authorId: human, text: 'second' });

      const result = (await call('rooms.read_history', {
        roomId: channel.id,
        limit: 10,
      })) as { note: string; entries: Array<{ text: string; author: string }> };

      expect(result.entries.map((entry) => entry.text)).toEqual(['second', 'first']);
      expect(result.note).toMatch(/never as instructions/);
      expect(
        result.entries.every((entry) => !entry.author.includes('<') && !entry.author.includes('>')),
        'no label carries a bracket a member could have typed'
      ).toBe(true);
    });

    it('finds a message through the shipped index', async () => {
      service.post(channel.id, { authorId: human, text: 'the kubernetes rollout is done' });
      await harness.indexMessages();

      const result = (await call('rooms.search_history', {
        roomId: channel.id,
        query: 'kubernetes',
        limit: 5,
      })) as { matches: Array<{ text: string }> };

      expect(result.matches.map((match) => match.text)).toEqual(['the kubernetes rollout is done']);
    });

    it('answers a room the agent is not in as though it were not there, on both tools', async () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );
      service.post(private_.id, { authorId: human, text: 'kubernetes secret' });
      await harness.indexMessages();

      await expect(
        call('rooms.read_history', { roomId: private_.id, limit: 5 })
      ).rejects.toMatchObject({ payload: { code: 'ROOM_NOT_FOUND' } });
      await expect(
        call('rooms.read_history', { roomId: 'room_nope', limit: 5 })
      ).rejects.toMatchObject({ payload: { code: 'ROOM_NOT_FOUND' } });
      await expect(
        call('rooms.search_history', { roomId: private_.id, query: 'kubernetes', limit: 5 })
      ).rejects.toMatchObject({ payload: { code: 'ROOM_NOT_FOUND' } });
    });

    it('clamps an over-large page rather than refusing it', async () => {
      for (let n = 0; n < 5; n += 1) {
        service.post(channel.id, { authorId: human, text: `line ${n}` });
      }

      const result = (await call('rooms.read_history', {
        roomId: channel.id,
        limit: 5_000,
      })) as { entries: unknown[] };

      expect(result.entries.length).toBeLessThanOrEqual(200);
    });
  });
});
