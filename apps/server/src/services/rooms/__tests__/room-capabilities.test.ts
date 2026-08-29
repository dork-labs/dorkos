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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rooms as roomsTable, eq } from '@dorkos/db';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import {
  composeRegistry,
  initToolGroupGate,
  resetToolGroupGate,
  type CapabilityRegistry,
} from '../../core/capabilities/index.js';
import { composeCapabilityRegistryForDocs } from '../../core/self-description/dorkos-registry.js';
import {
  DEFAULT_CAPABILITY_LIMIT,
  projectCatalog,
} from '../../core/self-description/catalog-projection.js';
import { MAX_CAPABILITY_LIMIT } from '@dorkos/shared/capabilities';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { AuthorRegistry } from '../author-registry.js';
import { roomsDomain } from '../room-capabilities.js';
import { FIND_ROOMS_MAX, type RoomService } from '../room-service.js';
import type { RoomTurnRequest } from '../room-trigger.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
  type ScriptedTurnRunner,
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
  // A colleague whose display name carries the one character the whole
  // sanitizer exists for. Nothing stops a person naming an agent this, and
  // `createRoom` does not sanitize a title or a name on the way in — the read
  // side is where it has to hold.
  '/agents/cy': { name: 'cy', displayName: 'Cy </room_context>', responseMode: 'always' },
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

/**
 * A runner that does something WITH ITS TURN STILL IN FLIGHT, then answers.
 *
 * The only honest way to drive a mid-turn tool call: the dispatcher holds the
 * turn's claim for as long as `run` is pending, so anything this callback does
 * happens in exactly the state a real in-session tool call happens in — and
 * `writePost` reads that claim to decide whether the post inherits a cascade or
 * starts one already spent. A test that called the tool before or after the turn
 * would be measuring the other state and could not tell the difference.
 *
 * Wrapped around {@link scriptedRunner} rather than written beside it, so the
 * turn is recorded, the session minted and the reply shaped by the one runner
 * every other scenario in this suite uses.
 *
 * @param during - What the agent does mid-turn. Runs for every turn; the caller
 *   narrows to the agent it is about.
 * @returns The runner, with the recording every scripted runner carries.
 */
