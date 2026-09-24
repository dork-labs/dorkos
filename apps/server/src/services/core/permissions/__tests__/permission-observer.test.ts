/**
 * A permission change made by editing an agent's settings file, not through
 * DorkOS, is honoured and recorded once as "Changed outside DorkOS". Runs over
 * real manifest files in a temp directory, read through the same reader the
 * gate and the permission pages use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentPermissions } from '@dorkos/shared/permissions';

import {
  listPermissionHistory,
  observedPermissionReader,
  PermissionService,
  readAgentPermissionsFromManifest,
} from '../index.js';
import { PermissionObserver } from '../permission-observer.js';
import { createPermissionWorld } from './permission-fixtures.js';

describe('PermissionObserver', () => {
  let root: string;
  let agentPath: string;
  let world: ReturnType<typeof createPermissionWorld>;
  let observer: PermissionObserver;
  let read: (agentPath: string) => Promise<AgentPermissions | undefined>;
  let service: PermissionService;

  /** Edit the agent's manifest file directly, the way a file tool would. */
  function editFile(permissions: AgentPermissions | undefined) {
    const file = path.join(agentPath, '.dork', 'agent.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (permissions) body.permissions = permissions;
    else delete body.permissions;
    fs.writeFileSync(file, JSON.stringify(body));
  }

  /** The permission events about the agent, newest first. */
  async function history() {
    return (await listPermissionHistory(world.activity, { agentId: 'agent-ana', limit: 50 })).items;
  }

  /** The id registered at `agentPath`; a test re-registers by changing it. */
  let registeredId = 'agent-ana';
  let activity: { emit: (event: never) => Promise<void> };
  const snapshotDir = () => path.join(root, 'dork-home', 'permissions');

  function newObserver() {
    return new PermissionObserver({
      snapshotFile: path.join(snapshotDir(), 'observed.json'),
      agentAt: (p) => (p === agentPath ? { id: registeredId, name: 'Ana' } : undefined),
      areaOfAction: (id) => (id.startsWith('rooms.') ? 'rooms' : null),
      read: readAgentPermissionsFromManifest,
      activity: { emit: (event) => activity.emit(event as never) },
      logger: { warn: () => {} },
    });
  }

  /** A promise and the function that settles it. */
  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-permission-observer-'));
    agentPath = path.join(root, 'ana');
    fs.mkdirSync(path.join(agentPath, '.dork'), { recursive: true });
    fs.writeFileSync(
      path.join(agentPath, '.dork', 'agent.json'),
      JSON.stringify({
        id: 'agent-ana',
        name: 'ana',
        description: '',
        runtime: 'claude-code',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: '2026-08-01T00:00:00.000Z',
        registeredBy: 'test',
        personaEnabled: true,
        mcpServers: [],
        permissions: { areas: { rooms: 'blocked' } },
      })
    );
    world = createPermissionWorld({ preset: 'careful' });
    registeredId = 'agent-ana';
    activity = world.activity;
    observer = newObserver();
    read = observedPermissionReader(observer);
    service = new PermissionService({
      config: { get: () => world.config, set: () => {}, trustStop: () => null },
      agents: {
        list: () => [{ id: 'agent-ana', name: 'Ana', projectPath: agentPath }],
        readPermissions: read,
        writePermissions: (_id, next) =>
          observer.writing(agentPath, next, async () => editFile(next)),
      },
      actions: () => [{ id: 'rooms.create', title: 'Open a room', tier: 'act', area: 'rooms' }],
      activity: world.activity,
    });
  });

  afterEach(() => {
    fs.chmodSync(root, 0o755);
    if (fs.existsSync(snapshotDir())) fs.chmodSync(snapshotDir(), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('seeds silently on the first read, and records nothing while the file is unchanged', async () => {
    await read(agentPath);
    await read(agentPath);
    await read(agentPath);
    expect(await history()).toEqual([]);
  });

  it('honours an edit made outside DorkOS and records it exactly once', async () => {
    await read(agentPath);
    editFile({ areas: { rooms: 'allowed' } });

    // Two reads racing on the same edit, then a third later on.
    const [a, b] = await Promise.all([read(agentPath), read(agentPath)]);
    await read(agentPath);

    expect(a?.areas?.rooms).toBe('allowed');
    expect(b?.areas?.rooms).toBe('allowed');
    const events = await history();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorLabel: 'Changed outside DorkOS',
      summary: 'Ana: Rooms Allowed',
      metadata: {
        surface: 'file-edit',
        attribution: 'outside',
        changes: [
          {
            target: { kind: 'agent', agentId: 'agent-ana' },
            key: { kind: 'area', area: 'rooms' },
            before: 'blocked',
            after: 'allowed',
          },
        ],
      },
    });
    expect(events[0]!.actorDetail).toMatch(/settings file was edited directly/);
  });

  it('records an edit once when two observations of it land at the same moment', async () => {
    await read(agentPath);
    const edited = async () => ({ areas: { rooms: 'allowed' as const } });

    await Promise.all([
      observer.readObserved(agentPath, edited),
      observer.readObserved(agentPath, edited),
      observer.readObserved(agentPath, edited),
    ]);

    expect(await history()).toHaveLength(1);
  });

  it("does not report DorkOS's own write as an outside change", async () => {
    await read(agentPath);
    await service.setAgent(
      'agent-ana',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      { attribution: 'local-trust', actorType: 'user', actorLabel: 'Someone on this computer' }
    );
    await read(agentPath);

    const events = await history();
    expect(events.map((e) => e.metadata.attribution)).toEqual(['local-trust']);
  });

  it('remembers across a restart, so an edit made while DorkOS was off is still caught', async () => {
    await read(agentPath);
    editFile(undefined);

    const restarted = observedPermissionReader(newObserver());
    await restarted(agentPath);

    const events = await history();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.changes[0]).toMatchObject({ before: 'blocked', after: null });
  });

  it('marks the area on the agent page while the outside change is the latest', async () => {
    await read(agentPath);
    editFile({ areas: { rooms: 'allowed' } });

    const page = await service.getAgent('agent-ana');
    expect(page.areas.find((a) => a.id === 'rooms')?.changedOutsideAt).toEqual(expect.any(String));

    // A person's change through DorkOS takes the mark away again.
    await service.setAgent(
      'agent-ana',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      { attribution: 'local-trust', actorType: 'user', actorLabel: 'Someone on this computer' }
    );
    const after = await service.getAgent('agent-ana');
    expect(after.areas.find((a) => a.id === 'rooms')?.changedOutsideAt).toBeNull();
  });

  it('never takes a read that started before a DorkOS write for an outside edit', async () => {
    await read(agentPath);

    // A read takes its ticket and sees the OLD file, but is held back until a
    // DorkOS write has fully landed. Then it finishes with the stale value.
    const stale = deferred<AgentPermissions | undefined>();
    const inFlight = observer.readObserved(agentPath, () => stale.promise);
    await service.setAgent(
      'agent-ana',
      { areas: { rooms: 'ask' }, surface: 'agent-page' },
      { attribution: 'local-trust', actorType: 'user', actorLabel: 'Someone on this computer' }
    );
    stale.resolve({ areas: { rooms: 'blocked' } });
    await inFlight;
    // And a fresh read of the real file afterwards.
    await read(agentPath);

    const events = await history();
    expect(events.map((e) => e.metadata.attribution)).toEqual(['local-trust']);
    expect((await service.getAgent('agent-ana')).areas[0]!.changedOutsideAt).toBeNull();
  });

  it('still records the change when the last-seen record cannot be saved', async () => {
    await read(agentPath);
    fs.chmodSync(snapshotDir(), 0o555);
    editFile({ areas: { rooms: 'allowed' } });

    await read(agentPath);
    await read(agentPath);

    const events = await history();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata.attribution).toBe('outside');
  });

  it('keeps the change pending, not absorbed, while its event cannot be written', async () => {
    await read(agentPath);
    editFile({ areas: { rooms: 'allowed' } });
    activity = {
      emit: async () => {
        throw new Error('the database went away');
      },
    };
    await read(agentPath);
    expect(await history()).toEqual([]);

    activity = world.activity;
    await read(agentPath);
    expect((await history()).map((e) => e.metadata.attribution)).toEqual(['outside']);
  });

  it('starts fresh for an agent registered anew at an old folder', async () => {
    await read(agentPath);
    editFile({ areas: { rooms: 'allowed' } });
    registeredId = 'agent-new';

    await read(agentPath);

    const all = await listPermissionHistory(world.activity, { limit: 50 });
    expect(all.items).toEqual([]);
  });

  it("does not hold one agent's reads behind another's", async () => {
    const otherPath = path.join(root, 'bo');
    const multi = new PermissionObserver({
      snapshotFile: path.join(snapshotDir(), 'multi.json'),
      agentAt: (p) =>
        p === agentPath
          ? { id: 'agent-ana', name: 'Ana' }
          : p === otherPath
            ? { id: 'agent-bo', name: 'Bo' }
            : undefined,
      areaOfAction: () => 'rooms',
      read: async () => undefined,
      activity: world.activity,
      logger: { warn: () => {} },
    });
    const slow = deferred();
    // Ana's write is stuck; Bo's read must not wait for it.
    const stuck = multi.writing(agentPath, undefined, () => slow.promise);
    const bo = multi.readObserved(otherPath, async () => undefined);
    const winner = await Promise.race([
      bo.then(() => 'bo'),
      stuck.then(() => 'ana'),
      new Promise((r) => setTimeout(() => r('timed out'), 1000)),
    ]);
    slow.resolve();
    await stuck;
    expect(winner).toBe('bo');
  });

  it('discards a read whose ticket was taken while a DorkOS write was under way', async () => {
    await read(agentPath);

    // The write has started (and so moved the counter once) but not finished.
    const gate = deferred();
    const entered = deferred();
    const writing = observer.writing(agentPath, { areas: { rooms: 'ask' } }, async () => {
      entered.resolve();
      await gate.promise;
      editFile({ areas: { rooms: 'ask' } });
    });
    await entered.promise;
    // A read takes its ticket mid-write and sees the file from before it.
    const stale = deferred<AgentPermissions | undefined>();
    const inFlight = observer.readObserved(agentPath, () => stale.promise);
    gate.resolve();
    await writing;
    stale.resolve({ areas: { rooms: 'blocked' } });
    await inFlight;
    await read(agentPath);

    expect(await history()).toEqual([]);
  });

  it('does not re-seed from an unreadable record, and says so once per episode', async () => {
    await read(agentPath);
    const record = path.join(snapshotDir(), 'observed.json');
    fs.chmodSync(record, 0o000);
    editFile({ areas: { rooms: 'allowed' } });

    // A restart while the record cannot be read: several reads, one notice.
    const restarted = observedPermissionReader(newObserver());
    await restarted(agentPath);
    await restarted(agentPath);
    await restarted(agentPath);
    let events = await history();
    expect(events.map((e) => e.summary)).toEqual([
      "Ana: DorkOS can't check this agent's settings for outside changes right now",
    ]);
    expect(events[0]!.actorDetail).toMatch(/won't be noticed until it can/);

    // Readable again: the edit is still caught, because nothing was re-seeded.
    fs.chmodSync(record, 0o644);
    await restarted(agentPath);
    events = await history();
    expect(events[0]).toMatchObject({ actorLabel: 'Changed outside DorkOS' });
    expect(events).toHaveLength(2);
  });

  it('re-saves a record that fell behind, so a restart reports nothing twice', async () => {
    await read(agentPath);
    fs.chmodSync(snapshotDir(), 0o555);
    editFile({ areas: { rooms: 'allowed' } });
    await read(agentPath); // recorded, but the save fails
    fs.chmodSync(snapshotDir(), 0o755);
    await read(agentPath); // nothing new: the save is retried

    await observedPermissionReader(newObserver())(agentPath);

    expect(await history()).toHaveLength(1);
  });

  it('syncs to the file when a DorkOS write lands and then fails', async () => {
    await read(agentPath);
    await expect(
      observer.writing(agentPath, { areas: { rooms: 'ask' } }, async () => {
        editFile({ areas: { rooms: 'ask' } });
        throw new Error('the registry update failed after the save');
      })
    ).rejects.toThrow('the registry update failed');

    await read(agentPath);

    expect(await history()).toEqual([]);
  });
});
