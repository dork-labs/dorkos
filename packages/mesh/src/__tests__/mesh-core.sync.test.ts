import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, eq } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';
import { AgentRegistry } from '../agent-registry.js';
import { writeManifest } from '../manifest.js';
import * as reconcilerModule from '../reconciler.js';
import { cleanTempDirsAfterEach, makeManifest, makeTempDir } from './mesh-core.fixtures.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

cleanTempDirsAfterEach();

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DOR-403: onLivenessChange fires when a pass marks an agent unreachable', async () => {
    const base = await makeTempDir();
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    vi.spyOn(reconcilerModule, 'reconcile').mockResolvedValue({
      synced: 0,
      unreachable: 1,
      removed: 0,
      resurrected: 0,
      discovered: 0,
    });

    const changes: number[] = [];
    mesh.onLivenessChange((r) => changes.push(r.unreachable));

    vi.useFakeTimers();
    mesh.startPeriodicReconciliation(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(changes).toEqual([1]);

    mesh.stopPeriodicReconciliation();
    vi.useRealTimers();
    mesh.close();
  });

  it('close() stops periodic reconciliation', () => {
    const base = '/tmp/mesh-close-test';
    const mesh = new MeshCore({ db, defaultScanRoot: base });

    vi.useFakeTimers();

    const spy = vi.spyOn(reconcilerModule, 'reconcile').mockResolvedValue({
      synced: 0,
      unreachable: 0,
      removed: 0,
      resurrected: 0,
      discovered: 0,
    });

    mesh.startPeriodicReconciliation(1000);
    mesh.close();

    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// ADR-0043: update() write-through
// ---------------------------------------------------------------------------

describe('update() write-through (ADR-0043)', () => {
  it('writes updated fields to manifest file on disk', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'wt-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'original',
      runtime: 'claude-code',
    });

    await mesh.update(manifest.id, { name: 'updated-name' });

    // Verify manifest file on disk reflects the change
    const { readManifest: readDisk } = await import('../manifest.js');
    const diskManifest = await readDisk(projectDir);
    expect(diskManifest).toBeDefined();
    expect(diskManifest!.name).toBe('updated-name');

    mesh.close();
  });

  it("sets and then clears an agent's model and effort, on disk and in the cache", async () => {
    // The clear is the reset the UI's provenance chip offers: "use the server
    // default". `undefined` is what a route turns the wire's `null` into, and
    // the observable claim is that the KEY is gone from `agent.json` afterwards
    // — an absent key is what "inherits" means on disk, and a key that survived
    // as `null` would read as a value.
    const base = await makeTempDir();
    const projectDir = path.join(base, 'exec-defaults');
    await fs.mkdir(projectDir, { recursive: true });
    const { readManifest: readDisk } = await import('../manifest.js');

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'picky',
      runtime: 'claude-code',
    });

    await mesh.update(manifest.id, { model: 'sonnet', effort: 'low' });
    expect((await readDisk(projectDir))!.model).toBe('sonnet');
    expect((await readDisk(projectDir))!.effort).toBe('low');
    expect(mesh.get(manifest.id)?.model).toBe('sonnet');
    expect(mesh.get(manifest.id)?.effort).toBe('low');

    await mesh.update(manifest.id, { model: undefined, effort: undefined });

    const cleared = await readDisk(projectDir);
    expect(Object.keys(cleared!)).not.toContain('model');
    expect(Object.keys(cleared!)).not.toContain('effort');
    expect(mesh.get(manifest.id)?.model).toBeUndefined();
    expect(mesh.get(manifest.id)?.effort).toBeUndefined();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// ADR-0043: syncFromDisk()
// ---------------------------------------------------------------------------

describe('syncFromDisk() (ADR-0043)', () => {
  it('syncs manifest changes from disk into DB', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'sync-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'before',
      runtime: 'claude-code',
    });

    // Manually edit manifest on disk
    const updatedManifest = { ...manifest, name: 'after' };
    await writeManifest(projectDir, updatedManifest);

    // Sync from disk
    const synced = await mesh.syncFromDisk(projectDir);
    expect(synced).toBe('synced');

    // Verify DB was updated
    const agents = mesh.list();
    expect(agents.some((a) => a.name === 'after')).toBe(true);

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// ADR-0043: unregister() file deletion
// ---------------------------------------------------------------------------

describe('unregister() file deletion (ADR-0043)', () => {
  it('deletes .dork/agent.json when unregistering', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'unreg-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'doomed-agent',
      runtime: 'claude-code',
    });

    // Verify manifest exists
    await expect(fs.access(path.join(projectDir, '.dork', 'agent.json'))).resolves.toBeUndefined();

    await mesh.unregister(manifest.id);

    // Verify manifest file is gone
    await expect(fs.access(path.join(projectDir, '.dork', 'agent.json'))).rejects.toThrow();

    mesh.close();
  });
});

