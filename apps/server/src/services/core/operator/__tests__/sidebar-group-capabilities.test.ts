/**
 * The two targeted sidebar-section capabilities, against a real `ConfigManager`
 * over a real temp data directory (DOR-2055).
 *
 * ## What these are actually asking
 *
 * The defect is not "an agent could not change the sidebar" — it could, through
 * `config_patch`. The defect is that the only available shape was re-sending the
 * WHOLE `ui.sidebar.groups` array, so a correct-looking call could destroy
 * sections nobody mentioned and overwrite a drag the person made mid-turn. So
 * the assertions that matter are about what a call leaves ALONE: a section
 * changes only when this call moved a member into or out of it, and the write
 * carries nothing but `ui.sidebar`.
 *
 * Membership is single-parent, so filing something that already sits elsewhere
 * is a MOVE — the section it left is the one other section a call may change,
 * and it must lose the member and nothing else.
 *
 * The guarded write is wrapped rather than mocked — the real function runs, and
 * the wrapper only records what it was handed — so "the patch names one section
 * of config" is checked against the argument the production code actually built,
 * not against a stand-in.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SidebarGroupSchema, type SidebarGroup } from '@dorkos/shared/config-schema';
import type { ConfigManager } from '../../config-manager.js';
import type { GuardedConfigWrite } from '../config-write.js';
import type { OperatorToolResult } from '../operator-tool-handlers.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { SidebarItemRefInput } from '../sidebar-item-refs.js';
import type { CapabilityHandlerContext } from '../../capabilities/registry.js';

/** Every guarded write the handlers made, in order, as production built it. */
const { writes } = vi.hoisted(() => ({ writes: [] as GuardedConfigWrite[] }));

vi.mock('../config-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config-write.js')>();
  return {
    ...actual,
    applyGuardedConfigWrite: (write: GuardedConfigWrite) => {
      writes.push(write);
      return actual.applyGuardedConfigWrite(write);
    },
  };
});

/** A hand-sorted section with the schema's own defaults, overridden as needed. */
function group(over: Partial<SidebarGroup> & Pick<SidebarGroup, 'id' | 'name'>): SidebarGroup {
  return { ...SidebarGroupSchema.parse({ id: over.id, name: over.name }), ...over };
}

// The STORED shape, which is what every assertion about the config compares
// against. A caller never sends these — it sends a name, an id or a path, and
// the handler resolves it to exactly this (`sidebar-item-refs.ts`).
const AGENT_A = { kind: 'agent', path: '/projects/alpha' } as const;
const AGENT_B = { kind: 'agent', path: '/projects/beta' } as const;
const AGENT_C = { kind: 'agent', path: '/projects/gamma' } as const;
const ROOM = { kind: 'room', roomId: '01JROOM' } as const;
/** A room in no section at all, so filing it can move nothing. */
const LOOSE_ROOM = { kind: 'room', roomId: '01JROOM2' } as const;

/**
 * The roster the handlers resolve against: three agents and two open rooms,
 * matching the fixtures above so a test can name any of them the way a model
 * would.
 */
const ROSTER_AGENTS = [
  {
    id: '01JAGENTALPHA',
    name: 'alpha',
    displayName: 'Alpha Scout',
    projectPath: '/projects/alpha',
  },
  { id: '01JAGENTBETA', name: 'beta', projectPath: '/projects/beta' },
  { id: '01JAGENTGAMMA', name: 'gamma', displayName: 'Gamma', projectPath: '/projects/gamma' },
];

const ROSTER_ROOMS = [
  { roomId: '01JROOM', name: 'Lab notes', slug: 'lab' },
  { roomId: '01JROOM2', name: 'General', slug: 'general' },
];

/**
 * A room the caller in these tests is NOT in — the operator's private DM.
 *
 * It is never in any roster this file hands a handler, because the production
 * seam hands each caller only the rooms that caller can see
 * (`RoomService.listRooms` behind `callerAuthor`). Naming it is how the leak
 * tests below ask "can an agent learn this exists?".
 */
const UNSEEN_DM = { roomId: '01JPRIVATEDM', name: 'Dorian and Scout', slug: null };

/**
 * Tool deps carrying just the two rosters a reference is checked against.
 *
 * `listOperatorRooms` is a FUNCTION here as it is in production, because the
 * handler calls it per invocation — a room archived between two calls has to
 * disappear from the answer.
 */
function deps(over: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    meshCore: { listWithPaths: () => ROSTER_AGENTS } as unknown as McpToolDeps['meshCore'],
    listVisibleRooms: () => [...ROSTER_ROOMS],
    ...over,
  } as McpToolDeps;
}