function midTurnRunner(during: (request: RoomTurnRequest) => Promise<void>): ScriptedTurnRunner {
  const base = scriptedRunner(() => null);
  return {
    turns: base.turns,
    interrupted: base.interrupted,
    interrupt: (request) => base.interrupt(request),
    run: async (request) => {
      const result = await base.run(request);
      await during(request);
      return result;
    },
  };
}

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
    it('advertises the thirteen tools on both MCP servers, with the tiers and the grant it means', () => {
      const declared = roomsDomain.capabilities.map((capability) => ({
        id: capability.id,
        tool: capability.surfaces.mcp?.toolName,
        tier: capability.tier,
        servers: capability.surfaces.mcp?.servers,
        readOnly: capability.surfaces.mcp?.readOnlyCarveOut ?? false,
        // The grant, pinned per verb (DOR-1611, acceptance criterion 12). A
        // management verb that silently lost its `toolGroup` would go from
        // "off until a person turns it on" to reachable by every agent on the
        // install, and nothing else in this file would notice.
        group: capability.toolGroup ?? null,
      }));

      expect(declared).toEqual([
        {
          id: 'rooms.post',
          group: null,
          tool: 'post_to_room',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.react',
          group: null,
          tool: 'react_to_room_entry',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.read_history',
          group: null,
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
          group: null,
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
          group: null,
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
          group: null,
          tool: 'search_member_rooms',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // The widest read in the domain — other people's messages across
          // every room at once — so the carve-out is the last thing it should
          // have.
          readOnly: false,
        },
        {
          id: 'rooms.get_room',
          group: null,
          tool: 'get_room',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // No message body at all, and still out of the carve-out: what it
          // returns is WHO — a room's topic and its whole roster. That is the
          // shape of somebody's install, and a tokenless caller on the
          // login-off surface resolves to the operator.
          readOnly: false,
        },
        {
          id: 'rooms.find_room',
          group: null,
          tool: 'find_room',
          tier: 'observe',
          servers: ['in-session', 'external'],
          // The same answer as its pair, from NO ROOM ID — so a tokenless
          // caller could ask which of the operator's rooms hold a named person
          // and get it in one hop. The carve-out belongs here least of all.
          readOnly: false,
        },
        // The five that ARRANGE rooms. All `act` and never `destructive`: a room
        // triggers a turn into the dark, where an approval card is unanswerable
        // — what bounds these is the grant, membership and the three-way rule,
        // not a tier pretending to be a mechanism.
        {
          id: 'rooms.create',
          group: 'roomsManage',
          tool: 'create_room',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.add_members',
          group: 'roomsManage',
          tool: 'add_room_members',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.remove_members',
          group: 'roomsManage',
          tool: 'remove_room_members',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.update',
          group: 'roomsManage',
          tool: 'update_room',
          tier: 'act',
          servers: ['in-session', 'external'],
          readOnly: false,
        },
        {
          id: 'rooms.leave',
          group: 'roomsManage',
          tool: 'leave_room',
          tier: 'act',
          servers: ['in-session', 'external'],
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

    it('serves the five tool names behind the grant through the catalog the cockpit reads', () => {
      // The one fact both Tools tabs render, taken from the WHOLE composed
      // registry through the SAME projection the HTTP route serves. Asserting it
      // off `roomsDomain` instead would prove only that the declaration exists,
      // and the declaration was never the part that broke.
      const catalog = composeCapabilityRegistryForDocs().catalog();

      const granted = projectCatalog(catalog, {
        toolGroup: 'roomsManage',
        limit: MAX_CAPABILITY_LIMIT,
      });
      expect(granted.detail).toBe('full');
      expect(
        (granted.capabilities as { surfaces: { mcp?: { toolName: string } } }[])
          .map((capability) => capability.surfaces.mcp?.toolName)
          .sort()
      ).toEqual([
        'add_room_members',
        'create_room',
        'leave_room',
        'remove_room_members',
        'update_room',
      ]);

      // And the reason the cockpit has to ASK for that slice. The unfiltered
      // page is compact and bounded at 50 of 80-odd capabilities sorted by id,
      // so `rooms.*` is both stripped of its grant and off the end of the page:
      // a Tools tab reading it would show an empty group, forever, with nothing
      // failing anywhere.
      const bare = projectCatalog(catalog, { limit: DEFAULT_CAPABILITY_LIMIT });
      expect(bare.detail).toBe('compact');
      expect(bare.capabilities.some((capability) => 'toolGroup' in capability)).toBe(false);
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

  describe('get_room', () => {
    /** One room's detail, as the tool projects it. */
    interface RoomDetailPayload {
      roomId: string;
      kind: string;
      name: string | null;
      topic: string | null;
      joined: string;
      lastActivity: string;
      members: Array<{ authorId: string; name: string | null; handle?: string; kind: string }>;
    }

    /** Ask for one room, as Ana. */
    async function describeAs(roomId: string): Promise<RoomDetailPayload> {
      return (await call('rooms.get_room', { roomId })) as RoomDetailPayload;
    }

    /** Ask for one room as somebody else — the positive control on a refusal. */
    function describeAsAgent(roomId: string, agentPath: string): Promise<unknown> {
      return registry.invoke(
        'rooms.get_room',
        { roomId },
        {
          identity: { ...ANA_IDENTITY, agentPath, displayName: 'Bo' },
          retryChannel: 'mcp-argument',
        }
      );
    }

    it('hands a member the whole room: what it is called, what it is about, and who is in it', async () => {
      service.updateRoom(channel.id, human, { topic: 'Ship the migration' });

      const room = await describeAs(channel.id);

      expect(room.roomId).toBe(channel.id);
      expect(room.kind).toBe('channel');
      expect(room.name).toBe('#backend');
      expect(room.topic).toBe('Ship the migration');
      // The roster is the whole point of this verb: everybody the store says is
      // in the room, rather than a subset that happens to be convenient.
      expect(room.members.map((member) => member.authorId).sort()).toEqual(
        harness.store
          .listMembers(channel.id)
          .map((member) => member.authorId)
          .sort()
      );
      expect(room.members.find((member) => member.authorId === ana)).toMatchObject({
        name: 'Ana',
        handle: 'ana',
        kind: 'agent',
      });
      // The person is on it too, and marked as one — which is the fact
      // `meta/agent-etiquette.md` asks an agent to know before it speaks.
      expect(room.members.find((member) => member.authorId === human)?.kind).toBe('human');
    });

    it('reports a room nobody gave a topic as `null`, rather than leaving the key out', async () => {
      // Two different facts — "no topic" and "a topic I could not show you" —
      // and an absent key collapses them into each other. JSON drops an
      // `undefined`, so this asserts the key survives at all.
      const room = await describeAs(channel.id);

      expect(room.topic).toBeNull();
      expect(Object.hasOwn(room, 'topic')).toBe(true);
    });

    it('names a direct message by who it is with, and says that it is one', async () => {
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      const room = await describeAs(dm.id);

      expect(room.kind).toBe('dm');
      expect(room.name).toBe('Ana');
    });

    it('answers a room the agent is not in exactly as it answers one that is not there', async () => {
      const private_ = service.createRoom(
        { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/bo'] },
        human
      );
      service.updateRoom(private_.id, human, { topic: 'the thing nobody else is told' });

      await expect(call('rooms.get_room', { roomId: private_.id })).rejects.toMatchObject({
        payload: { code: 'ROOM_NOT_FOUND' },
      });
      await expect(call('rooms.get_room', { roomId: 'room_nope' })).rejects.toMatchObject({
        payload: { code: 'ROOM_NOT_FOUND' },
      });
      // The control on the same seeded room: it exists and it has that topic, so
      // the refusal above is about membership rather than about a room that was
      // never there. Bo is in it and sees all of it.
      const bosView = (await describeAsAgent(private_.id, '/agents/bo')) as RoomDetailPayload;
      expect(bosView.topic).toBe('the thing nobody else is told');
    });

    it('refuses the OWNER a room they can SEE but never joined', async () => {
      // Visibility is not membership, and the owner is exactly where the two
      // come apart: `seesEveryRoom` lets them see every room on the machine,
      // and reading one still takes a member row. Built on `requireVisibleRoom`
      // instead, this would hand the operator a room an agent opened without
      // them — roster, topic and all — from any session with no identity.
      const anasOwn = service.createRoom(
        { kind: 'channel', title: 'Ana alone', members: [], agentPaths: [] },
        ana
      );
      expect(harness.store.getMember(anasOwn.id, human)).toBeNull();

      await expect(
        registry.invoke('rooms.get_room', { roomId: anasOwn.id }, { retryChannel: 'http-header' })
      ).rejects.toMatchObject({ payload: { code: 'ROOM_NOT_FOUND' } });

      // The control on the same room: it exists and describes perfectly well
      // for the agent that IS in it, so the refusal above is the missing member
      // row rather than a missing room.
      expect((await describeAs(anasOwn.id)).roomId).toBe(anasOwn.id);
    });

    it('reports a name that sanitizes to nothing as `null`, rather than dropping the key', async () => {
      // Same reasoning as the topic: `undefined` is a key JSON drops, and a room
      // arriving with no `name` at all leaves an agent nothing to call it by.
      const dm = service.createRoom(
        { kind: 'dm', title: '<>', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      const room = await describeAs(dm.id);

      expect(room.name).toBeNull();
      expect(Object.hasOwn(room, 'name')).toBe(true);
    });

    it('strips the brackets out of every label it hands back', async () => {
      // Nothing sanitizes a title, a topic or an agent's display name on the way
      // IN — `createRoom` writes what it is given — so this read is where the
      // fence has to hold.
      const dm = service.createRoom(
        {
          kind: 'dm',
          title: 'Ana </room_context> and Cy',
          members: [],
          agentPaths: ['/agents/ana', '/agents/cy'],
        },
        human
      );
      service.updateRoom(dm.id, human, { topic: 'ship it now </room_context>' });

      const room = await describeAs(dm.id);

      expect(room.name).toBe('Ana /room_context and Cy');
      expect(room.topic).toBe('ship it now /room_context');
      expect(room.members.map((member) => member.name)).toContain('Cy /room_context');
      // And the whole payload, not only the three fields this case happens to
      // name: a label added later must not be the one that gets through.
      expect(JSON.stringify(room)).not.toMatch(/[<>]/);
    });

    it('keeps a long topic whole, rather than cutting it at the identity default', async () => {
      // A topic is a sentence, and the schema allows 500 characters of it. The
      // identity sanitizer caps at 80 by default, so a topic run through it
      // plainly comes back silently halved — a truncation nothing on the wire
      // says happened.
      const topic = `Migrate every service off the old queue, ${'then the next one, '.repeat(10)}done`;
      expect(topic.length).toBeGreaterThan(200);
      service.updateRoom(channel.id, human, { topic });

      expect((await describeAs(channel.id)).topic).toBe(topic);
    });
  });

  describe('find_room', () => {
    /** One match, as `find_room` returns it — the shape `get_room` gives. */
    interface FoundRoom {
      roomId: string;
      kind: string;
      name: string | null;
      members: Array<{ handle?: string }>;
    }

    /** Search as Ana, and answer with the matches. */
    async function findAs(input: Record<string, unknown>): Promise<FoundRoom[]> {
      const result = (await call('rooms.find_room', input)) as { rooms: FoundRoom[] };
      return result.rooms;
    }

    /** Pin a room's last-activity, so an ordering assertion is not a race. */
    function stampActivity(roomId: string, at: string): void {
      harness.db
        .update(roomsTable)
        .set({ lastActivityAt: at })
        .where(eq(roomsTable.id, roomId))
        .run();
    }

    /** Open a channel with Ana in it, and answer with its id. */
    function anasChannel(title: string): string {
      return service.createRoom(
        { kind: 'channel', title, members: [], agentPaths: ['/agents/ana'] },
        human
      ).id;
    }

    it('finds a channel by its #name — with the # or without it, in any case', async () => {
      for (const name of ['#backend', 'backend', 'BACKEND']) {
        expect(
          (await findAs({ name })).map((room) => room.roomId),
          name
        ).toEqual([channel.id]);
      }
    });

    it('finds a direct message by part of its title, which is who it is with', async () => {
      // A DM has no slug to match on. Its title is the counterpart's name, so
      // the substring branch is the whole of "find my DM with Ana".
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      const found = await findAs({ name: 'an' });

      expect(found.map((room) => room.roomId)).toEqual([dm.id]);
      expect(found[0]?.kind).toBe('dm');
    });

    it('finds only the rooms holding EVERY handle named, which is what makes it a dedupe check', async () => {
      // The question a caller actually asks before opening a second DM with
      // somebody: is there already a room with exactly these people in it? The
      // operator has no handle until a person sets one (DOR-979), so this is the
      // write path that ships, used the way the cockpit will use it.
      authors.setHandle(human, 'dorian');
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      // Ana and the operator are both in the DM and both in #backend.
      expect(
        (await findAs({ members: ['ana', 'dorian'] })).map((room) => room.roomId).sort()
      ).toEqual([channel.id, dm.id].sort());
      // ALL, not ANY: Bo is in the channel and not in the DM, so naming him
      // drops the DM rather than adding his rooms.
      expect(
        (await findAs({ members: ['ana', 'dorian', 'bo'] })).map((room) => room.roomId)
      ).toEqual([channel.id]);
      // A handle nobody holds narrows to nothing rather than being ignored.
      expect(await findAs({ members: ['ana', 'nobody-here'] })).toEqual([]);
      // And the `@` a person would actually type, with their capitalisation, is
      // absorbed rather than turned into a miss.
      expect(await findAs({ members: ['@Ana', '@Dorian'] })).toHaveLength(2);
    });

    it('narrows by name and members together, rather than by whichever came last', async () => {
      authors.setHandle(human, 'dorian');
      const dm = service.createRoom(
        { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] },
        human
      );

      expect(
        (await findAs({ name: 'ana', members: ['ana', 'dorian'] })).map((room) => room.roomId)
      ).toEqual([dm.id]);
      // Each filter on its own matches the channel too, so the single answer
      // above is the two composing rather than one of them being dropped.
      expect(await findAs({ members: ['ana', 'dorian'] })).toHaveLength(2);
    });

    it('refuses a call that names no filter at all', async () => {
      // Not a schema `refine`: `z.toJSONSchema` drops one silently, so the model
      // would be handed two optional fields and no rule. A typed refusal
      // carrying a code is what it can act on instead.
      await expect(call('rooms.find_room', {})).rejects.toMatchObject({
        payload: { code: 'MISSING_FILTER' },
      });
    });

    it('refuses a filter that narrows nothing, rather than quietly listing everything', async () => {
      // Every one of these passes the schema and matches every room the caller
      // is in, which would turn a find into a capped list wearing the wrong
      // name. The sigils are the sharp cases, and the DOUBLED ones are sharper
      // still: while the guard and the matcher each stripped one `#`, `"##"`
      // read as a real filter on the way in and as an empty needle on the way
      // out — and an empty needle matches everything. Both now ask the same
      // normalizer, so there is no arithmetic left to get wrong.
      for (const input of [
        { name: '   ' },
        { name: '#' },
        { name: ' # ' },
        { name: '##' },
        { name: ' ## ' },
        { name: '####' },
        { members: ['@'] },
        { members: ['@@'] },
        { members: ['@', ' '] },
        { name: '#', members: ['@'] },
      ]) {
        await expect(call('rooms.find_room', input), JSON.stringify(input)).rejects.toMatchObject({
          payload: { code: 'MISSING_FILTER' },
        });
      }
    });

    it('takes a sigil-heavy filter that still names something, and simply finds nothing', async () => {
      // The other side of the refusal, and the one that keeps it honest: the
      // guard must refuse an EMPTY needle, never a strange-looking one. `##`
      // in front of a real word still names that word, so this is an ordinary
      // search that happens to match no room — an empty list, not an error.
      await expect(findAs({ name: '##no-such-room' })).resolves.toEqual([]);
      await expect(findAs({ members: ['@@nobody'] })).resolves.toEqual([]);
      // And the same shape over a name that DOES match proves the sigils were
      // stripped rather than merely tolerated.
      expect((await findAs({ name: '##backend' })).map((room) => room.roomId)).toEqual([
        channel.id,
      ]);
    });

    it(`answers at most ${FIND_ROOMS_MAX} matches, however many there are`, async () => {
      // Every match carries its whole roster, so the bound is on the PROMPT: a
      // filter matching more than ten has not narrowed anything, and the honest
      // answer to it is a shorter answer.
      for (let n = 0; n < FIND_ROOMS_MAX + 2; n += 1) {
        anasChannel(`shipping-lane-${String(n).padStart(2, '0')}`);
      }

      expect(await findAs({ name: 'shipping-lane' })).toHaveLength(FIND_ROOMS_MAX);
    });

    it('answers most recently active first, which is what the description promises', async () => {
      // Stamped rather than raced: three rooms opened in one loop can share a
      // millisecond, and the id tiebreak is a random ULID suffix — so an
      // ordering assertion built on creation order would pass or fail by luck.
      const alpha = anasChannel('lane-alpha');
      const beta = anasChannel('lane-beta');
      const gamma = anasChannel('lane-gamma');
      stampActivity(alpha, '2026-08-25T09:00:00.000Z');
      stampActivity(beta, '2026-08-25T11:00:00.000Z');
      stampActivity(gamma, '2026-08-25T10:00:00.000Z');

      expect((await findAs({ name: 'lane-' })).map((room) => room.roomId)).toEqual([
        beta,
        gamma,
        alpha,
      ]);
    });

    it('applies BOTH filters before the cap, never the cap between them', async () => {
      // The order is load-bearing, and a cap in the wrong place is invisible in
      // a small fixture. Here the three rooms that answer the whole query are
      // the OLDEST, so they sit below the cap in activity order: a slice taken
      // after the name filter drops them before the members filter ever runs,
      // and the answer comes back empty instead of complete.
      const withBo: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        const room = service.createRoom(
          {
            kind: 'channel',
            title: `dedupe-lane-old-${n}`,
            members: [],
            agentPaths: ['/agents/ana', '/agents/bo'],
          },
          human
        );
        stampActivity(room.id, `2026-08-25T09:0${n}:00.000Z`);
        withBo.push(room.id);
      }
      for (let n = 0; n < FIND_ROOMS_MAX + 2; n += 1) {
        const padded = String(n).padStart(2, '0');
        stampActivity(anasChannel(`dedupe-lane-new-${padded}`), `2026-08-25T10:${padded}:00.000Z`);
      }

      const found = await findAs({ name: 'dedupe-lane', members: ['bo'] });

      expect(found.map((room) => room.roomId).sort()).toEqual([...withBo].sort());
      // The control: the name filter on its own really does match more than the
      // cap, so the complete answer above is the ORDER of the filters rather
      // than a fixture too small to tell the difference.
      expect(await findAs({ name: 'dedupe-lane' })).toHaveLength(FIND_ROOMS_MAX);
    });

    it('does not find a room the caller is not in, however well it matches', async () => {
      const foreign = service.createRoom(
        { kind: 'channel', title: 'backend secrets', members: [], agentPaths: ['/agents/bo'] },
        human
      );

      expect((await findAs({ name: 'backend' })).map((room) => room.roomId)).toEqual([channel.id]);
      // The control: the room exists and its title really does match the words
      // asked for — for the agent that is actually in it.
      const bosFind = (await registry.invoke(
        'rooms.find_room',
        { name: 'backend' },
        {
          identity: { ...ANA_IDENTITY, agentPath: '/agents/bo', displayName: 'Bo' },
          retryChannel: 'mcp-argument',
        }
      )) as { rooms: FoundRoom[] };
      expect(bosFind.rooms.map((room) => room.roomId).sort()).toEqual(
        [channel.id, foreign.id].sort()
      );
    });
  });
});

/**
 * The five verbs that ARRANGE rooms, rather than talk in them (spec
 * `rooms-management-tools` §D7–D9, DOR-1611).
 *
 * Driven through the real registry over the real service, exactly as the eight
 * above are — so every row here goes through the grant gate, the schema parse and
 * the service's own guards in the order production runs them.
 *
 * The grant is WIRED here, because these verbs are refused without it. That is
 * itself asserted (the last block): an agent whose owner has not turned the
 * switch on gets `tool_group_disabled` from every one of them, and the shared
 * conformance suite sweeps all five against the same fail-closed state.
 */
describe('the rooms MANAGEMENT verbs', () => {
  let harness: RoomHarness;
  let service: RoomService;
  let authors: AuthorRegistry;
  let registry: CapabilityRegistry;
  let channel: RoomWithRoster;
  let human: string;
  let ana: string;
  let bo: string;
  /** Whether the agent calling holds `roomsManage`, flipped per test. */
  let grantHeld = true;

  /** Call a management tool as Ana, the way an identified agent would. */
  function call(id: string, input: unknown): Promise<unknown> {
    return registry.invoke(id, input, { identity: ANA_IDENTITY, retryChannel: 'mcp-argument' });
  }

  /** The `@handle` that reaches an agent, as `get_room` would report it. */
  function handleOf(agentPath: string, displayName: string): string {
    const handle = authors.resolveAgent(agentPath, displayName).handle;
    if (!handle) throw new Error(`${agentPath} has no handle`);
    return handle;
  }

  beforeEach(() => {
    installState.ownerId = null;
    installState.loginEnabled = false;
    grantHeld = true;
    resetToolGroupGate();
    // The real gate, over a lookup this file can move — the same seam boot wires
    // to the agent's manifest.
    initToolGroupGate({ grants: { holds: async () => grantHeld } });
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    ({ service, authors, human } = harness);
    registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: service },
    });
    // A channel the owner opened and Ana belongs to — the ordinary case.
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      human
    );
    ana = authors.resolveAgent('/agents/ana', 'Ana').id;
    bo = authors.resolveAgent('/agents/bo', 'Bo').id;
  });

  afterEach(() => {
    resetToolGroupGate();
  });

  describe('create_room', () => {
    it('opens a channel with the caller in it', async () => {
      const opened = (await call('rooms.create', {
        kind: 'channel',
        title: 'Release work',
        topic: 'shipping 1.2',
      })) as { roomId: string; created: boolean; members: { authorId: string }[]; topic: string };

      expect(opened.created).toBe(true);
      expect(opened.topic).toBe('shipping 1.2');
      expect(opened.members.map((member) => member.authorId)).toEqual([ana]);
    });

    it('returns the existing conversation rather than opening a second one', async () => {
      // The dedupe already lives in the service; the tool describes it and does
      // not reimplement it. Worth a row because the alternative — two DMs with
      // the same person — is unrecoverable from the agent's side.
      // Ana's own conversation. Deliberately not a DM with Bo: two agents alone
      // together is refused by the three-way rule, which is a different rule and
      // has its own row below.
      const first = (await call('rooms.create', { kind: 'dm', members: [] })) as {
        roomId: string;
        created: boolean;
        name: string;
      };
      // A DM the caller did not name is named after who is in it, exactly as one
      // opened from the app is — NOT the bare "#" the raw create request used to
      // fall back to (DOR-1611 review).
      expect(first.name).toBe('Ana');
      const second = (await call('rooms.create', { kind: 'dm', members: [] })) as {
        roomId: string;
        created: boolean;
      };

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.roomId).toBe(first.roomId);
    });

    it('refuses a handle that names nobody, and opens nothing', async () => {
      const before = service.listRooms(human).length;

      await expect(
        call('rooms.create', { kind: 'channel', title: 'Ghosts', members: ['@nobody'] })
      ).rejects.toMatchObject({ payload: { code: 'MEMBER_NOT_FOUND' } });

      expect(service.listRooms(human)).toHaveLength(before);
    });

    it('cannot assemble a room where two agents answer each other unwatched', async () => {
      // The three-way rule, inherited from `requireSeedingAllowed` rather than
      // restated here. The grant does not buy a way around it.
      await expect(
        call('rooms.create', {
          kind: 'channel',
          title: 'Pair',
          members: [handleOf('/agents/bo', 'Bo')],
        })
      ).rejects.toMatchObject({ payload: { code: 'OPERATOR_ONLY' } });
    });

    it('names the person by the id the roster reports, when she has no handle', async () => {
      // The defect this closes (DOR-1611 review). `mintHandle` gives the
      // install's own human NOTHING — the only string it could derive from is
      // the placeholder 'You' — so on a default install the owner cannot be
      // named by handle at all. And the three-way rule means every room an agent
      // may open with a colleague is one she has to be in. Without the id
      // fallback this exact call was a dead end: OPERATOR_ONLY with a colleague,
      // MEMBER_NOT_FOUND when naming her by the id `get_room` had just reported.
      expect(authors.getById(human)?.handle ?? null).toBeNull();

      const opened = (await call('rooms.create', {
        kind: 'channel',
        title: 'Release work',
        members: [handleOf('/agents/bo', 'Bo'), human],
      })) as { roomId: string; members: { authorId: string }[] };

      expect(opened.members.map((member) => member.authorId).sort()).toEqual(
        [ana, bo, human].sort()
      );
    });

    it('takes an id a model wrote with an @ in front of it', async () => {
      // Models that have been told to write `@name` write `@<id>` too, and a
      // dead end there reads to the model as "that member does not exist".
      const opened = (await call('rooms.create', {
        kind: 'channel',
        title: 'Sigil',
        members: [`@${human}`],
      })) as { members: { authorId: string }[] };

      expect(opened.members.map((member) => member.authorId).sort()).toEqual([ana, human].sort());
    });

    it('opens a direct message with the person, by her id', async () => {
      const opened = (await call('rooms.create', { kind: 'dm', members: [human] })) as {
        roomId: string;
        created: boolean;
        members: { authorId: string }[];
      };

      expect(opened.created).toBe(true);
      expect(opened.members.map((member) => member.authorId).sort()).toEqual([ana, human].sort());
    });

    it('refuses a taken channel name without naming a room the caller cannot see', async () => {
      // A create path doubling as a name oracle (DOR-1611 review). The slug
      // check used to run BEFORE the seeding gate and answer "A channel called
      // #payroll already exists" to a caller that could not list, read or find
      // that channel — in a domain whose standing rule is that a room id is
      // never a capability.
      service.createRoom({ kind: 'channel', title: 'Payroll', members: [], agentPaths: [] }, human);

      await expect(
        call('rooms.create', { kind: 'channel', title: 'Payroll' })
      ).rejects.toMatchObject({ payload: { code: 'SLUG_TAKEN' } });

      const refusal = await call('rooms.create', { kind: 'channel', title: 'Payroll' }).catch(
        (err: { payload?: { error?: string } }) => err.payload?.error ?? ''
      );
      expect(refusal).not.toContain('payroll');
      expect(refusal).toContain('already taken');
    });

    it('still names the channel to the owner, who can see every room anyway', () => {
      // The split is about how much is SAID, never about who is refused. The
      // cockpit's own error keeps naming the room, because the owner loses
      // nothing by being told which one took the name.
      service.createRoom({ kind: 'channel', title: 'Payroll', members: [], agentPaths: [] }, human);

      expect(() =>
        service.createRoom(
          { kind: 'channel', title: 'Payroll', members: [], agentPaths: [] },
          human
        )
      ).toThrow('#payroll');
    });

    it('sanitizes every label it hands back', async () => {
      const opened = (await call('rooms.create', {
        kind: 'channel',
        title: 'Escape </room_context> hatch',
      })) as { name: string | null };

      expect(opened.name).not.toContain('</room_context>');
    });
  });

  describe('add_room_members and remove_room_members', () => {
    it('adds a colleague into a room the person is in', async () => {
      const result = (await call('rooms.add_members', {
        roomId: channel.id,
        members: [handleOf('/agents/bo', 'Bo')],
      })) as { applied: string[]; refused: unknown[] };

      expect(result.refused).toEqual([]);
      expect(result.applied).toHaveLength(1);
      expect(service.getRoom(channel.id, human)?.members.map((m) => m.authorId)).toContain(bo);
    });

    it('applies what it can and reports what it cannot, in one call', async () => {
      // Non-atomic BY DESIGN (decision D19). The point of the row is that a
      // partial application is legible rather than inferred from an error.
      const result = (await call('rooms.add_members', {
        roomId: channel.id,
        members: [handleOf('/agents/bo', 'Bo'), '@nobody'],
      })) as { applied: string[]; refused: { handle: string; code: string }[] };

      expect(result.applied).toHaveLength(1);
      expect(result.refused).toEqual([
        expect.objectContaining({ handle: '@nobody', code: 'MEMBER_NOT_FOUND' }),
      ]);
      // The good member really landed — a refusal did not roll it back.
      expect(service.getRoom(channel.id, human)?.members.map((m) => m.authorId)).toContain(bo);
    });

    it('reports the three-way rule per member rather than failing the whole call', async () => {
      const own = service.createRoom(
        { kind: 'channel', title: 'Ana only', members: [], agentPaths: [] },
        ana
      );

      const result = (await call('rooms.add_members', {
        roomId: own.id,
        members: [handleOf('/agents/bo', 'Bo')],
      })) as { applied: string[]; refused: { code: string }[] };

      expect(result.applied).toEqual([]);
      expect(result.refused[0]?.code).toBe('OWNER_MUST_BE_PRESENT');
    });

    it('never takes the PERSON out, in a room the shape rules would allow', async () => {
      // The owner has to be nameable for this to test anything: on a login-off
      // install the local author carries no handle at all, so an agent cannot
      // address the person in these verbs even to be refused. Giving her one is
      // what a login-on install does, and it is the posture where the guard is
      // load-bearing rather than incidental.
      authors.setHandle(human, 'dorian');
      // One agent in the room, so the three-way rule would NOT refuse this — the
      // refusal has to come from who is asking.
      const result = (await call('rooms.remove_members', {
        roomId: channel.id,
        members: ['@dorian'],
      })) as { applied: string[]; refused: { code: string; message: string }[] };

      expect(result.applied).toEqual([]);
      expect(result.refused[0]?.code).toBe('OPERATOR_ONLY');
      expect(result.refused[0]?.message).toContain('Only you');
      expect(service.getRoom(channel.id, human)?.members.map((m) => m.authorId)).toContain(human);
    });

    it('removes an ordinary member it was asked to remove', async () => {
      await call('rooms.add_members', {
        roomId: channel.id,
        members: [handleOf('/agents/bo', 'Bo')],
      });

      const result = (await call('rooms.remove_members', {
        roomId: channel.id,
        members: [handleOf('/agents/bo', 'Bo')],
      })) as { applied: string[]; refused: unknown[] };

      expect(result.refused).toEqual([]);
      expect(result.applied).toHaveLength(1);
      expect(service.getRoom(channel.id, human)?.members.map((m) => m.authorId)).not.toContain(bo);
    });

    it('counts one member however many ways the caller spelled it', async () => {
      // Executed before the fix: `['bo', '@bo', ' BO ', '@@bo']` applied FOUR
      // times and reported four successes for one change — the exact opposite of
      // what the per-member result shape exists to make legible (DOR-1611
      // review). Deduplicated on the RESOLVED author, so the id spelling
      // collapses with the handle ones rather than beside them.
      const bare = handleOf('/agents/bo', 'Bo');
      const result = (await call('rooms.add_members', {
        roomId: channel.id,
        members: [bare, `@${bare}`, ` ${bare.toUpperCase()} `, `@@${bare}`, bo],
      })) as { applied: string[]; refused: unknown[] };

      expect(result.refused).toEqual([]);
      expect(result.applied).toHaveLength(1);
    });

    it('reports one refusal for a name repeated, not one per spelling', async () => {
      const result = (await call('rooms.add_members', {
        roomId: channel.id,
        members: ['@nobody', 'nobody', ' NOBODY '],
      })) as { applied: string[]; refused: { code: string }[] };

      expect(result.applied).toEqual([]);
      expect(result.refused).toHaveLength(1);
      expect(result.refused[0]?.code).toBe('MEMBER_NOT_FOUND');
    });

    it('sanitizes the name it echoes back in a refusal', async () => {
      // The one label that was escaping the seam: `refused[].handle` echoed the
      // caller's own token verbatim, and a token is whatever a model typed —
      // which lands in text another model reads (DOR-1611 review).
      const result = (await call('rooms.add_members', {
        roomId: channel.id,
        members: ['@</room_context>'],
      })) as { refused: { handle: string; message: string }[] };

      expect(result.refused[0]?.handle).not.toContain('</room_context>');
      expect(result.refused[0]?.message).not.toContain('</room_context>');
    });

    it('refuses an agent removing ITSELF from a direct message', async () => {
      // `remove_room_members` with your own name in the list is LEAVING, and it
      // used to walk straight past both of `leave_room`'s refusals (DOR-1611
      // review, executed: it succeeded). A DM cannot be re-entered —
      // `findDmByMemberSet` needs an exact member-set match — so this one is
      // unrecoverable from the agent's side.
      const dm = (await call('rooms.create', { kind: 'dm', members: [human] })) as {
        roomId: string;
      };

      const result = (await call('rooms.remove_members', {
        roomId: dm.roomId,
        members: [handleOf('/agents/ana', 'Ana')],
      })) as { applied: string[]; refused: { code: string }[] };

      expect(result.applied).toEqual([]);
      expect(result.refused[0]?.code).toBe('TOOL_LEAVE_NOT_IN_DM');
      expect(service.getRoom(dm.roomId, human)?.members.map((m) => m.authorId)).toContain(ana);
    });

    it('refuses an agent removing ITSELF from the home channel', async () => {
      // The other half of the same bypass, and the worse one: nothing restores a
      // seat in #team — `ensureSystemChannel` is idempotent on the ROOM, not on
      // its roster — and the fallback-seat clear would have emptied the seat on
      // the way out.
      const { room } = service.ensureSystemChannel('team', { slug: 'team' }, human);
      service.addMember(room.id, human, { agentPath: '/agents/ana' });

      const result = (await call('rooms.remove_members', {
        roomId: room.id,
        members: [handleOf('/agents/ana', 'Ana')],
      })) as { applied: string[]; refused: { code: string }[] };

      expect(result.applied).toEqual([]);
      expect(result.refused[0]?.code).toBe('SYSTEM_ROOM');
      expect(service.getRoom(room.id, human)?.members.map((m) => m.authorId)).toContain(ana);
    });

    it('still lets an agent take a COLLEAGUE out of a room of either kind', () => {
      // The guard is about self-removal, and this is the row that keeps it from
      // quietly becoming a rule about rooms. The cockpit's own path is the same
      // one and is likewise untouched.
      service.addMember(channel.id, human, { agentPath: '/agents/bo' });

      expect(() => service.removeMemberFromTool(channel.id, ana, bo)).not.toThrow();
    });

    it('refuses a room the caller is not in, as one answer about the room', async () => {
      const foreign = service.createRoom(
        { kind: 'channel', title: 'Elsewhere', members: [], agentPaths: ['/agents/bo'] },
        human
      );

      await expect(
        call('rooms.add_members', { roomId: foreign.id, members: [handleOf('/agents/bo', 'Bo')] })
      ).rejects.toMatchObject({ payload: { code: 'ROOM_NOT_FOUND' } });
    });
  });

  describe('update_room', () => {
    it('renames a room and sets its topic', async () => {
      const updated = (await call('rooms.update', {
        roomId: channel.id,
        title: 'Backend work',
        topic: 'the API rewrite',
      })) as { name: string; topic: string };

      expect(updated.topic).toBe('the API rewrite');
      expect(service.getRoom(channel.id, human)?.title).toBe('Backend work');
    });

    it('exposes no way to archive a room or change what it may spend', () => {
      // Acceptance criterion 9, asserted against the SCHEMA rather than against
      // a refusal: a field that is not in the input cannot be sent at all, and
      // the operator-only fields stay reachable only from the person's own
      // routes.
      const update = roomsDomain.capabilities.find((c) => c.id === 'rooms.update');
      const shape = Object.keys(
        (update?.input as unknown as { shape: Record<string, unknown> }).shape
      );

      expect(shape.sort()).toEqual(['roomId', 'title', 'topic']);
    });

    it('refuses a rename onto a taken name without naming the room that holds it', async () => {
      // The UPDATE half of the same oracle, and the call site a mutation
      // survives: `createRoom`'s refusal is covered above, and leaving
      // `renamedSlug` naming the holder lets an armed agent rename a room it IS
      // in, over and over, to enumerate the channel names on the whole install.
      service.createRoom({ kind: 'channel', title: 'Payroll', members: [], agentPaths: [] }, human);

      await expect(
        call('rooms.update', { roomId: channel.id, title: 'Payroll' })
      ).rejects.toMatchObject({ payload: { code: 'SLUG_TAKEN' } });

      const refusal = await call('rooms.update', { roomId: channel.id, title: 'Payroll' }).catch(
        (err: { payload?: { error?: string } }) => err.payload?.error ?? ''
      );
      expect(refusal).toContain('already taken');
      expect(refusal).not.toContain('payroll');
      // And the room kept the name it had, so the refusal was not half-applied.
      expect(service.getRoom(channel.id, human)?.title).toBe('Backend');
    });

    it('still names the holder to the owner when SHE renames onto a taken name', () => {
      // Same split as the create path: the owner sees every room on her machine,
      // so the cockpit's error keeps telling her which one took the name.
      const mine = service.createRoom(
        { kind: 'channel', title: 'Payroll', members: [], agentPaths: [] },
        human
      );

      expect(() => service.updateRoom(channel.id, human, { title: 'Payroll' })).toThrow('#payroll');
      expect(service.getRoom(mine.id, human)?.title).toBe('Payroll');
    });

    it('refuses renaming a direct message, and still writes its topic', async () => {
      // A DM's name IS its roster: it is derived from who is in it and
      // re-derived when that changes, so a title an agent writes there survives
      // only until the next membership change — and meanwhile it has renamed a
      // conversation belonging to whoever else is in it (orchestrator ruling on
      // the DOR-1611 review, spec §D12 amendment).
      const dm = (await call('rooms.create', { kind: 'dm', members: [human] })) as {
        roomId: string;
      };

      await expect(
        call('rooms.update', { roomId: dm.roomId, title: 'Renamed' })
      ).rejects.toMatchObject({ payload: { code: 'TOOL_RENAME_NOT_IN_DM' } });
      await expect(
        call('rooms.update', { roomId: dm.roomId, topic: 'what we are working on' })
      ).resolves.toMatchObject({ topic: 'what we are working on' });
    });

    it('lets an agent describe the home channel but not rename it', async () => {
      const { room } = service.ensureSystemChannel('team', { slug: 'team' }, human);
      service.addMember(room.id, human, { agentPath: '/agents/ana' });

      await expect(
        call('rooms.update', { roomId: room.id, topic: 'what we are all on' })
      ).resolves.toBeDefined();
      await expect(
        call('rooms.update', { roomId: room.id, title: 'Renamed' })
      ).rejects.toMatchObject({ payload: { code: 'SYSTEM_ROOM' } });
    });
  });

  describe('leave_room', () => {
    it('steps out of a channel', async () => {
      await expect(call('rooms.leave', { roomId: channel.id })).resolves.toMatchObject({
        left: true,
      });
      expect(service.getRoom(channel.id, human)?.members.map((m) => m.authorId)).not.toContain(ana);
    });

    it('refuses a direct message, which cannot be re-entered', async () => {
      const dm = (await call('rooms.create', { kind: 'dm', members: [] })) as { roomId: string };

      await expect(call('rooms.leave', { roomId: dm.roomId })).rejects.toMatchObject({
        payload: { code: 'TOOL_LEAVE_NOT_IN_DM' },
      });
    });

    it('refuses the home channel', async () => {
      const { room } = service.ensureSystemChannel('team', { slug: 'team' }, human);
      service.addMember(room.id, human, { agentPath: '/agents/ana' });

      await expect(call('rooms.leave', { roomId: room.id })).rejects.toMatchObject({
        payload: { code: 'SYSTEM_ROOM' },
      });
    });

    it('lets the last member empty an ordinary channel rather than wedging it', async () => {
      // Deliberately NOT refused (§D9). An empty channel is recoverable — the
      // row, its slug and its history survive and the owner can add members
      // back — where an agent stuck in a room it cannot leave is not.
      const own = service.createRoom(
        { kind: 'channel', title: 'Solo', members: [], agentPaths: [] },
        ana
      );

      await expect(call('rooms.leave', { roomId: own.id })).resolves.toMatchObject({ left: true });
      expect(service.getRoom(own.id, human)?.members).toEqual([]);
    });
  });

  describe('the grant', () => {
    it('refuses every management verb when the person has not turned it on', async () => {
      grantHeld = false;

      for (const [id, input] of [
        ['rooms.create', { kind: 'channel', title: 'Nope' }],
        ['rooms.add_members', { roomId: channel.id, members: ['@bo'] }],
        ['rooms.remove_members', { roomId: channel.id, members: ['@bo'] }],
        ['rooms.update', { roomId: channel.id, topic: 'nope' }],
        ['rooms.leave', { roomId: channel.id }],
      ] as const) {
        await expect(call(id, input), id).rejects.toMatchObject({
          decision: { payload: { reason: 'tool_group_disabled', approvable: false } },
        });
      }
      // Nothing ran: the room is exactly as it was.
      expect(service.getRoom(channel.id, human)?.members.map((m) => m.authorId)).toContain(ana);
    });

    it('leaves the CONVERSATION verbs reachable without it', async () => {
      // The grant covers arranging rooms and nothing else. An agent whose owner
      // has not armed it is not muted — which is the whole reason the
      // conversation verbs deliberately have no toggle.
      grantHeld = false;

      await expect(
        call('rooms.post', { roomId: channel.id, text: 'still here' })
      ).resolves.toMatchObject({ posted: true });
      await expect(call('rooms.get_room', { roomId: channel.id })).resolves.toBeDefined();
    });
  });
});

/**
 * What a management sequence COSTS, driven through the real trigger dispatcher
 * (spec `rooms-management-tools` §Testing, PR2).
 *
 * `create_room` makes rooms MINTABLE by an agent, and two properties of the room
 * path only became reachable from an agent's own hand when it landed. Neither is
 * a rule this work added — both are measurements of rules that were already
 * there, pinned here because the verb that reaches them is new:
 *
 * 1. **A sequence that looks like it starts a conversation does not always
 *    start one.** Whether the mention at the end of it triggers anybody depends
 *    entirely on whether the agent was mid-turn when it wrote — and nothing
 *    about the three calls says so.
 * 2. **Minting rooms does not mint budget.** The per-room cap is per ROOM, so a
 *    caller that can make rooms multiplies it; the install-wide cap is what
 *    makes "the ceiling on what this can cost you" true.
 *
 * Recorded rather than changed: the global cap's DEFAULT is explicitly out of
 * this spec's scope (decision D17).
 */
describe('what an armed agent can spend by making rooms', () => {
  /**
   * A wired install where Ana holds the grant and the owner is nameable.
   *
   * The handle matters: these verbs take `@handle` and nothing else, so an agent
   * cannot put the person in a room it opens until she has one — which is the
   * posture a login-on install is in, and the only one where a three-way-legal
   * room is reachable from `create_room` at all.
   *
   * @param opts.runner - The scripted runner this scenario needs.
   * @param opts.maxAutomaticTurnsPerRoomPerHour - The per-room spend cap.
   * @param opts.maxAutomaticTurnsTotalPerHour - The install-wide spend cap.
   * @returns The harness, plus a `call` that invokes as Ana.
   */
  function open(opts: {
    runner: ScriptedTurnRunner;
    maxAutomaticTurnsPerRoomPerHour?: number;
    maxAutomaticTurnsTotalPerHour?: number;
  }) {
    const harness = createRoomHarness({
      agents,
      runner: opts.runner,
      ...(opts.maxAutomaticTurnsPerRoomPerHour !== undefined
        ? { maxAutomaticTurnsPerRoomPerHour: opts.maxAutomaticTurnsPerRoomPerHour }
        : {}),
      ...(opts.maxAutomaticTurnsTotalPerHour !== undefined
        ? { maxAutomaticTurnsTotalPerHour: opts.maxAutomaticTurnsTotalPerHour }
        : {}),
    });
    const registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    harness.authors.setHandle(harness.human, 'dorian');
    return {
      ...harness,
      /** Call a tool as Ana, the way an identified agent would. */
      call: (id: string, input: unknown): Promise<unknown> =>
        registry.invoke(id, input, { identity: ANA_IDENTITY, retryChannel: 'mcp-argument' }),
      /** The `@handle` that reaches an agent, as `get_room` would report it. */
      handleOf: (agentPath: string, displayName: string): string => {
        const handle = harness.authors.resolveAgent(agentPath, displayName).handle;
        if (!handle) throw new Error(`${agentPath} has no handle`);
        return handle;
      },
      /**
       * The same handle as an ADDRESS, which is a different thing from a name.
       *
       * Handles are stored bare and the member verbs take them either way, but a
       * mention in a message body is resolved by `resolveAddressing` and needs
       * its sigil — text without one reaches nobody, which is exactly how a
       * cascade test can pass while measuring nothing.
       */
      mentionOf: (agentPath: string, displayName: string): string => {
        const handle = harness.authors.resolveAgent(agentPath, displayName).handle;
        if (!handle) throw new Error(`${agentPath} has no handle`);
        return `@${handle}`;
      },
    };
  }

  beforeEach(() => {
    installState.ownerId = null;
    installState.loginEnabled = false;
    resetToolGroupGate();
    initToolGroupGate({ grants: { holds: async () => true } });
  });

  afterEach(() => {
    resetToolGroupGate();
  });

  it('costs the colleague exactly one turn when the sequence runs inside a turn', async () => {
    // The provenance follows the TURN, so the mention Ana writes from inside one
    // inherits the cascade the person started and reaches Bo once. Nothing here
    // is new machinery — `writePost` has always read `activeTurnFor` — but until
    // `create_room` existed an agent could not assemble this sequence at all.
    let opened = '';
    let ranOnce = false;
    // The runner has to exist before the install it drives, and the sequence has
    // to know the install — so the runner calls through this, and the real
    // sequence is installed once there is something to call. Nothing runs it in
    // between: a turn only starts when the person posts, at the bottom.
    let duringTurn: (request: RoomTurnRequest) => Promise<void> = () => Promise.resolve();
    const runner = midTurnRunner((request) => duringTurn(request));
    const install = open({ runner });
    duringTurn = async (request) => {
      if (request.agentPath !== '/agents/ana' || ranOnce) return;
      ranOnce = true;
      const room = (await install.call('rooms.create', {
        kind: 'channel',
        title: 'Release work',
        members: ['@dorian'],
      })) as { roomId: string };
      opened = room.roomId;
      await install.call('rooms.add_members', {
        roomId: opened,
        members: [install.handleOf('/agents/bo', 'Bo')],
      });
      await install.call('rooms.post', {
        roomId: opened,
        text: `${install.mentionOf('/agents/bo', 'Bo')} can you take this one?`,
      });
    };
    const channel = install.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana'] },
      install.human
    );

    install.service.post(channel.id, {
      authorId: install.human,
      text: `${install.mentionOf('/agents/ana', 'Ana')} can you get Bo on this?`,
    });
    await install.service.triggersIdle();

    expect(opened).not.toBe('');
    expect(runner.turns.filter((turn) => turn.roomId === opened).map((t) => t.agentPath)).toEqual([
      '/agents/bo',
    ]);
  });

  it('triggers nobody when the same sequence runs with no turn in flight', async () => {
    // The identical three calls, from a shell. `deriveCascade` refuses a fresh
    // cascade to an un-provenanced agent post and stamps it AT the ceiling, so
    // the mention costs nothing and — unlike every other cascade refusal — says
    // nothing either. The discrimination is the point: this row and the one
    // above differ only in whether a turn was in flight, and they measure
    // opposite outcomes.
    const runner = scriptedRunner(() => null);
    const install = open({ runner });
    const room = (await install.call('rooms.create', {
      kind: 'channel',
      title: 'Release work',
      members: ['@dorian'],
    })) as { roomId: string };
    await install.call('rooms.add_members', {
      roomId: room.roomId,
      members: [install.handleOf('/agents/bo', 'Bo')],
    });

    await install.call('rooms.post', {
      roomId: room.roomId,
      text: `${install.mentionOf('/agents/bo', 'Bo')} can you take this one?`,
    });
    await install.service.triggersIdle();

    expect(runner.turns).toEqual([]);
    // And SILENTLY, which is the deliberate half. Every other cascade refusal
    // writes the room's own-voice notice; this one must not, because the entry
    // is its own cascade root and the refusal fires against every room-mate at
    // every ceiling — a notice here sprayed one line per member per post, and
    // offered to raise a limit nothing had reached (`room-trigger.ts`, the
    // DOR-621 note; `room-silence.test.ts` pins both sides of that narrowness).
    expect(
      install.service
        .listEntries(room.roomId, install.human, { limit: 50 })
        .map((entry) => entry.kind)
    ).toEqual(['post']);
  });

  it('does not buy one room-worth of turns per room it opens', async () => {
    // The measurement `turn-budget.ts` was written from, now reachable from an
    // agent's own hand: four rooms at a per-room cap of 1 would be four turns,
    // and the install-wide cap is what makes it two. Recorded, not fixed — the
    // cap's DEFAULT is out of this spec's scope (D17).
    const runner = scriptedRunner(() => null);
    const install = open({
      runner,
      maxAutomaticTurnsPerRoomPerHour: 1,
      maxAutomaticTurnsTotalPerHour: 2,
    });
    const mentionAna = `${install.mentionOf('/agents/ana', 'Ana')} ping`;

    const minted: string[] = [];
    for (const title of ['One', 'Two', 'Three', 'Four']) {
      const room = (await install.call('rooms.create', {
        kind: 'channel',
        title,
        members: ['@dorian'],
      })) as { roomId: string };
      minted.push(room.roomId);
    }
    // A PERSON writes in each, so every post starts a cascade of its own and
    // nothing but the budget is standing in the way.
    for (const roomId of minted) {
      install.service.post(roomId, { authorId: install.human, text: mentionAna });
    }
    await install.service.triggersIdle();

    expect(minted).toHaveLength(4);
    expect(runner.turns).toHaveLength(2);
  });
});
