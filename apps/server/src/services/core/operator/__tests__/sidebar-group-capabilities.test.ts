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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SidebarGroupSchema, type SidebarGroup } from '@dorkos/shared/config-schema';
import type { ConfigManager } from '../../config-manager.js';
import type { GuardedConfigWrite } from '../config-write.js';
import type { OperatorToolResult } from '../operator-tool-handlers.js';

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

const AGENT_A = { kind: 'agent', path: '/projects/alpha' } as const;
const AGENT_B = { kind: 'agent', path: '/projects/beta' } as const;
const AGENT_C = { kind: 'agent', path: '/projects/gamma' } as const;
const ROOM = { kind: 'room', roomId: '01JROOM' } as const;
/** A room in no section at all, so filing it can move nothing. */
const LOOSE_ROOM = { kind: 'room', roomId: '01JROOM2' } as const;

describe('the sidebar-section capabilities', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let addToGroup: ReturnType<
    typeof import('../operator-tool-handlers.js').createSidebarAddToGroupHandler
  >;
  let removeFromGroup: ReturnType<
    typeof import('../operator-tool-handlers.js').createSidebarRemoveFromGroupHandler
  >;

  beforeEach(async () => {
    writes.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-sidebar-groups-'));
    process.env.DORK_HOME = tmpDir;

    const configModule = await import('../../config-manager.js');
    configManager = configModule.initConfigManager(tmpDir);

    const handlers = await import('../operator-tool-handlers.js');
    addToGroup = handlers.createSidebarAddToGroupHandler();
    removeFromGroup = handlers.createSidebarRemoveFromGroupHandler();
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