describe('onUnregister callbacks', () => {
  it('invokes registered callback with agentId and pre-removal projectPath', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'callback-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'callback-agent',
      runtime: 'claude-code',
    });

    const callback = vi.fn();
    mesh.onUnregister(callback);

    // Capture the registered path before unregister wipes the registry entry
    const registeredPath = mesh.getProjectPath(manifest.id);
    expect(registeredPath).toBeDefined();

    await mesh.unregister(manifest.id);

    // The registry entry is gone by callback time — the callback must still
    // receive the project path so watchers/reconcilers can clean up.
    expect(mesh.getProjectPath(manifest.id)).toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(manifest.id, registeredPath);

    mesh.close();
  });

  it('continues executing callbacks even if one throws', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'throw-cb-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'throw-cb-agent',
      runtime: 'claude-code',
    });

    const failingCb = vi.fn(() => {
      throw new Error('callback boom');
    });
    const successCb = vi.fn();
    mesh.onUnregister(failingCb);
    mesh.onUnregister(successCb);

    await mesh.unregister(manifest.id);

    expect(failingCb).toHaveBeenCalledOnce();
    expect(successCb).toHaveBeenCalledOnce();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Reconciler sweep removal cascade
// ---------------------------------------------------------------------------

describe('reconciler sweep removal cascade', () => {
  /** Mark an agent unreachable and backdate it past the 24h grace period. */
  function expireAgent(agentId: string): void {
    const registry = new AgentRegistry(db);
    registry.markUnreachable(agentId);
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.update(agents).set({ updatedAt: expired }).where(eq(agents.id, agentId)).run();
  }

  it('fires onUnregister callbacks when the sweep removes an expired agent, like manual unregister', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'sweep-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'sweep-agent',
      runtime: 'claude-code',
    });
    const registeredPath = mesh.getProjectPath(manifest.id);
    expect(registeredPath).toBe(projectDir);

    // Consumers (e.g. the server's task-watcher wiring) key cleanup off the
    // callback — same contract as manual unregister.
    const callback = vi.fn();
    mesh.onUnregister(callback);

    // Simulate the removal scenario: path gone, grace period expired.
    await fs.rm(projectDir, { recursive: true, force: true });
    expireAgent(manifest.id);

    const result = await mesh.reconcileOnStartup();

    expect(result.removed).toBe(1);
    expect(mesh.get(manifest.id)).toBeUndefined();
    // The callback receives the recorded project path even though the path
    // is inaccessible, so watchers keyed by that path can be cleaned up.
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(manifest.id, projectDir);

    mesh.close();
  });

  it('does not fire onUnregister callbacks when an expired agent is resurrected', async () => {
    const base = await makeTempDir();
    const projectDir = path.join(base, 'resurrect-test');
    await fs.mkdir(projectDir, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: base });
    const manifest = await mesh.registerByPath(projectDir, {
      name: 'resurrect-agent',
      runtime: 'claude-code',
    });

    const callback = vi.fn();
    mesh.onUnregister(callback);

    // Grace period expired but the path is accessible again (remounted volume).
    expireAgent(manifest.id);

    const result = await mesh.reconcileOnStartup();

    expect(result.removed).toBe(0);
    expect(result.resurrected).toBe(1);
    expect(mesh.get(manifest.id)).toBeDefined();
    expect(callback).not.toHaveBeenCalled();

    mesh.close();
  });
});

// ---------------------------------------------------------------------------
// Reconciler disk discovery (ADR-0043 rebuild-from-files)
// ---------------------------------------------------------------------------

