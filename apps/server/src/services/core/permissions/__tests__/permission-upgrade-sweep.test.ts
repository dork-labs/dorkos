/**
 * The boot-time permission upgrade sweep (spec `agent-permissions` D13), over
 * real manifest files in a temp directory: an agent that held the retired
 * `roomsManage` grant keeps Rooms, one that had it switched off is Blocked, the
 * key leaves the file, and the whole thing happens once per server version.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';

import {
  readRawManifestFile,
  runPermissionUpgradeSweep,
  type PermissionUpgradeSweepDeps,
} from '../permission-upgrade-sweep.js';
import { createPermissionWorld } from './permission-fixtures.js';

/** A minimal manifest file body, with whatever extra fields a test needs. */
function manifestBody(id: string, extra: Record<string, unknown>) {
  return {
    id,
    name: id,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    mcpServers: [],
    ...extra,
  };
}

describe('runPermissionUpgradeSweep', () => {
  let root: string;
  let config: PermissionConfigInput & { upgradeSweptVersion: string | null };
  let world: ReturnType<typeof createPermissionWorld>;
  let warnings: unknown[];
  const agents = ['granted', 'refused', 'plain', 'broken'];

  /** Write one agent's raw manifest file. */
  function writeRaw(id: string, body: unknown) {
    const dir = path.join(root, id, '.dork');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agent.json'),
      typeof body === 'string' ? body : JSON.stringify(body)
    );
  }

  /** The agent's manifest file as it now sits on disk. */
  function onDisk(id: string) {
    return JSON.parse(fs.readFileSync(path.join(root, id, '.dork', 'agent.json'), 'utf8'));
  }

  function deps(version = '0.83.0'): PermissionUpgradeSweepDeps {
    return {
      version,
      config: {
        get: () => structuredClone(config),
        set: (next) => (config = structuredClone(next)),
      },
      agents: () => agents.map((id) => ({ id, name: id, projectPath: path.join(root, id) })),
      readRawManifest: readRawManifestFile,
      // What `MeshCore.update` does: read the (folded) manifest, merge, write.
      writeFolded: async (agentId, fields) => {
        const projectPath = path.join(root, agentId);
        const base = await readManifest(projectPath);
        await writeManifest(projectPath, { ...base!, ...fields });
      },
      activity: world.activity,
      logger: { warn: (...args: unknown[]) => void warnings.push(args), info: () => {} },
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-permission-sweep-'));
    config = { preset: 'full', defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null };
    world = createPermissionWorld();
    warnings = [];
    writeRaw(
      'granted',
      manifestBody('granted', { enabledToolGroups: { roomsManage: true, tasks: false } })
    );
    writeRaw('refused', manifestBody('refused', { enabledToolGroups: { roomsManage: false } }));
    writeRaw('plain', manifestBody('plain', { enabledToolGroups: { tasks: false } }));
    writeRaw('broken', '{ not json');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes folded manifests back: granted keeps Rooms, refused is Blocked, the key is gone', async () => {
    await runPermissionUpgradeSweep(deps());

    expect(onDisk('granted').permissions).toEqual({ areas: { rooms: 'allowed' } });
    expect(onDisk('granted').enabledToolGroups).toEqual({ tasks: false });
    expect(onDisk('refused').permissions).toEqual({ areas: { rooms: 'blocked' } });
    expect(onDisk('refused').enabledToolGroups).toEqual({});
    // An agent that never held the key is left exactly as it was.
    expect(onDisk('plain').permissions).toBeUndefined();
  });

  it('records one upgrade event per changed agent, plus the preset the migration set', async () => {
    const written = await runPermissionUpgradeSweep(deps());

    expect(written).toBe(3);
    expect(world.events.map((e) => e.summary)).toEqual([
      'granted: Rooms Allowed',
      'refused: Rooms Blocked',
      'Preset set to Full power',
    ]);
    for (const event of world.events) {
      expect(event).toMatchObject({ actorLabel: 'Upgrade', category: 'permissions' });
      expect(event.metadata).toMatchObject({ surface: 'upgrade', attribution: 'upgrade' });
    }
  });

  it('keeps going past an agent whose file cannot be read, and says so', async () => {
    await runPermissionUpgradeSweep(deps());
    expect(warnings).toHaveLength(1);
    expect(onDisk('granted').permissions).toBeDefined();
  });

  it('runs once per server version: a second boot writes and records nothing', async () => {
    await runPermissionUpgradeSweep(deps());
    const eventsAfterFirst = world.events.length;
    writeRaw('granted', manifestBody('granted', { enabledToolGroups: { roomsManage: false } }));

    expect(await runPermissionUpgradeSweep(deps())).toBeNull();

    expect(world.events).toHaveLength(eventsAfterFirst);
    expect(onDisk('granted').enabledToolGroups).toEqual({ roomsManage: false });
    expect(config.upgradeSweptVersion).toBe('0.83.0');
  });

  it('records no preset event on an undecided install', async () => {
    config.preset = null;
    await runPermissionUpgradeSweep(deps());
    expect(world.events.some((e) => e.summary.startsWith('Preset'))).toBe(false);
  });

  it('never overwrites an explicit Rooms setting, and records no event for it', async () => {
    writeRaw(
      'granted',
      manifestBody('granted', {
        enabledToolGroups: { roomsManage: true },
        permissions: { areas: { rooms: 'ask' } },
      })
    );
    await runPermissionUpgradeSweep(deps());
    expect(onDisk('granted').permissions).toEqual({ areas: { rooms: 'ask' } });
    expect(world.events.some((e) => e.summary.startsWith('granted'))).toBe(false);
  });
});
