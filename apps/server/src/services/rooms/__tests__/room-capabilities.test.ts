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
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

/**
 * The two module-level facts `callerAuthor` reads about this install: who owns
 * it, and whether it requires a login. Both are stubbed rather than faked into
 * the harness because they live outside the rooms domain — and both are read PER
 * CALL by the code under test, so a test can move them between invocations the
 * way an install moves between postures.
 */
const installState: { ownerId: string | null; loginEnabled: boolean } = {
  ownerId: null,
  loginEnabled: false,
};

vi.mock('../../core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/auth/index.js')>()),
  readOwnerAccount: () => (installState.ownerId ? { id: installState.ownerId } : null),
}));

vi.mock('../../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/config-manager.js')>()),
  configManager: {
    get: (section: string) =>
      section === 'auth' ? { enabled: installState.loginEnabled } : undefined,
    set: () => {},
  },
}));

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

/**
 * Ana, as a token minted BEFORE DOR-1264 — carrying her slug where her display
 * name belongs.
 *
 * This is not a hypothetical: tokens are never rewritten, `revoke` has no
 * production caller, and one lives up to thirty days. So every install that
 * upgrades has live tokens in exactly this shape, and they keep arriving at
 * these tools until they expire.
 */
const ANA_SLUG_IDENTITY: AgentIdentity = { ...ANA_IDENTITY, displayName: 'ana' };

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
    installState.ownerId = null;
    installState.loginEnabled = false;
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
    it('advertises the six tools on both MCP servers, with the tiers it means', () => {
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
        {
          id: 'rooms.list_member_rooms',
          tool: 'list_member_rooms',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // Out of the carve-out for a reason of its own: the LIST is not
          // machine state either. A room's name and the fact that somebody is
          // in it is a statement about the operator's rooms, and this is the
          // one room verb that needs no id to answer.
          readOnly: false,
        },
        {
          id: 'rooms.search_member_rooms',
          tool: 'search_member_rooms',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // The widest read in the domain — other people's messages across
          // every room at once — so the carve-out is the last thing it should
          // have.
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

  describe('who a call acts as', () => {
    /** Call a tool as a caller carrying no agent token — a person, or nobody. */
    function callAsPerson(id: string, input: unknown, userId?: string): Promise<unknown> {
      return registry.invoke(id, input, {
        ...(userId ? { userId } : {}),
        retryChannel: 'http-header',
      });
    }

    it('acts as the invited person themselves, never as the install owner', async () => {
      // The bug this pins: with login on, every caller without an agent token
      // resolved to the OWNER, so an invited person's API key read the owner's
      // rooms and posted under the owner's name.
      installState.loginEnabled = true;
      installState.ownerId = 'owner-account';
      const owner = authors.bindOwner('owner-account').id;
      const priya = authors.human('priya-account').id;
      // A room the OWNER is in and Priya is not. If Priya were resolved as the
      // owner she would read it; as herself she cannot see it at all.
      const ownersRoom = service.createRoom(
        { kind: 'channel', title: 'Owner only', members: [], agentPaths: [] },
        owner
      );
      service.post(ownersRoom.id, { authorId: owner, text: 'a private note' });

      await expect(
        callAsPerson('rooms.read_history', { roomId: ownersRoom.id, limit: 5 }, 'priya-account')
      ).rejects.toMatchObject({ payload: { code: 'ROOM_NOT_FOUND' } });

      // And her own room IS readable, so the refusal above is about membership
      // rather than about her being unable to call anything at all.
      const hers = service.createRoom(
        { kind: 'channel', title: 'Hers', members: [], agentPaths: [] },
        priya
      );
      service.post(hers.id, { authorId: priya, text: 'mine' });
      const page = (await callAsPerson(
        'rooms.read_history',
        { roomId: hers.id, limit: 5 },
        'priya-account'
      )) as { entries: Array<{ text: string }> };
      expect(page.entries.map((entry) => entry.text)).toEqual(['mine']);
    });

    it('refuses a caller it cannot name at all when login is on', async () => {
      installState.loginEnabled = true;
      installState.ownerId = 'owner-account';

      await expect(
        callAsPerson('rooms.read_history', { roomId: channel.id, limit: 5 })
      ).rejects.toMatchObject({ payload: { code: 'UNIDENTIFIED_CALLER' } });
    });

    it('falls back to the person at the keyboard only when login is off', async () => {
      // The documented DOR-505 residual, and the ONLY posture it applies in:
      // with login off there is nothing left to tell a local program from the
      // operator, so the owner is the honest answer rather than a guess.
      installState.loginEnabled = false;
      installState.ownerId = 'owner-account';
      const owner = authors.bindOwner('owner-account').id;
      const ownersRoom = service.createRoom(
        { kind: 'channel', title: 'Owner only', members: [], agentPaths: [] },
        owner
      );
      service.post(ownersRoom.id, { authorId: owner, text: 'a private note' });

      const page = (await callAsPerson('rooms.read_history', {
        roomId: ownersRoom.id,
        limit: 5,
      })) as { entries: Array<{ text: string }> };
      expect(page.entries.map((entry) => entry.text)).toEqual(['a private note']);
    });

    it('lets an agent token win over a person on the same call', async () => {
      // Ordering, pinned: an agent running inside somebody's session posts as
      // ITSELF, which is `resolveCaller`'s first branch and the reason it is
      // first.
      installState.loginEnabled = true;
      installState.ownerId = 'owner-account';

      const result = (await registry.invoke(
        'rooms.post',
        { roomId: channel.id, text: 'as myself' },
        { identity: ANA_IDENTITY, userId: 'priya-account', retryChannel: 'mcp-argument' }
      )) as { entryId: string };

      expect(harness.store.getEntryById(channel.id, result.entryId)?.authorId).toBe(ana);
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

    it('does not rename the agent when its token carries the slug (DOR-1264)', async () => {
      // The seam the bug was OBSERVED at, end to end: a tool call resolves the
      // caller through `AuthorRegistry.resolveAgent`, which writes the token's
      // label onto the author row every room message is rendered from. Before
      // the guard, this one call turned `Ana` into `ana` in every message she
      // had ever written and in the member list — and did it again on her next
      // call, so it could not be fixed by hand either.
      const result = (await registry.invoke(
        'rooms.post',
        { roomId: channel.id, text: 'still Ana' },
        { identity: ANA_SLUG_IDENTITY, retryChannel: 'mcp-argument' }
      )) as { entryId: string };

      const entry = harness.store.getEntryById(channel.id, result.entryId);
      expect(entry?.authorId).toBe(ana);
      expect(authors.getById(entry!.authorId)?.displayName).toBe('Ana');
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
    it('tells the model to react instead of a filler word for an ack-only message (DOR-1234)', () => {
      const react = roomsDomain.capabilities.find((c) => c.id === 'rooms.react');
      expect(react?.description).toContain('"no reply needed", "just ack this"');
      expect(react?.description).toContain('✅ seen, 👍 agreed, 👀 looking');
    });

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