describe('reconciler disk discovery (ADR-0043)', () => {
  it('rebuilds agents from the agents home dir after the DB is wiped', async () => {
    const base = await makeTempDir();
    const agentsHome = path.join(base, 'agents');
    const dorkbotDir = path.join(agentsHome, 'dorkbot');
    await fs.mkdir(dorkbotDir, { recursive: true });
    await writeManifest(
      dorkbotDir,
      makeManifest({ id: '01SYSDORKBOT', name: 'dorkbot', namespace: 'system', isSystem: true })
    );

    // Wiped DB: the manifest exists on disk, but nothing is in the registry yet.
    const mesh = new MeshCore({ db, defaultScanRoot: base, agentsHomeDir: agentsHome });
    const registry = new AgentRegistry(db);
    expect(registry.list()).toHaveLength(0);

    const result = await mesh.reconcileOnStartup();

    expect(result.discovered).toBe(1);
    expect(registry.getByPath(dorkbotDir)?.name).toBe('dorkbot');
    // The recorded scan root is the walked root, not the default scan root —
    // a persisted default (homedir in production) would poison later walks.
    expect(registry.getByPath(dorkbotDir)?.scanRoot).toBe(agentsHome);

    mesh.close();
  });

  it('recovers a disk-only agent under a recorded scan root', async () => {
    const base = await makeTempDir();
    const scanRoot = path.join(base, 'projects');
    const registered = path.join(scanRoot, 'dorkos', 'core');
    const orphan = path.join(scanRoot, 'acme', 'api');
    await fs.mkdir(registered, { recursive: true });
    await fs.mkdir(orphan, { recursive: true });

    const mesh = new MeshCore({ db, defaultScanRoot: scanRoot });
    // A registered agent records its scanRoot; the reconciler walks it for orphans.
    await mesh.registerByPath(
      registered,
      { name: 'core', runtime: 'claude-code' },
      'test',
      scanRoot
    );
    // A manifest that exists on disk but was never registered.
    await writeManifest(
      orphan,
      makeManifest({ id: '01ORPHANAPI', name: 'api', namespace: 'acme' })
    );

    const registry = new AgentRegistry(db);
    expect(registry.getByPath(orphan)).toBeUndefined();

    const result = await mesh.reconcileOnStartup();

    expect(result.discovered).toBe(1);
    expect(registry.getByPath(orphan)?.name).toBe('api');

    mesh.close();
  });

  it('respects the denial list during reconciler discovery', async () => {
    const base = await makeTempDir();
    const agentsHome = path.join(base, 'agents');
    const goodDir = path.join(agentsHome, 'good');
    const deniedDir = path.join(agentsHome, 'denied');
    await fs.mkdir(goodDir, { recursive: true });
    await fs.mkdir(deniedDir, { recursive: true });
    await writeManifest(goodDir, makeManifest({ id: '01GOODAGENT', name: 'good' }));
    await writeManifest(deniedDir, makeManifest({ id: '01DENIEDAGENT', name: 'denied' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, agentsHomeDir: agentsHome });
    await mesh.deny(deniedDir);

    const result = await mesh.reconcileOnStartup();

    const registry = new AgentRegistry(db);
    expect(registry.getByPath(goodDir)?.name).toBe('good');
    expect(registry.getByPath(deniedDir)).toBeUndefined();
    expect(result.discovered).toBe(1);

    mesh.close();
  });

  it('does not discover manifests outside the agents home dir and recorded scan roots', async () => {
    const base = await makeTempDir();
    const agentsHome = path.join(base, 'agents');
    await fs.mkdir(agentsHome, { recursive: true });
    // A manifest that lives outside every scanned root (no recorded scan roots).
    const outsideDir = path.join(base, 'elsewhere', 'agent');
    await fs.mkdir(outsideDir, { recursive: true });
    await writeManifest(outsideDir, makeManifest({ id: '01OUTSIDER', name: 'outside' }));

    const mesh = new MeshCore({ db, defaultScanRoot: base, agentsHomeDir: agentsHome });
    const result = await mesh.reconcileOnStartup();

    expect(result.discovered).toBe(0);
    const registry = new AgentRegistry(db);
    expect(registry.getByPath(outsideDir)).toBeUndefined();

    mesh.close();
  });
});
