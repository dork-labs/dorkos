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
import { describe, it, expect, beforeEach } from 'vitest';
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
  registeredAt: '2026-08-01T00:00:00.000Z',
  healthStatus: 'active',
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
      const previous = registry.resolveAgent('/Users/dorian/agents/ana', 'Ana');
      registry.setHandle(previous.id, 'ana');

      const { members } = await aggregateTeamRoster(
        sources({
          listAgents: () => [{ ...ANA, id: 'agent-ana-reinitialized' }],
          listAgentAuthors: () => registry.listActive('agent'),
        })
      );

      expect(members.find((m) => m.kind === 'agent')?.handle).toBeNull();
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

  it('carries neither projectPath nor namespace, because production cannot', async () => {
    // A hand-written fixture can claim any field it likes, so this one does not
    // write one: a REAL registry entry goes through the REAL `toManifest()` —
    // the exact strip `meshCore.listWithHealth()` applies — and whatever
    // survives is what the wire actually has. If the strip ever stops removing
    // these, this test goes red and the two "nothing production fills this"
    // comments stop being a claim nobody re-checked.
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
    // The premise: the registry itself DOES hold both fields, so their absence
    // downstream is the strip's doing and not an empty fixture.
    expect(mesh.listWithHealth()[0]).toMatchObject({
      projectPath: '/Users/dorian/agents/real',
      namespace: 'dorkos',
    });

    const { members } = await aggregateTeamRoster(sources({ listAgents: () => stripped }));
    const real = members.find((m) => m.id === 'agent-real');

    expect(real?.agent).toBeDefined();
    expect(real?.agent?.projectPath).toBeUndefined();
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
