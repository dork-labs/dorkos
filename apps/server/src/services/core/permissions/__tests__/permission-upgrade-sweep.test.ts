/**
 * The boot-time permission upgrade (spec `agent-permissions` D13), over real
 * manifest files in a temp directory.
 *
 * The retirements run on every boot and act only on what is left: a manifest
 * still carrying `enabledToolGroups` or `tierCeiling` is folded and written back
 * with the field gone, the config's `agentContext` is folded into the defaults,
 * and each is recorded once. The preset record runs once per server version.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { PermissionConfigInput } from '@dorkos/shared/permissions';

import {
  OBSERVE_CEILING_NOTE,
  readRawManifestFile,
  runPermissionRetirements,
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

describe('the permission upgrade', () => {
  let root: string;
  let config: PermissionConfigInput & { upgradeSweptVersion: string | null };
  let world: ReturnType<typeof createPermissionWorld>;
  let warnings: unknown[];
  const agents = ['granted', 'refused', 'plain', 'capped', 'broken'];
  let agentContext: Record<string, unknown> | undefined;

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
      retireAgentContext: () => {
        if (agentContext === undefined) return null;
        const off = Object.entries({
          tasksTools: 'tasks',
          relayTools: 'messages',
          meshTools: 'agents',
          adapterTools: 'connections',
        } as const)
          .filter(([key]) => agentContext![key] === false)
          .map(([, area]) => area);
        agentContext = undefined;
        return off;
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
    writeRaw('plain', manifestBody('plain', {}));
    writeRaw('capped', manifestBody('capped', { tierCeiling: 'observe' }));
    writeRaw('broken', '{ not json');
    agentContext = undefined;
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes folded manifests back with the retired fields gone', async () => {
    await runPermissionRetirements(deps());

    expect(onDisk('granted').permissions).toEqual({
      areas: { rooms: 'allowed', tasks: 'blocked' },
    });
    expect(onDisk('granted')).not.toHaveProperty('enabledToolGroups');
    expect(onDisk('refused').permissions).toEqual({ areas: { rooms: 'blocked' } });
    expect(onDisk('capped').permissions.areas).toMatchObject({
      rooms: 'blocked',
      reach: 'blocked',
    });
    expect(Object.keys(onDisk('capped').permissions.areas)).toHaveLength(10);
    expect(onDisk('capped')).not.toHaveProperty('tierCeiling');
    // An agent that never held a retired field is left exactly as it was.
    expect(onDisk('plain').permissions).toBeUndefined();
  });

  it('records one upgrade event per changed agent, the capped one with its note', async () => {
    const written = await runPermissionRetirements(deps());

    expect(written).toBe(3);
    expect(world.events.map((e) => e.resourceLabel)).toEqual(['granted', 'refused', 'capped']);
    for (const event of world.events) {
      expect(event).toMatchObject({ actorLabel: 'Upgrade', category: 'permissions' });
      expect(event.metadata).toMatchObject({ surface: 'upgrade', attribution: 'upgrade' });
    }
    const capped = world.events.find((e) => e.resourceLabel === 'capped')!;
    expect(capped.metadata).toMatchObject({ note: OBSERVE_CEILING_NOTE });
    expect((capped.metadata as { changes: unknown[] }).changes).toHaveLength(10);
  });

  it('keeps going past an agent whose file cannot be read, and says so', async () => {
    await runPermissionRetirements(deps());
    expect(warnings).toHaveLength(1);
    expect(onDisk('granted').permissions).toBeDefined();
  });

  it('runs on every boot and does nothing once the fields are gone', async () => {
    await runPermissionRetirements(deps());
    const eventsAfterFirst = world.events.length;

    expect(await runPermissionRetirements(deps())).toBe(0);
    expect(world.events).toHaveLength(eventsAfterFirst);

    // A file that arrives with a retired field later (a restored backup, a
    // package) is folded on the next boot, whatever the version marker says.
    writeRaw('plain', manifestBody('plain', { enabledToolGroups: { relay: false } }));
    expect(await runPermissionRetirements(deps())).toBe(1);
    expect(onDisk('plain').permissions).toEqual({ areas: { messages: 'blocked' } });
  });

  it('never overwrites an explicit area, and records no event for it', async () => {
    writeRaw(
      'granted',
      manifestBody('granted', {
        enabledToolGroups: { roomsManage: true },
        permissions: { areas: { rooms: 'ask' } },
      })
    );
    await runPermissionRetirements(deps());
    expect(onDisk('granted').permissions).toEqual({ areas: { rooms: 'ask' } });
    expect(world.events.some((e) => e.resourceLabel === 'granted')).toBe(false);
  });

  it('records the retired agentContext switches that were off, once, for everyone', async () => {
    agentContext = { relayTools: false, meshTools: true, adapterTools: false, tasksTools: true };
    await runPermissionRetirements(deps());
    const event = world.events.find((e) => e.resourceLabel === 'Everyone');
    expect(event?.metadata).toMatchObject({
      surface: 'upgrade',
      changes: [
        { target: { kind: 'default' }, key: { kind: 'area', area: 'messages' }, after: 'blocked' },
        {
          target: { kind: 'default' },
          key: { kind: 'area', area: 'connections' },
          after: 'blocked',
        },
      ],
    });
    // Gone after the first boot, so the second records nothing more.
    const count = world.events.length;
    await runPermissionRetirements(deps());
    expect(world.events).toHaveLength(count);
  });

  it('folds on an install that already ran the 0.83.0 upgrade before phase 3 existed', async () => {
    // 0.83.0 shipped phases 1 and 2; an install on it has run that version's
    // config migration and its once-per-version sweep, and neither will run
    // again. The phase 3 folds keep no version marker, so they still happen.
    config = { ...config, upgradeSweptVersion: '0.83.0' };
    agentContext = { relayTools: false };
    expect(await runPermissionUpgradeSweep(deps('0.83.0'))).toBeNull();

    expect(await runPermissionRetirements(deps('0.83.0'))).toBe(4);
    expect(onDisk('capped')).not.toHaveProperty('tierCeiling');
    expect(onDisk('granted')).not.toHaveProperty('enabledToolGroups');
    expect(agentContext).toBeUndefined();
  });

  it('folds the same on an older install, after its 0.83.0 sweep runs', async () => {
    expect(await runPermissionUpgradeSweep(deps('0.84.0'))).toBe(1);
    expect(await runPermissionRetirements(deps('0.84.0'))).toBe(3);
    expect(onDisk('capped')).not.toHaveProperty('tierCeiling');
  });

  it('records the preset the migration set, once per server version', async () => {
    expect(await runPermissionUpgradeSweep(deps())).toBe(1);
    expect(world.events.map((e) => e.summary)).toEqual(['Preset set to Full power']);
    expect(config.upgradeSweptVersion).toBe('0.83.0');
    expect(await runPermissionUpgradeSweep(deps())).toBeNull();
    expect(world.events).toHaveLength(1);
  });

  it('records no preset event on an undecided install', async () => {
    config.preset = null;
    await runPermissionUpgradeSweep(deps());
    expect(world.events.some((e) => e.summary.startsWith('Preset'))).toBe(false);
  });
});
