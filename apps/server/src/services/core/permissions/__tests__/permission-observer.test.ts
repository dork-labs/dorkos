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

import { listPermissionHistory, observedPermissionReader, PermissionService } from '../index.js';
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

  function newObserver() {
    return new PermissionObserver({
      snapshotFile: path.join(root, 'dork-home', 'permissions', 'observed.json'),
      agentAt: (p) => (p === agentPath ? { id: 'agent-ana', name: 'Ana' } : undefined),
      areaOfAction: (id) => (id.startsWith('rooms.') ? 'rooms' : null),
      activity: world.activity,
      logger: { warn: () => {} },
    });
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

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

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
});
