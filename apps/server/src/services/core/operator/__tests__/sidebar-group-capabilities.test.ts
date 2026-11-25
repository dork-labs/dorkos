/**
 * The two targeted sidebar-section capabilities, against a real `ConfigManager`
 * over a real temp data directory (DOR-2055). What matters is what a call
 * leaves ALONE: a section changes only when this call moved a member into or
 * out of it, and the write carries nothing but `ui.sidebar`. The guarded write
 * is wrapped, not mocked, so the patch checked is the one production built.
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

/** The roster the handlers resolve against, matching the fixtures above. */
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
 * A room the caller in these tests is NOT in, the operator's private DM. It is
 * never in a roster handed to a non-member, as in production.
 */
const UNSEEN_DM = { roomId: '01JPRIVATEDM', name: 'Dorian and Scout', slug: null };

/** Tool deps carrying just the two rosters a reference is checked against. */
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

  // Imported ONCE: handlers read the live `configManager` binding at call time.
  // The timeout covers a slow import on a busy machine.
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

  // Deliberately NO `vi.resetModules()`: the mock factory's result is cached, so
  // a reset would leave the wrapper writing to the previous test's store.
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

      // The call that started this: "alpha" is already filed there, and none of
      // the three lives in another section, so this call may move nothing.
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

    it('refuses an unknown section and names the ones that exist', async () => {
      seed(THREE_SECTIONS());
      const { isError, body } = await call(addToGroup({ group: 'Archive', items: [AGENT_B] }));

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_GROUP_NOT_FOUND');
      expect(body.sections).toEqual(['Clients', 'DorkOS', 'Lab']);
      // Actionable: a model only told "no" retries the same argument.
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
      // The schema's own defaults, as a section a person makes in the app.
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
      // `createIfMissing` answers "no such section", not "there are two".
      expect(storedGroups()).toHaveLength(2);
      expect(writes).toHaveLength(0);
    });

    it('MOVES an item that is already in another section, and says where from', async () => {
      // Membership is single-parent everywhere the app writes it.
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
  });

  describe('naming an item', () => {
    // An unchecked reference is a member forever that draws nothing.
    it.each<[string, SidebarItemRefInput]>([
      ['its short name', { kind: 'agent', name: 'alpha' }],
      ['its id', { kind: 'agent', agentId: '01JAGENTALPHA' }],
      ['its directory with a trailing slash', { kind: 'agent', path: '/projects/alpha/' }],
    ])('resolves an agent named by %s to the stored path', async (_label, ref) => {
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError } = await call(addToGroup({ group: 'Work', items: [ref] }));

      expect(isError).toBe(false);
      // What is STORED is the roster's own projectPath, whatever was sent.
      expect(stored('g-1')!.items).toEqual([AGENT_A]);
    });

    it.each<[string, SidebarItemRefInput]>([
      ['its channel name', { kind: 'room', name: 'lab' }],
      ['its title, without case', { kind: 'room', name: 'LAB NOTES' }],
    ])('resolves a room named by %s to the stored id', async (_label, ref) => {
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError } = await call(addToGroup({ group: 'Work', items: [ref] }));

      expect(isError).toBe(false);
      expect(stored('g-1')!.items).toEqual([ROOM]);
    });

    it('refuses the WHOLE call when one item names an agent nobody registered', async () => {
      // The reported shape: `path: "scout"` used to answer `success: true`. And
      // no partial write: nobody could find out which of several items missed.
      seed([group({ id: 'g-1', name: 'Work' })]);
      const { isError, body } = await call(
        addToGroup({
          group: 'Work',
          items: [
            { kind: 'agent', name: 'alpha' },
            { kind: 'agent', path: 'scout' },
          ],
        })
      );

      expect(isError).toBe(true);
      expect(body.code).toBe('SIDEBAR_ITEM_NOT_FOUND');
      expect(String(body.error)).toContain('"scout"');
      expect(stored('g-1')!.items).toEqual([]);
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

    it('refuses a room reference when this DorkOS has no rooms wired', async () => {
      // `undefined` is "cannot answer", never "no rooms".
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
      // Otherwise the item is reported "not present" while still in the section.
      seed([group({ id: 'g-1', name: 'Work', items: [AGENT_A, AGENT_B] })]);
      const { body } = await call(
        removeFromGroup({ group: 'Work', items: [{ kind: 'agent', name: 'Alpha Scout' }] })
      );

      expect(body.removed).toEqual([AGENT_A]);
      expect(stored('g-1')!.items).toEqual([AGENT_B]);
    });
  });

  describe('a room the caller cannot see', () => {
    /** The handlers a NON-MEMBER gets: a room roster without the operator's DM. */
    function asNonMember() {
      return {
        add: handlers.createSidebarAddToGroupHandler(deps(), caller({ identity: AGENT_IDENTITY })),
        remove: handlers.createSidebarRemoveFromGroupHandler(
          deps(),
          caller({ identity: AGENT_IDENTITY })
        ),
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
      // The removal tool used to answer a guessed DM title with the real id in
      // `notPresent`, which confirmed the room exists.
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

    it('refuses because of the ROSTER it was handed, not something else in the module', async () => {
      // An inversion probe: a wider roster makes the same call succeed. Whose
      // roster it is lives in `visible-rooms-for-caller.test.ts`.
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
  });

  describe('remove', () => {
    it('takes out only what was named, reports what was not there, and leaves the others byte-identical', async () => {
      seed([
        group({ id: 'g-clients', name: 'Clients', items: [AGENT_C] }),
        group({ id: 'g-dorkos', name: 'DorkOS', items: [AGENT_A, AGENT_B, ROOM] }),
      ]);
      const before = JSON.stringify(stored('g-clients'));

      const { isError, body } = await call(
        removeFromGroup({ group: 'dorkos', items: [AGENT_A, ROOM, LOOSE_ROOM] })
      );

      expect(isError).toBe(false);
      expect(stored('g-dorkos')!.items).toEqual([AGENT_B]);
      expect(body.removed).toEqual([AGENT_A, ROOM]);
      expect(body.notPresent).toEqual([LOOSE_ROOM]);
      expect(JSON.stringify(stored('g-clients'))).toBe(before);
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
      // The strongest form of the guard is a patch which cannot name an
      // operator-only setting: no argument puts a second key in it.
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
