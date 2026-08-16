/**
 * The roster's composition and its per-source degradation (spec
 * `identity-consistency` §W2.2, ADR 260806-222535).
 *
 * The `authors` half runs against a real `AuthorRegistry` over a real SQLite
 * database rather than a stub, because two of the invariants under test are
 * properties of the QUERY and not of the projection: an agent's author row must
 * not also appear as a person, and the operator must be found by the same
 * `isOwner` predicate the rooms domain uses. A fake `listPeople` would satisfy
 * both by construction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, authors, eq, type Db } from '@dorkos/db';
import { AgentRegistry, toManifest } from '@dorkos/mesh';
import { TeamRosterResponseSchema } from '@dorkos/shared/team-schemas';
import { AuthorRegistry } from '../../rooms/author-registry.js';
import {
  aggregateTeamRoster,
  type TeamAgentSource,
  type TeamRosterSources,
} from '../aggregate-team.js';

const OWNER_USER_ID = 'user-1';

/** Where Ana lives — the directory her sessions and her claims are keyed on. */
const ANA_PATH = '/Users/dorian/agents/ana';

/** Ana — an ordinary registered agent. */
const ANA: TeamAgentSource = {
  id: 'agent-ana',
  name: 'ana',
  displayName: 'Ana',
  runtime: 'claude-code',
  model: 'opus',
  icon: '🤖',
  color: '#6366f1',
  namespace: 'dorkos',
  projectPath: ANA_PATH,
  registeredAt: '2026-08-01T00:00:00.000Z',
  healthStatus: 'active',
  lastSeenAt: '2026-08-10T12:00:00.000Z',
};

/** DorkBot — the system agent, which belongs to the install and not to a person. */
const DORKBOT: TeamAgentSource = {
  id: 'agent-dorkbot',
  name: 'dorkbot',
  displayName: 'DorkBot',
  runtime: 'claude-code',
  isSystem: true,
  registeredAt: '2026-07-01T00:00:00.000Z',
  healthStatus: 'stale',
};