/** An agent principal, as the registry resolves one onto the caller context. */
const AGENT_IDENTITY = {
  agentId: '01JAGENTBETA',
  agentPath: '/projects/beta',
  displayName: 'beta',
} as unknown as NonNullable<CapabilityHandlerContext['identity']>;

/** A caller context, as the registry hands one to `invoke`. */
function caller(over: Partial<CapabilityHandlerContext> = {}): CapabilityHandlerContext {
  return over;
}

describe('the sidebar-section capabilities', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let addToGroup: ReturnType<
    typeof import('../operator-tool-handlers.js').createSidebarAddToGroupHandler
  >;
  let removeFromGroup: ReturnType<
    typeof import('../operator-tool-handlers.js').createSidebarRemoveFromGroupHandler
  >;

  /** The two modules under test, imported once — see the note on `beforeAll`. */
  let handlers: typeof import('../operator-tool-handlers.js');
  let initConfigManager: typeof import('../../config-manager.js').initConfigManager;

  // Imported ONCE rather than per test. The handler factories capture only their
  // deps and the caller identity; the config store is read through the live
  // `configManager` binding at call time, so a handler built here still sees the
  // store each test initializes below.
  //
  // The explicit timeout is not padding for slow code. This graph reaches
  // `config-manager.ts` and the session fan-out, and this repo is routinely
  // several agents deep on one machine — the import measured 1.3s idle and blew
  // the 10s default at load average 388. A hook that fails on how busy the
  // machine is tells you nothing about the code, so it gets a budget it cannot
  // lose to a neighbour.
  beforeAll(async () => {
    handlers = await import('../operator-tool-handlers.js');
    initConfigManager = (await import('../../config-manager.js')).initConfigManager;
  }, 60_000);

  beforeEach(() => {
    writes.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-sidebar-groups-'));
    process.env.DORK_HOME = tmpDir;
    configManager = initConfigManager(tmpDir);
    addToGroup = handlers.createSidebarAddToGroupHandler(deps(), caller());
    removeFromGroup = handlers.createSidebarRemoveFromGroupHandler(deps(), caller());
  });

  // Deliberately NO `vi.resetModules()`. The mock factory's result is cached
  // across a module reset, so a reset would leave the wrapper holding the
  // previous test's `ConfigManager` while the handlers read the new one, and
  // every write after the first would land in a deleted temp directory.
  // Re-initializing is enough on its own: `configManager` is an `export let`, so
  // `initConfigManager` swaps the store for every module that reads the binding.
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Store these sections, bypassing the write path under test. */
  function seed(groups: SidebarGroup[]): void {
    const ui = configManager.get('ui');
    configManager.set('ui', { ...ui, sidebar: { ...ui.sidebar, groups } });
  }

  /** The sections as stored right now. */
  function storedGroups(): SidebarGroup[] {
    return configManager.get('ui').sidebar.groups;
  }

  /** One section by id, or `undefined`. */
  function stored(id: string): SidebarGroup | undefined {
    return storedGroups().find((g) => g.id === id);
  }

  /** The JSON payload a handler answered with, and whether it was an error. */
  async function call(
    run: Promise<OperatorToolResult>
  ): Promise<{ isError: boolean; body: Record<string, unknown> }> {
    const result = await run;
    return {
      isError: result.isError === true,
      body: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    };
  }

  const THREE_SECTIONS = (): SidebarGroup[] => [
    group({ id: 'g-clients', name: 'Clients', items: [AGENT_C] }),
    group({ id: 'g-dorkos', name: 'DorkOS', items: [AGENT_A] }),
    group({ id: 'g-lab', name: 'Lab', items: [ROOM], collapsed: true, sortMode: 'name' }),
  ];

  describe('add', () => {
    it('files what is missing, skips what is already there, and leaves the others byte-identical', async () => {
      seed(THREE_SECTIONS());
      const before = JSON.stringify(storedGroups().filter((g) => g.id !== 'g-dorkos'));

      // Three items, one of which ("alpha") is already filed there — the exact
      // shape of the call that started this: DorkBot asked to add three agents
      // to "DorkOS" and had to re-send every section to do it. None of the three
      // lives in another section, so this call may move nothing.
      const { isError, body } = await call(
        addToGroup({ group: 'DorkOS', items: [AGENT_A, AGENT_B, LOOSE_ROOM] })
      );

      expect(isError).toBe(false);
      expect(stored('g-dorkos')!.items).toEqual([AGENT_A, AGENT_B, LOOSE_ROOM]);
      expect(body.added).toEqual([AGENT_B, LOOSE_ROOM]);
      expect(body.alreadyPresent).toEqual([AGENT_A]);
      expect(body.created).toBe(false);
      expect(body.movedFrom).toEqual([]);
      // The whole point: the two sections nobody named are the same bytes.
      expect(JSON.stringify(storedGroups().filter((g) => g.id !== 'g-dorkos'))).toBe(before);
      // …and their ORDER did not move either, which a set comparison would miss.
      expect(storedGroups().map((g) => g.id)).toEqual(['g-clients', 'g-dorkos', 'g-lab']);
    });

    it('returns the section as it was saved', async () => {
      seed(THREE_SECTIONS());
      const { body } = await call(addToGroup({ group: 'g-dorkos', items: [AGENT_B] }));
      expect(body.group).toEqual(stored('g-dorkos'));
    });

    it('matches a section name without regard to case, and an id exactly', async () => {
      seed(THREE_SECTIONS());
      await call(addToGroup({ group: 'dORKos', items: [AGENT_B] }));
      expect(stored('g-dorkos')!.items).toEqual([AGENT_A, AGENT_B]);

      await call(addToGroup({ group: 'g-lab', items: [AGENT_C] }));
      expect(stored('g-lab')!.items).toEqual([ROOM, AGENT_C]);
    });

    it('lets an id win over a section whose NAME is that same string', async () => {
      // Two sections, and the second is called exactly what the first is keyed
      // by. An id is the unambiguous handle, so it must not be beaten by a name
      // that happens to collide with it.
      seed([
        group({ id: 'g-dorkos', name: 'Clients' }),
        group({ id: 'g-other', name: 'g-dorkos' }),
      ]);
      await call(addToGroup({ group: 'g-dorkos', items: [AGENT_A] }));
      expect(stored('g-dorkos')!.items).toEqual([AGENT_A]);
      expect(stored('g-other')!.items).toEqual([]);
    });

    it('refuses an unknown section and names the ones that exist', async () => {
      seed(THREE_SECTIONS());
      const { isError, body } = await call(addToGroup({ group: 'Archive', items: [AGENT_B] }));

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_GROUP_NOT_FOUND');
      expect(body.sections).toEqual(['Clients', 'DorkOS', 'Lab']);
      // The refusal has to be actionable: a model that is only told "no" tries
      // again with the same argument.
      expect(String(body.error)).toContain('"Clients"');
      expect(String(body.error)).toContain('createIfMissing');
      // Nothing was written at all.
      expect(writes).toHaveLength(0);
      expect(storedGroups()).toEqual(THREE_SECTIONS());
    });

    it('creates the section on createIfMissing, with the app’s own defaults', async () => {
      seed(THREE_SECTIONS());
      const { isError, body } = await call(
        addToGroup({ group: 'Archive', items: [AGENT_B], createIfMissing: true })
      );

      expect(isError).toBe(false);
      expect(body.created).toBe(true);
      const made = storedGroups().at(-1)!;
      expect(made.name).toBe('Archive');
      expect(made.items).toEqual([AGENT_B]);
      // Every other field matches what `createGroup` in
      // `apps/client/src/layers/entities/config/model/use-sidebar-prefs.ts`
      // mints, which is the schema's own defaults: a section an agent made and a
      // section a person made must be indistinguishable on disk.
      expect({ ...made, id: 'x', name: 'x', items: [] }).toEqual(
        SidebarGroupSchema.parse({ id: 'x', name: 'x' })
      );
      // It lands after the sections the person already arranged.
      expect(storedGroups().map((g) => g.name)).toEqual(['Clients', 'DorkOS', 'Lab', 'Archive']);
    });

    it('refuses a duplicated section name instead of guessing, and offers the ids', async () => {
      seed([group({ id: 'g-1', name: 'Work' }), group({ id: 'g-2', name: 'work' })]);
      const { isError, body } = await call(
        addToGroup({ group: 'Work', items: [AGENT_A], createIfMissing: true })
      );

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_GROUP_AMBIGUOUS');
      expect(String(body.error)).toContain('"g-1"');
      expect(String(body.error)).toContain('"g-2"');
      // `createIfMissing` answers "there is no such section", not "there are
      // two" — a third section called Work is the opposite of what was asked.
      expect(storedGroups()).toHaveLength(2);
      expect(writes).toHaveLength(0);
    });

    it('refuses a smart section, whose members come from its rules', async () => {
      seed([
        group({
          id: 'g-smart',
          name: 'Codex',
          kind: 'smart',
          sortMode: 'recent',
          rules: { runtimes: ['codex'] },
        }),
      ]);
      const { isError, body } = await call(addToGroup({ group: 'Codex', items: [AGENT_A] }));

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_GROUP_IS_SMART');
      // The reason this is a refusal rather than a write: the sidebar never
      // reads a smart section's `items`, so the write would report success and
      // change nothing on screen.
      expect(stored('g-smart')!.items).toEqual([]);
      expect(writes).toHaveLength(0);
    });

    it('MOVES an item that is already in another section, and says where from', async () => {
      // Membership is single-parent everywhere the app writes it — the client's
      // own `moveToGroup` lifts a ref out of every section before filing it, and
      // `build-library-sections.ts` assumes that when it works out who is still
      // ungrouped. An append would put one row in two sections, a state no
      // surface in the app can produce and none knows how to undo.
      seed(THREE_SECTIONS());
      const clientsBefore = stored('g-clients')!;

      const { body } = await call(addToGroup({ group: 'DorkOS', items: [AGENT_C] }));

      expect(stored('g-dorkos')!.items).toEqual([AGENT_A, AGENT_C]);
      expect(body.movedFrom).toEqual([{ groupId: 'g-clients', name: 'Clients' }]);
      // The section it left loses the member and NOTHING else: same name, same
      // fold state, same sort, same place in the list.
      expect(stored('g-clients')!.items).toEqual([]);
      expect({ ...stored('g-clients')!, items: [] }).toEqual({ ...clientsBefore, items: [] });
      expect(storedGroups().map((g) => g.id)).toEqual(['g-clients', 'g-dorkos', 'g-lab']);
      // …and the section that had nothing to do with it is untouched.
      expect(stored('g-lab')!.items).toEqual([ROOM]);
    });

    it('moves a room out of its section too, and never out of a smart one', async () => {
      seed([
        ...THREE_SECTIONS(),
        group({
          id: 'g-smart',
          name: 'Codex',
          kind: 'smart',
          sortMode: 'recent',
          rules: { runtimes: ['codex'] },
          items: [ROOM],
        }),
      ]);

      const { body } = await call(addToGroup({ group: 'Clients', items: [ROOM] }));

      expect(stored('g-clients')!.items).toEqual([AGENT_C, ROOM]);
      expect(stored('g-lab')!.items).toEqual([]);
      expect(body.movedFrom).toEqual([{ groupId: 'g-lab', name: 'Lab' }]);
      // A smart section's `items` is not what the sidebar renders, so lifting
      // from one would change nothing on screen while quietly editing the list a
      // later "convert to manual" materializes.
      expect(stored('g-smart')!.items).toEqual([ROOM]);
    });

    it('moves an item the target already holds out of its other section', async () => {
      // The lift covers every ref the caller NAMED, not only the ones newly
      // appended — otherwise a second call would leave a stale second home
      // standing forever.
      seed([
        group({ id: 'g-a', name: 'A', items: [AGENT_A] }),
        group({ id: 'g-b', name: 'B', items: [AGENT_A, AGENT_B] }),
      ]);

      const { body } = await call(addToGroup({ group: 'A', items: [AGENT_A] }));

      expect(body.alreadyPresent).toEqual([AGENT_A]);
      expect(body.added).toEqual([]);
      expect(body.movedFrom).toEqual([{ groupId: 'g-b', name: 'B' }]);
      expect(stored('g-a')!.items).toEqual([AGENT_A]);
      expect(stored('g-b')!.items).toEqual([AGENT_B]);
    });

    it('adds nothing twice when the same item is sent twice in one call', async () => {
      seed(THREE_SECTIONS());
      const { body } = await call(addToGroup({ group: 'DorkOS', items: [AGENT_B, AGENT_B] }));
      expect(stored('g-dorkos')!.items).toEqual([AGENT_A, AGENT_B]);
      expect(body.added).toEqual([AGENT_B]);
      expect(body.alreadyPresent).toEqual([AGENT_B]);
    });
  });

  describe('naming an item', () => {
    // The defect this whole block exists for: the sidebar resolves a stored ref
    // by exact string and never prunes a stale one, so an unchecked reference is
    // a member of the section forever that draws nothing, reported as success.
    it.each<[string, SidebarItemRefInput]>([
      ['its short name', { kind: 'agent', name: 'alpha' }],
      ['its display name, without case', { kind: 'agent', name: 'alpha scout' }],
      ['its id', { kind: 'agent', agentId: '01JAGENTALPHA' }],
      ['its directory', { kind: 'agent', path: '/projects/alpha' }],
      ['its directory with a trailing slash', { kind: 'agent', path: '/projects/alpha/' }],
    ])('resolves an agent named by %s to the stored path', async (_label, ref) => {
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError } = await call(addToGroup({ group: 'Work', items: [ref] }));

      expect(isError).toBe(false);
      // Whatever was sent, what is STORED is the roster's own projectPath —
      // the only string the sidebar will ever match on.
      expect(stored('g-1')!.items).toEqual([AGENT_A]);
    });

    it.each<[string, SidebarItemRefInput]>([
      ['its id', { kind: 'room', roomId: '01JROOM' }],
      ['its channel name', { kind: 'room', name: 'lab' }],
      ['its title, without case', { kind: 'room', name: 'LAB NOTES' }],
    ])('resolves a room named by %s to the stored id', async (_label, ref) => {
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError } = await call(addToGroup({ group: 'Work', items: [ref] }));

      expect(isError).toBe(false);
      expect(stored('g-1')!.items).toEqual([ROOM]);
    });

    it('refuses an agent nobody has registered, and offers the roster', async () => {
      // The reported shape: `path: "scout"` used to answer `success: true` and
      // put a row in the section that renders nothing, forever.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError, body } = await call(
        addToGroup({ group: 'Work', items: [{ kind: 'agent', path: 'scout' }] })
      );

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_ITEM_NOT_FOUND');
      expect(String(body.error)).toContain('"scout"');
      // A refusal a model can act on names what DOES exist.
      expect(String(body.error)).toContain('alpha');
      expect(stored('g-1')!.items).toEqual([]);
      expect(writes).toHaveLength(0);
    });

    it('refuses a name no agent answers to, however it was sent', async () => {
      seed([group({ id: 'g-1', name: 'Work' })]);
      const misses: SidebarItemRefInput[] = [
        { kind: 'agent', name: 'nobody' },
        { kind: 'agent', agentId: '01JNOTREAL' },
        { kind: 'agent' },
      ];
      for (const ref of misses) {
        const { isError, body } = await call(addToGroup({ group: 'Work', items: [ref] }));
        expect(isError).toBe(true);
        expect(body.code).toBe('SIDEBAR_ITEM_NOT_FOUND');
      }
      expect(writes).toHaveLength(0);
    });

    it('refuses an archived room, indistinguishably from one that never existed', async () => {
      // Production passes `includeArchived: false` when it builds this roster
      // (`index.ts`), so an archived room is simply absent from it — the same
      // answer the sidebar gives, since it renders open rooms only.
      //
      // The refusal deliberately does NOT say "archived". Every room miss here
      // is one sentence carrying nothing from the store, so archived, hidden and
      // nonexistent cannot be told apart. Saying "that one is archived" would be
      // a smaller version of the existence oracle the block below is about.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const archived = await call(
        addToGroup({ group: 'Work', items: [{ kind: 'room', roomId: '01JARCHIVED' }] })
      );
      const invented = await call(
        addToGroup({ group: 'Work', items: [{ kind: 'room', roomId: '01JNEVEREXISTED' }] })
      );

      expect(archived.isError).toBe(true);
      expect(archived.body.code).toBe('SIDEBAR_ITEM_NOT_FOUND');
      // The per-item reasons are joined and then a sentence is appended, so a
      // reason that ended in a period produced "…in it.. An item has to…".
      expect(String(archived.body.error)).not.toContain('..');
      expect((archived.body.unresolved as string[])[0]!.split(' — ')[1]).toBe(
        (invented.body.unresolved as string[])[0]!.split(' — ')[1]
      );
      expect(writes).toHaveLength(0);
    });

    it('refuses an ambiguous room name rather than picking one', async () => {
      const twoGenerals = handlers.createSidebarAddToGroupHandler(
        deps({
          listVisibleRooms: () => [
            { roomId: '01JROOMX', name: 'General', slug: null },
            { roomId: '01JROOMY', name: 'General', slug: null },
          ],
        }),
        caller()
      );
      seed([group({ id: 'g-1', name: 'Work' })]);

      const { isError, body } = await call(
        twoGenerals({ group: 'Work', items: [{ kind: 'room', name: 'General' }] })
      );

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_ITEM_NOT_FOUND');
      expect(String(body.error)).toContain('roomId');
      expect(writes).toHaveLength(0);
    });

    it('refuses an ambiguous agent name rather than picking one', async () => {
      const twins = handlers.createSidebarAddToGroupHandler(
        deps({
          meshCore: {
            listWithPaths: () => [
              { id: '01JX', name: 'scout', projectPath: '/projects/one' },
              { id: '01JY', name: 'other', displayName: 'Scout', projectPath: '/projects/two' },
            ],
          } as unknown as McpToolDeps['meshCore'],
        }),
        caller()
      );
      seed([group({ id: 'g-1', name: 'Work' })]);

      const { isError, body } = await call(
        twins({ group: 'Work', items: [{ kind: 'agent', name: 'scout' }] })
      );

      expect(isError).toBe(true);
      expect(String(body.error)).toContain('agentId');
      expect(writes).toHaveLength(0);
    });

    it('refuses the WHOLE call when one of several items misses', async () => {
      // No partial write: a model told "three filed" when one is missing has no
      // way to find out which, and neither has the person.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError } = await call(
        addToGroup({
          group: 'Work',
          items: [
            { kind: 'agent', name: 'alpha' },
            { kind: 'agent', name: 'nobody' },
          ],
        })
      );

      expect(isError).toBe(true);
      expect(stored('g-1')!.items).toEqual([]);
      expect(writes).toHaveLength(0);
    });

    it('refuses a room reference when this DorkOS has no rooms wired', async () => {
      // `undefined` is "cannot answer", never "no rooms" — storing an unchecked
      // ref because the checker is missing is the failure, not the fallback.
      const roomless = handlers.createSidebarAddToGroupHandler(
        deps({ listVisibleRooms: undefined }),
        caller()
      );
      seed([group({ id: 'g-1', name: 'Work' })]);

      const { isError, body } = await call(
        roomless({ group: 'Work', items: [{ kind: 'room', roomId: '01JROOM' }] })
      );

      expect(isError).toBe(true);
      expect(String(body.error)).toContain('cannot say which rooms you can see');
      expect(writes).toHaveLength(0);
    });

    it('resolves the same way on the way OUT of a section', async () => {
      // Without this the stored ref is a path and the caller's slug matches
      // nothing, so the item would be reported "not present" while sitting in
      // the section untouched.
      seed([group({ id: 'g-1', name: 'Work', items: [AGENT_A, AGENT_B] })]);
      const { body } = await call(
        removeFromGroup({ group: 'Work', items: [{ kind: 'agent', name: 'Alpha Scout' }] })
      );

      expect(body.removed).toEqual([AGENT_A]);
      expect(stored('g-1')!.items).toEqual([AGENT_B]);
    });

    it('refuses an unknown item on the way out too, and writes nothing', async () => {
      seed([group({ id: 'g-1', name: 'Work', items: [AGENT_A] })]);
      const { isError, body } = await call(
        removeFromGroup({ group: 'Work', items: [{ kind: 'agent', name: 'nobody' }] })
      );

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_ITEM_NOT_FOUND');
      expect(stored('g-1')!.items).toEqual([AGENT_A]);
      expect(writes).toHaveLength(0);
    });
  });

  describe('a room the caller cannot see', () => {
    /**
     * The handlers a NON-MEMBER gets: the same agent roster, and a room roster
     * that simply does not contain the operator's DM.
     *
     * That is the production shape, not a simplification. `listVisibleRooms` is
     * wired through the rooms domain's own `callerAuthor` + `RoomService.listRooms`
     * (`index.ts`), so a caller is handed its own visible set and an unseen room
     * is absent rather than filtered later — which is exactly why no branch in
     * this module can tell "not yours" from "not there".
     */
    function asNonMember() {
      return {
        add: handlers.createSidebarAddToGroupHandler(deps(), caller({ identity: AGENT_IDENTITY })),
        remove: handlers.createSidebarRemoveFromGroupHandler(
          deps(),
          caller({ identity: AGENT_IDENTITY })
        ),
      };
    }

    /** The same handlers for the owner, whose view holds every room. */
    function asOwner() {
      const owner = deps({ listVisibleRooms: () => [...ROSTER_ROOMS, UNSEEN_DM] });
      return {
        add: handlers.createSidebarAddToGroupHandler(owner, caller()),
        remove: handlers.createSidebarRemoveFromGroupHandler(owner, caller()),
      };
    }

    it('cannot be resolved by name or by id, through either verb', async () => {
      seed([
        group({ id: 'g-1', name: 'Work', items: [{ kind: 'room', roomId: UNSEEN_DM.roomId }] }),
      ]);
      const { add, remove } = asNonMember();

      for (const ref of [
        { kind: 'room', roomId: UNSEEN_DM.roomId },
        { kind: 'room', name: UNSEEN_DM.name },
      ] as SidebarItemRefInput[]) {
        expect((await call(add({ group: 'Work', items: [ref] }))).isError).toBe(true);
        expect((await call(remove({ group: 'Work', items: [ref] }))).isError).toBe(true);
      }
      // The DM is still in the section, untouched, and nothing was written.
      expect(stored('g-1')!.items).toEqual([{ kind: 'room', roomId: UNSEEN_DM.roomId }]);
      expect(writes).toHaveLength(0);
    });

    it('answers a real hidden room byte-identically to a room that never existed', async () => {
      // The oracle this closes: `sidebar_remove_from_group` used to answer a
      // guessed DM title with `success: true` and `notPresent: [{roomId: <the
      // real id>}]`, which confirms the room exists. `room-visibility.ts` keeps
      // "not visible" and "no such room" indistinguishable for that reason, and
      // a second seam that answered a wider question reopened it here.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { add, remove } = asNonMember();

      const hidden = await call(
        add({ group: 'Work', items: [{ kind: 'room', name: 'Dorian and Scout' }] })
      );
      const absent = await call(
        add({ group: 'Work', items: [{ kind: 'room', name: 'Dorian and Scout' }] })
      );
      // Same words for a room that exists-but-is-hidden and one nobody has.
      const invented = await call(
        add({ group: 'Work', items: [{ kind: 'room', name: 'No Such Conversation' }] })
      );

      expect(hidden.body).toEqual(absent.body);
      // Only the caller's own echoed words differ; the REASON is the same bytes.
      expect((hidden.body.unresolved as string[])[0]!.split(' — ')[1]).toBe(
        (invented.body.unresolved as string[])[0]!.split(' — ')[1]
      );
      // And neither answer carries the id, a count, or the room's own title.
      expect(JSON.stringify(hidden.body)).not.toContain(UNSEEN_DM.roomId);

      const byId = await call(
        remove({ group: 'Work', items: [{ kind: 'room', roomId: UNSEEN_DM.roomId }] })
      );
      const byMadeUpId = await call(
        remove({ group: 'Work', items: [{ kind: 'room', roomId: '01JNOTAROOMATALL' }] })
      );
      expect((byId.body.unresolved as string[])[0]!.split(' — ')[1]).toBe(
        (byMadeUpId.body.unresolved as string[])[0]!.split(' — ')[1]
      );
    });

    it('still resolves for the owner, whose view holds every room', async () => {
      // The scoping must narrow the agent without breaking the person: the
      // sidebar being edited is theirs, and `seesEveryRoom` is why their own
      // path is unchanged.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { add } = asOwner();

      const { isError } = await call(
        add({ group: 'Work', items: [{ kind: 'room', name: 'Dorian and Scout' }] })
      );

      expect(isError).toBe(false);
      expect(stored('g-1')!.items).toEqual([{ kind: 'room', roomId: UNSEEN_DM.roomId }]);
    });

    it('refuses because of the ROSTER it was handed, not something else in the module', async () => {
      // An inversion probe, and it is worth being exact about its reach, because
      // an earlier version of this comment over-claimed. Handing the SAME
      // handler a wider roster makes the same call succeed, so the refusals
      // above are caused by the roster contents and by nothing else here.
      //
      // What it does NOT pin is the wiring that decides whose roster that is:
      // every test in this file injects its own `listVisibleRooms` fake, so none
      // of them executes the caller resolution. Reverting that line to the
      // owner's author id left 712 tests green, which is why it now lives in a
      // named unit with its own suite —
      // `services/rooms/__tests__/visible-rooms-for-caller.test.ts`, where the
      // real `RoomService` is driven and the same mutation kills 7 of 10 cases.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const widened = handlers.createSidebarAddToGroupHandler(
        deps({ listVisibleRooms: () => [...ROSTER_ROOMS, UNSEEN_DM] }),
        caller({ identity: AGENT_IDENTITY })
      );

      const { isError } = await call(
        widened({ group: 'Work', items: [{ kind: 'room', name: 'Dorian and Scout' }] })
      );

      expect(isError).toBe(false);
    });

    it('scopes rooms but NOT agents, which are not secret', async () => {
      // `mesh_list` already lists every agent on the install, so narrowing the
      // agent roster per caller would buy nothing and refuse correct references.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { add } = asNonMember();

      const { isError } = await call(
        add({ group: 'Work', items: [{ kind: 'agent', name: 'gamma' }] })
      );

      expect(isError).toBe(false);
      expect(stored('g-1')!.items).toEqual([AGENT_C]);
    });
  });

  describe('remove', () => {
    it('takes out only what was named, and leaves the others byte-identical', async () => {
      seed([
        group({ id: 'g-clients', name: 'Clients', items: [AGENT_C] }),
        group({ id: 'g-dorkos', name: 'DorkOS', items: [AGENT_A, AGENT_B, ROOM] }),
      ]);
      const before = JSON.stringify(stored('g-clients'));

      const { isError, body } = await call(
        removeFromGroup({ group: 'dorkos', items: [AGENT_A, ROOM] })
      );

      expect(isError).toBe(false);
      expect(stored('g-dorkos')!.items).toEqual([AGENT_B]);
      expect(body.removed).toEqual([AGENT_A, ROOM]);
      expect(JSON.stringify(stored('g-clients'))).toBe(before);
    });

    it('reports an item that was never in the section, and changes nothing for it', async () => {
      seed([group({ id: 'g-dorkos', name: 'DorkOS', items: [AGENT_A] })]);
      const { body } = await call(removeFromGroup({ group: 'DorkOS', items: [AGENT_B] }));

      expect(body.notPresent).toEqual([AGENT_B]);
      expect(body.removed).toEqual([]);
      expect(stored('g-dorkos')!.items).toEqual([AGENT_A]);
    });

    it('leaves an empty section standing when the last member goes', async () => {
      // Deleting it would be a second change nobody asked for, and an empty
      // section is still somewhere the person can drag into.
      seed([group({ id: 'g-dorkos', name: 'DorkOS', items: [AGENT_A] })]);
      await call(removeFromGroup({ group: 'DorkOS', items: [AGENT_A] }));

      expect(stored('g-dorkos')).toBeDefined();
      expect(stored('g-dorkos')!.items).toEqual([]);
    });

    it('refuses an unknown section, a duplicated name and a smart section, like its sibling', async () => {
      seed([
        group({ id: 'g-1', name: 'Work', items: [AGENT_A] }),
        group({ id: 'g-2', name: 'work' }),
        group({
          id: 'g-smart',
          name: 'Codex',
          kind: 'smart',
          sortMode: 'recent',
          rules: { runtimes: ['codex'] },
        }),
      ]);

      expect((await call(removeFromGroup({ group: 'Archive', items: [AGENT_A] }))).body.code).toBe(
        'SIDEBAR_GROUP_NOT_FOUND'
      );
      expect((await call(removeFromGroup({ group: 'Work', items: [AGENT_A] }))).body.code).toBe(
        'SIDEBAR_GROUP_AMBIGUOUS'
      );
      expect((await call(removeFromGroup({ group: 'Codex', items: [AGENT_A] }))).body.code).toBe(
        'SIDEBAR_GROUP_IS_SMART'
      );
      expect(writes).toHaveLength(0);
    });
  });

  describe('the person-only settings guard', () => {
    it('cannot be reached, because the write only ever carries `ui.sidebar`', async () => {
      // The structural half of the guard. `applyGuardedConfigWrite` refuses a
      // patch that so much as NAMES an operator-only setting, and refuses it
      // whole — so the strongest form that protection can take is a patch which
      // cannot name one. These handlers take a section and a list of items;
      // neither is a config path, and the patch is built here from a config read
      // in-process. There is no argument that puts a second key in it.
      seed(THREE_SECTIONS());
      await call(addToGroup({ group: 'DorkOS', items: [AGENT_B] }));
      await call(removeFromGroup({ group: 'DorkOS', items: [AGENT_B] }));

      expect(writes).toHaveLength(2);
      for (const write of writes) {
        const patch = write.patch as Record<string, unknown>;
        expect(Object.keys(patch)).toEqual(['ui']);
        expect(Object.keys(patch.ui as Record<string, unknown>)).toEqual(['sidebar']);
        // And it goes in under the agent authority, which is what makes an
        // operator-only leaf a refusal rather than a write.
        expect(write.writer.kind).toBe('agent');
      }
    });

    it('leaves every other config section exactly as it was', async () => {
      seed(THREE_SECTIONS());
      const before = configManager.getAll();
      const snapshot = JSON.stringify({ ...before, ui: undefined });

      await call(addToGroup({ group: 'DorkOS', items: [AGENT_B] }));

      const after = configManager.getAll();
      expect(JSON.stringify({ ...after, ui: undefined })).toBe(snapshot);
      // Inside `ui`, everything but the sidebar is untouched too.
      expect(JSON.stringify({ ...after.ui, sidebar: undefined })).toBe(
        JSON.stringify({ ...before.ui, sidebar: undefined })
      );
      // And inside the sidebar, only `groups` moved: pins, mutes and the
      // per-section fold state a person set survive a section edit.
      expect(JSON.stringify({ ...after.ui.sidebar, groups: undefined })).toBe(
        JSON.stringify({ ...before.ui.sidebar, groups: undefined })
      );
    });

    it('names its own door in the audit line', async () => {
      seed(THREE_SECTIONS());
      await call(addToGroup({ group: 'DorkOS', items: [AGENT_B] }));
      // "What wrote it?" is the question the whole config audit line exists to
      // answer (DOR-1237), and a new door that reused another door's label would
      // send the next investigation to the wrong place.
      expect(writes[0]!.source).toBe('the sidebar_add_to_group tool');
    });
  });
});