describe('aggregateTeamRoster', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let ownerAuthorId: string;

  /** The wiring `routes/team.ts` does, with the two registries injected. */
  function sources(overrides: Partial<TeamRosterSources> = {}): TeamRosterSources {
    return {
      listPeople: () => registry.listActive('human'),
      listAgentAuthors: () => [],
      listAgents: () => [ANA, DORKBOT],
      listClaims: () => [],
      listRooms: () => [],
      sessionActivity: () => ({}),
      account: () => ({ id: OWNER_USER_ID, name: 'Dorian', email: 'dorian@dorkos.ai' }),
      configDisplayName: () => null,
      defaultAgentName: () => 'ana',
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    // What `index.ts` does at boot: the operator's author, bound to the owner
    // account. Nothing in the roster path mints one.
    ownerAuthorId = registry.bindOwner(OWNER_USER_ID).id;
    // An agent's author row exists too — a room needs one to attribute posts.
    registry.resolveAgent('/Users/dorian/agents/ana', 'Ana');
  });

  it('returns a payload the response schema accepts', async () => {
    const roster = await aggregateTeamRoster(sources());
    expect(TeamRosterResponseSchema.safeParse(roster).success).toBe(true);
  });

  describe('handles', () => {
    /**
     * The mesh cache row the fleet fixture stands for.
     *
     * Written only here: it is what stamps an author with the occupancy the
     * roster joins on, so these tests exercise the registry that ships rather
     * than a fixture id — and the test that asserts what the mesh STRIPS keeps
     * a table holding only its own agent.
     */
    function registerInMesh(id: string, projectPath: string): void {
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id,
          name: 'ana',
          displayName: 'Ana',
          runtime: 'claude-code',
          projectPath,
          registeredAt: now,
          updatedAt: now,
        })
        .run();
    }

    it('reads a person’s handle straight off their author row', async () => {
      // Before it is asked for, the operator's handle is null — which the page
      // renders as "no address yet" rather than inventing `@you`.
      const before = await aggregateTeamRoster(sources());
      expect(before.members.find((m) => m.isSelf)?.handle).toBeNull();

      registry.setHandle(ownerAuthorId, 'dorian');

      const after = await aggregateTeamRoster(sources());
      expect(after.members.find((m) => m.isSelf)?.handle).toBe('dorian');
    });

    it('joins an agent to its author row on the occupancy stamp', async () => {
      // An agent's handle lives on its AUTHOR row, minted the first time it is
      // in a room, and the mesh source carries no directory to join on —
      // `toManifest()` strips `projectPath` before the fleet reaches here. The
      // manifest ULID is what both sides do carry.
      registerInMesh(ANA.id, '/Users/dorian/agents/ana');
      const anaAuthor = registry.resolveAgent('/Users/dorian/agents/ana', 'Ana');
      registry.setHandle(anaAuthor.id, 'ana');

      const { members } = await aggregateTeamRoster(
        sources({ listAgentAuthors: () => registry.listActive('agent') })
      );

      expect(members.find((m) => m.id === ANA.id)?.handle).toBe('ana');
      // DorkBot has never been in a room, so it has no author row and no
      // address — reported honestly rather than guessed from its name.
      expect(members.find((m) => m.id === DORKBOT.id)?.handle).toBeNull();
    });

    it('does not inherit an address from a previous occupant of the same directory', async () => {
      // The generation boundary the author registry already draws: a new agent
      // registered where an old one lived is a different entity, so it must not
      // answer to the name people remember.
      registerInMesh(ANA.id, '/Users/dorian/agents/ana');
      const previous = registry.resolve({
        kind: 'agent',
        naturalKey: '/Users/dorian/agents/ana',
        displayName: 'Ana',
        // The face is inherited by exactly the same join as the address, so it
        // has to be seeded here or the assertion below passes on an empty row
        // and proves nothing about the photo.
        imageUrl: '/api/profile/avatar/ana?v=one',
      });
      registry.setHandle(previous.id, 'ana');

      const { members } = await aggregateTeamRoster(
        sources({
          listAgents: () => [{ ...ANA, id: 'agent-ana-reinitialized' }],
          listAgentAuthors: () => registry.listActive('agent'),
        })
      );

      const successor = members.find((m) => m.kind === 'agent');
      expect(successor?.handle).toBeNull();
      // And it does not wear the previous occupant's face either. Both ride the
      // occupancy stamp, so a join that widened to "any author at this
      // directory" would hand over the name AND the photo together.
      expect(successor?.imageUrl).toBeUndefined();
    });
  });

  describe('photos', () => {
    it("carries a person's photo off their author row, beside their emoji and colour", async () => {
      const before = await aggregateTeamRoster(sources());
      expect(before.members.find((m) => m.isSelf)?.imageUrl).toBeUndefined();

      registry.resolve({
        kind: 'human',
        naturalKey: `user:${OWNER_USER_ID}`,
        displayName: 'You',
        imageUrl: '/api/profile/avatar/me?v=one',
      });

      const after = await aggregateTeamRoster(sources());
      expect(after.members.find((m) => m.isSelf)?.imageUrl).toBe('/api/profile/avatar/me?v=one');
    });

    it("carries an agent's photo off the same author row its handle comes from", async () => {
      // The join already exists for the address; the photo rides it rather than
      // taking a second route that could disagree. Agents have no photo today —
      // their identity language is emoji and colour — and the field is here so
      // one CAN be given a photo without a schema change.
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: ANA.id,
          name: 'ana',
          displayName: 'Ana',
          runtime: 'claude-code',
          projectPath: '/Users/dorian/agents/ana',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      registry.resolve({
        kind: 'agent',
        naturalKey: '/Users/dorian/agents/ana',
        displayName: 'Ana',
        imageUrl: '/api/profile/avatar/ana?v=one',
      });

      const { members } = await aggregateTeamRoster(
        sources({ listAgentAuthors: () => registry.listActive('agent') })
      );

      expect(members.find((m) => m.id === ANA.id)?.imageUrl).toBe('/api/profile/avatar/ana?v=one');
      // And an agent with no author row at all still renders, with no photo.
      expect(members.find((m) => m.id === DORKBOT.id)?.imageUrl).toBeUndefined();
    });
  });

  it('puts exactly one person on the roster, and it is the operator', async () => {
    const { members } = await aggregateTeamRoster(sources());
    const people = members.filter((m) => m.kind === 'human');

    expect(people).toHaveLength(1);
    expect(people[0]?.id).toBe(ownerAuthorId);
    expect(people[0]?.isSelf).toBe(true);
    expect(members.filter((m) => m.isSelf)).toHaveLength(1);
  });

  it('does not turn an agent author row into a second person', async () => {
    const { members } = await aggregateTeamRoster(sources({ listAgents: () => [] }));
    expect(members).toHaveLength(1);
    expect(members[0]?.kind).toBe('human');
  });

  it('renders the operator first even when they were minted LAST', async () => {
    // The case that makes the sort load-bearing rather than decorative.
    // `listActive` orders by `created_at`, and a bridged group that saw traffic
    // before login was enabled leaves an external person on the table BEFORE the
    // owner's row exists. Without the sort, the roster opens on a stranger.
    const priya = registry.resolveExternal({
      platformType: 'telegram',
      instanceId: 'inst-1',
      platformUserId: 'tg-9',
      displayName: 'Priya',
    });
    db.update(authors)
      .set({ createdAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(authors.id, priya.id))
      .run();

    // The premise, asserted rather than assumed: the table really does hand the
    // stranger over first, so the sort is the only thing that can fix the order.
    expect(registry.listActive('human')[0]?.id).toBe(priya.id);

    const { members } = await aggregateTeamRoster(sources());
    expect(members[0]?.isSelf).toBe(true);
    expect(members[0]?.id).toBe(ownerAuthorId);
    expect(members[1]?.displayName).toBe('Priya');
  });

  it('carries one row per registered agent, with its facts', async () => {
    const { members } = await aggregateTeamRoster(sources());
    const ana = members.find((m) => m.id === 'agent-ana');

    expect(members.filter((m) => m.kind === 'agent')).toHaveLength(2);
    expect(ana?.displayName).toBe('Ana');
    expect(ana?.emoji).toBe('🤖');
    expect(ana?.origin).toBe('local');
    expect(ana?.agent).toMatchObject({
      manifestId: 'agent-ana',
      runtime: 'claude-code',
      model: 'opus',
      healthStatus: 'active',
      recentlyActive: true,
      isDefault: true,
      isSystem: false,
    });
  });

  it('reads `recentlyActive` off the mesh health status rather than assuming it', async () => {
    const { members } = await aggregateTeamRoster(sources());
    expect(members.find((m) => m.id === 'agent-dorkbot')?.agent?.recentlyActive).toBe(false);
  });

  describe('activity (spec `profile-unification` §3.1)', () => {
    /**
     * Ana's author row, stamped with her mesh occupancy — the join a claim
     * arrives on. Claims are keyed by AUTHOR id, and an agent's author row is
     * minted the first time it is in a room, so this is the whole path from
     * "the dispatcher says author X is working" to "Ana is working".
     */
    function mintAnaAuthor(): string {
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: ANA.id,
          name: 'ana',
          displayName: 'Ana',
          runtime: 'claude-code',
          projectPath: ANA_PATH,
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      return registry.resolveAgent(ANA_PATH, 'Ana').id;
    }

    /** Sources with Ana's author row joined, as production always has it. */
    function withAuthors(overrides: Partial<TeamRosterSources> = {}): TeamRosterSources {
      return sources({ listAgentAuthors: () => registry.listActive('agent'), ...overrides });
    }

    it('says which room an agent is working in, and since when', async () => {
      const authorId = mintAnaAuthor();

      const { members } = await aggregateTeamRoster(
        withAuthors({
          listClaims: () => [{ roomId: 'room-1', authorId, claimedAt: '2026-08-16T10:00:00.000Z' }],
          listRooms: () => [{ id: 'room-1', name: 'team' }],
        })
      );

      expect(members.find((m) => m.id === ANA.id)?.agent?.activity.working).toEqual({
        roomId: 'room-1',
        roomName: 'team',
        since: '2026-08-16T10:00:00.000Z',
      });
      // A claim held by one agent is not a claim held by another.
      expect(members.find((m) => m.id === DORKBOT.id)?.agent?.activity.working).toBeNull();
    });

    it('still reports the work when the room cannot be named', async () => {
      // The label is the part that degrades, never the fact: "Working · 5 min"
      // is honest; silence would not be.
      const authorId = mintAnaAuthor();

      const { members } = await aggregateTeamRoster(
        withAuthors({
          listClaims: () => [
            { roomId: 'room-gone', authorId, claimedAt: '2026-08-16T10:00:00.000Z' },
          ],
          listRooms: () => {
            throw new Error('rooms table unreadable');
          },
        })
      );

      expect(members.find((m) => m.id === ANA.id)?.agent?.activity.working).toMatchObject({
        roomId: 'room-gone',
        roomName: null,
      });
    });

    it('does not read the rooms at all when nothing is working', async () => {
      // The read exists to name a claim. On the install this endpoint mostly
      // serves there are none, and listing every room to name none of them is
      // cost nobody asked for.
      const listRooms = vi.fn(() => []);
      await aggregateTeamRoster(sources({ listRooms }));
      expect(listRooms).not.toHaveBeenCalled();
    });

    it('ignores a claim held by an author no agent on this roster answers to', async () => {
      // The author registry has rows the mesh does not — a person, a retired
      // agent's row, an agent registered on another machine. None of them make
      // one of THESE agents working.
      mintAnaAuthor();
      const { members } = await aggregateTeamRoster(
        withAuthors({
          listClaims: () => [
            { roomId: 'room-1', authorId: ownerAuthorId, claimedAt: '2026-08-16T10:00:00.000Z' },
          ],
          listRooms: () => [{ id: 'room-1', name: 'team' }],
        })
      );

      for (const agent of members.filter((m) => m.kind === 'agent')) {
        expect(agent.agent?.activity.working).toBeNull();
      }
    });

    it('keeps the claim it has held longest when an agent somehow holds two', async () => {
      // Unreachable today — the second claim ceiling is the agent's directory,
      // so a turn in one room refuses a trigger in every other. Pinned anyway,
      // because "whichever the map iterated first" would make two reads of the
      // same state disagree.
      const authorId = mintAnaAuthor();
      const { members } = await aggregateTeamRoster(
        withAuthors({
          listClaims: () => [
            { roomId: 'room-late', authorId, claimedAt: '2026-08-16T10:05:00.000Z' },
            { roomId: 'room-early', authorId, claimedAt: '2026-08-16T10:00:00.000Z' },
          ],
          listRooms: () => [
            { id: 'room-late', name: 'late' },
            { id: 'room-early', name: 'early' },
          ],
        })
      );

      expect(members.find((m) => m.id === ANA.id)?.agent?.activity.working?.roomId).toBe(
        'room-early'
      );
    });

    it('dates an idle agent by the later of the mesh and its newest session', async () => {
      const { members } = await aggregateTeamRoster(
        sources({ sessionActivity: () => ({ [ANA_PATH]: '2026-08-11T09:00:00.000Z' }) })
      );

      // The mesh last heard from Ana on the 10th; a session of hers was touched
      // on the 11th. The 11th is the honest answer — and only the session read
      // knows it, because mesh health is stamped by the claude-code turn paths
      // alone.
      expect(members.find((m) => m.id === ANA.id)?.agent?.activity).toEqual({
        working: null,
        lastActiveAt: '2026-08-11T09:00:00.000Z',
      });
    });

    it('keeps the mesh stamp when it is the later of the two', async () => {
      const { members } = await aggregateTeamRoster(
        sources({ sessionActivity: () => ({ [ANA_PATH]: '2026-08-01T09:00:00.000Z' }) })
      );

      expect(members.find((m) => m.id === ANA.id)?.agent?.activity.lastActiveAt).toBe(
        ANA.lastSeenAt
      );
    });

    it('says nothing rather than something for an agent that has never run', async () => {
      // DorkBot: no mesh stamp, no session, no claim. Both members null is the
      // state the header renders as "Hasn't run yet" — which is a different
      // sentence from "idle", and only distinguishable because neither half is
      // faked.
      const { members } = await aggregateTeamRoster(sources());

      expect(members.find((m) => m.id === DORKBOT.id)?.agent?.activity).toEqual({
        working: null,
        lastActiveAt: null,
      });
    });

    it('does not date an agent by a session belonging to another directory', async () => {
      const { members } = await aggregateTeamRoster(
        sources({
          listAgents: () => [{ ...ANA, lastSeenAt: null }],
          sessionActivity: () => ({
            '/Users/dorian/agents/someone-else': '2026-08-11T09:00:00.000Z',
          }),
        })
      );

      expect(members.find((m) => m.id === ANA.id)?.agent?.activity.lastActiveAt).toBeNull();
    });

    it('degrades a failing claims read into a warning, never a failed roster', async () => {
      const roster = await aggregateTeamRoster(
        withAuthors({
          listClaims: () => {
            throw new Error('dispatcher unavailable');
          },
        })
      );

      expect(roster.members).toHaveLength(3);
      expect(roster.members.find((m) => m.id === ANA.id)?.agent?.activity.working).toBeNull();
      expect(roster.warnings).toEqual([{ source: 'claims', message: 'dispatcher unavailable' }]);
    });

    it('degrades a failing session read to the mesh stamp alone', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          sessionActivity: () => {
            throw new Error('runtimes unavailable');
          },
        })
      );

      expect(roster.members.find((m) => m.id === ANA.id)?.agent?.activity.lastActiveAt).toBe(
        ANA.lastSeenAt
      );
      expect(roster.warnings).toEqual([{ source: 'sessions', message: 'runtimes unavailable' }]);
    });

    it('stamps the operator as here now, and refuses to guess for anyone else', async () => {
      const before = Date.now();
      registry.resolveExternal({
        platformType: 'telegram',
        instanceId: 'inst-1',
        platformUserId: 'tg-9',
        displayName: 'Priya',
      });

      const { members } = await aggregateTeamRoster(sources());

      const self = members.find((m) => m.isSelf);
      expect(Date.parse(self?.person?.lastSeenAt ?? '')).toBeGreaterThanOrEqual(before);
      // Nothing on this install dates a bridged person's presence, and the
      // roster says so rather than reporting the moment it was read.
      expect(members.find((m) => m.displayName === 'Priya')?.person?.lastSeenAt).toBeNull();
    });
  });

  it('carries the projectPath production joins back, and never the namespace', async () => {
    // A hand-written fixture can claim any field it likes, so this one does not
    // write one: a REAL registry entry goes through the REAL `toManifest()` —
    // the exact strip `meshCore.listWithHealth()` applies — and then through the
    // REAL paths join `routes/team.ts` does on top of it. What survives is what
    // the wire actually has. If the strip ever stops removing the namespace, or
    // the join ever stops restoring the path, this test goes red.
    const mesh = new AgentRegistry(db);
    mesh.upsert({
      id: 'agent-real',
      name: 'real',
      displayName: 'Real',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      personaEnabled: true,
      enabledToolGroups: {},
      mcpServers: [],
      registeredAt: '2026-08-01T00:00:00.000Z',
      registeredBy: 'test',
      projectPath: '/Users/dorian/agents/real',
      namespace: 'dorkos',
      scanRoot: '/Users/dorian/agents',
    });

    const stripped = mesh.listWithHealth().map((entry) => toManifest(entry));
    // The premise: the registry itself DOES hold both fields, so whatever is
    // missing downstream is the strip's doing and not an empty fixture.
    expect(mesh.listWithHealth()[0]).toMatchObject({
      projectPath: '/Users/dorian/agents/real',
      namespace: 'dorkos',
    });
    // The strip really did take both — including the one the route puts back.
    expect(stripped[0]).not.toHaveProperty('projectPath');
    expect(stripped[0]).not.toHaveProperty('namespace');

    // What `routes/team.ts` composes: the public listing, with the registry's
    // own paths joined back on by id.
    const pathById = new Map(mesh.list().map((entry) => [entry.id, entry.projectPath]));
    const joined = stripped.map((agent) => ({ ...agent, projectPath: pathById.get(agent.id)! }));

    const { members } = await aggregateTeamRoster(sources({ listAgents: () => joined }));
    const real = members.find((m) => m.id === 'agent-real');

    expect(real?.agent).toBeDefined();
    expect(real?.agent?.projectPath).toBe('/Users/dorian/agents/real');
    expect(real?.agent?.namespace).toBeUndefined();
  });

  it('attributes every non-system agent to the operator and DorkBot to nobody', async () => {
    const { members } = await aggregateTeamRoster(sources());

    expect(members.find((m) => m.id === 'agent-ana')?.ownerId).toBe(ownerAuthorId);
    expect(members.find((m) => m.id === 'agent-dorkbot')?.ownerId).toBeNull();
    // Nothing owns a person.
    expect(members.find((m) => m.id === ownerAuthorId)?.ownerId).toBeNull();
  });

  it('omits `warnings` entirely on a clean read', async () => {
    const roster = await aggregateTeamRoster(sources());
    expect(roster.warnings).toBeUndefined();
    expect('warnings' in roster).toBe(false);
  });

  it('carries the operator email on the self row and on nobody else', async () => {
    registry.resolveExternal({
      platformType: 'telegram',
      instanceId: 'inst-1',
      platformUserId: 'tg-9',
      displayName: 'Priya',
    });
    const { members } = await aggregateTeamRoster(sources());

    expect(members.find((m) => m.isSelf)?.person?.email).toBe('dorian@dorkos.ai');
    for (const member of members.filter((m) => !m.isSelf)) {
      expect(member.person?.email).toBeUndefined();
    }
  });

  it('keeps a person from outside this machine in the same shape', async () => {
    registry.resolveExternal({
      platformType: 'telegram',
      instanceId: 'inst-1',
      platformUserId: 'tg-9',
      displayName: 'Priya',
    });
    const { members } = await aggregateTeamRoster(sources());
    const priya = members.find((m) => m.displayName === 'Priya');

    expect(priya?.origin).toEqual({ platform: 'telegram' });
    expect(priya?.isSelf).toBe(false);
    expect(priya?.ownerId).toBeNull();
  });

  describe('a fresh install that has never had an account', () => {
    // THE most common state this endpoint serves, and the one every other
    // fixture skips by calling `bindOwner`: nobody has enabled login, so the
    // only human row is the `'local'` sentinel `localHuman()` minted.
    let sentinelId: string;

    beforeEach(() => {
      db = createTestDb();
      registry = new AuthorRegistry(db);
      sentinelId = registry.localHuman().id;
    });

    /** No account anywhere — not in the DB, not in config. */
    function freshSources(): TeamRosterSources {
      return {
        listPeople: () => registry.listActive('human'),
        listAgentAuthors: () => [],
        listAgents: () => [ANA, DORKBOT],
        listClaims: () => [],
        listRooms: () => [],
        sessionActivity: () => ({}),
        account: () => null,
        configDisplayName: () => null,
        defaultAgentName: () => 'ana',
      };
    }

    it('still knows the sentinel is you', async () => {
      const { members } = await aggregateTeamRoster(freshSources());
      const self = members.find((m) => m.isSelf);

      expect(self?.id).toBe(sentinelId);
      // Nothing on this install knows a real name yet, so the last rung of the
      // precedence is reached and the stored literal is the honest answer.
      expect(self?.displayName).toBe('You');
      expect(self?.person?.email).toBeUndefined();
    });

    it('still attributes the agents to that person', async () => {
      const { members } = await aggregateTeamRoster(freshSources());

      expect(members.find((m) => m.id === 'agent-ana')?.ownerId).toBe(sentinelId);
      expect(members.find((m) => m.id === 'agent-dorkbot')?.ownerId).toBeNull();
    });

    it('uses the profile name once the user has set one, without an account', async () => {
      const { members } = await aggregateTeamRoster({
        ...freshSources(),
        configDisplayName: () => 'Dorian',
      });
      expect(members.find((m) => m.isSelf)?.displayName).toBe('Dorian');
    });
  });

  describe('per-source degradation (ADR-0310)', () => {
    it('keeps the people when the mesh read fails', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          listAgents: () => {
            throw new Error('mesh registry unavailable');
          },
        })
      );

      expect(roster.members.filter((m) => m.kind === 'human')).toHaveLength(1);
      expect(roster.members.filter((m) => m.kind === 'agent')).toHaveLength(0);
      expect(roster.warnings).toEqual([{ source: 'agents', message: 'mesh registry unavailable' }]);
    });

    it('keeps the agents when the author read fails, and owns them to nobody', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          listPeople: () => {
            throw new Error('authors table unreadable');
          },
        })
      );

      expect(roster.members.filter((m) => m.kind === 'agent')).toHaveLength(2);
      expect(roster.members.filter((m) => m.kind === 'human')).toHaveLength(0);
      // No operator row in this roster's id space, so no dangling reference to it.
      for (const agent of roster.members) expect(agent.ownerId).toBeNull();
      expect(roster.warnings?.[0]?.source).toBe('authors');
    });

    it('reports both sources when both fail, and still answers', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          listPeople: () => {
            throw new Error('authors down');
          },
          listAgents: () => {
            throw new Error('mesh down');
          },
        })
      );

      expect(roster.members).toEqual([]);
      expect(roster.warnings?.map((w) => w.source)).toEqual(['authors', 'agents']);
    });

    it('degrades the operator NAME, not the roster, when the account read fails', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          account: () => {
            throw new Error('account lookup failed');
          },
        })
      );

      // Every row still there — that is the whole point.
      expect(roster.members).toHaveLength(3);
      expect(roster.members.filter((m) => m.kind === 'agent')).toHaveLength(2);
      expect(roster.warnings).toEqual([{ source: 'operator', message: 'account lookup failed' }]);
    });

    it('keeps the roster when the config read fails, losing only what config knew', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          configDisplayName: () => {
            throw new Error('config unreadable');
          },
          defaultAgentName: () => {
            throw new Error('config unreadable');
          },
        })
      );

      expect(roster.members).toHaveLength(3);
      // The account name still wins the precedence — config was only rung two.
      expect(roster.members.find((m) => m.isSelf)?.displayName).toBe('Dorian');
      // ...and the only casualty is the default-agent mark.
      expect(roster.members.find((m) => m.id === 'agent-ana')?.agent?.isDefault).toBe(false);
      expect(roster.warnings?.every((w) => w.source === 'config')).toBe(true);
    });

    it('degrades a source that exceeds its budget instead of hanging', async () => {
      const roster = await aggregateTeamRoster(
        sources({
          listAgents: () => new Promise(() => {}),
          timeoutMs: 10,
        })
      );

      expect(roster.members.filter((m) => m.kind === 'human')).toHaveLength(1);
      expect(roster.warnings?.[0]?.source).toBe('agents');
      expect(roster.warnings?.[0]?.message).toContain('timed out');
    });
  });
});
