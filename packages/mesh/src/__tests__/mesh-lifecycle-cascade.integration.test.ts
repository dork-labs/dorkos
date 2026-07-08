/**
 * Integration: the mesh lifecycle cascade through the REAL MeshCore + REAL
 * RelayCore (no mocked relay).
 *
 * The unit tests (`mesh-core.test.ts`, `reconciler.test.ts`) mock RelayCore and
 * assert on `vi.fn()` call counts. This test drives the real bridge so the
 * observable seam can't drift: registering wires a real relay endpoint + real
 * namespace access rules; unregistering removes the endpoint, fires the
 * `onUnregister` cascade with the pre-removal projectPath (the #2 fix), and
 * cleans namespace rules only once the last agent in the namespace is gone;
 * resurrection re-marks a recovered agent WITHOUT firing the removal cascade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let db: Db;
let relay: RelayCore;
let mesh: MeshCore;

beforeEach(async () => {
  db = createTestDb();
  const dataDir = await makeTempDir('mesh-cascade-data-');
  relay = new RelayCore({ dataDir });
});

afterEach(async () => {
  mesh?.close();
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function hasEndpoint(subject: string): boolean {
  return relay.listEndpoints().some((e) => e.subject === subject);
}

function hasSameNamespaceAllow(namespace: string): boolean {
  const self = `relay.agent.${namespace}.*`;
  return relay
    .listAccessRules()
    .some((r) => r.from === self && r.to === self && r.action === 'allow');
}

describe('mesh unregister cascade (real MeshCore + RelayCore)', () => {
  it('removes the relay endpoint, fires onUnregister with the pre-removal path, and defers namespace-rule cleanup to the last agent', async () => {
    const base = await makeTempDir('mesh-cascade-base-');
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

    const dirA = path.join(base, 'team', 'agent-a');
    const dirB = path.join(base, 'team', 'agent-b');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const a = await mesh.registerByPath(dirA, {
      name: 'agent-a',
      runtime: 'claude-code',
      namespace: 'team',
    });
    const b = await mesh.registerByPath(dirB, {
      name: 'agent-b',
      runtime: 'claude-code',
      namespace: 'team',
    });

    const subjectA = mesh.inspect(a.id)!.relaySubject!;
    const subjectB = mesh.inspect(b.id)!.relaySubject!;
    expect(subjectA).toBe(`relay.agent.team.${a.id}`);

    // Registration wired real relay endpoints + a same-namespace allow rule.
    expect(hasEndpoint(subjectA)).toBe(true);
    expect(hasEndpoint(subjectB)).toBe(true);
    expect(hasSameNamespaceAllow('team')).toBe(true);

    const cascade = vi.fn<(agentId: string, projectPath: string) => void>();
    mesh.onUnregister(cascade);

    // --- Unregister the first agent: endpoint gone, cascade fired with its own
    //     (pre-removal) projectPath, namespace rules retained (agent-b remains).
    await mesh.unregister(a.id);

    expect(hasEndpoint(subjectA)).toBe(false);
    expect(hasEndpoint(subjectB)).toBe(true);
    expect(cascade).toHaveBeenCalledTimes(1);
    expect(cascade).toHaveBeenCalledWith(a.id, dirA);
    expect(hasSameNamespaceAllow('team')).toBe(true);

    // --- Unregister the last agent: its endpoint goes, cascade fires with its
    //     path, and now the namespace access rules are cleaned up.
    await mesh.unregister(b.id);

    expect(hasEndpoint(subjectB)).toBe(false);
    expect(cascade).toHaveBeenCalledTimes(2);
    expect(cascade).toHaveBeenCalledWith(b.id, dirB);
    expect(hasSameNamespaceAllow('team')).toBe(false);
  });
});

describe('mesh resurrection does not fire the removal cascade', () => {
  it('reconcile marks an inaccessible agent unreachable, then resurrects it on recovery without cascading', async () => {
    const base = await makeTempDir('mesh-resurrect-base-');
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

    const agentDir = path.join(base, 'solo', 'agent-x');
    await fs.mkdir(agentDir, { recursive: true });
    const x = await mesh.registerByPath(agentDir, {
      name: 'agent-x',
      runtime: 'claude-code',
      namespace: 'solo',
    });
    const subjectX = mesh.inspect(x.id)!.relaySubject!;

    const cascade = vi.fn<(agentId: string, projectPath: string) => void>();
    mesh.onUnregister(cascade);

    // Move the project out of the scan root so it is neither accessible nor
    // rediscoverable — the reconciler must mark it unreachable, not remove it
    // (24h grace), and must not fire the cascade.
    const stashed = await makeTempDir('mesh-resurrect-stash-');
    const stashedPath = path.join(stashed, 'agent-x');
    await fs.rename(agentDir, stashedPath);

    const pass1 = await mesh.reconcileOnStartup();
    expect(pass1.removed).toBe(0);
    expect(cascade).not.toHaveBeenCalled();
    expect(mesh.getProjectPath(x.id)).toBe(agentDir); // still registered, just unreachable
    expect(hasEndpoint(subjectX)).toBe(true); // endpoint retained across the grace window

    // Recover the project — the next reconcile resurrects it, still no cascade.
    await fs.rename(stashedPath, agentDir);

    const pass2 = await mesh.reconcileOnStartup();
    expect(pass2.resurrected).toBe(1);
    expect(pass2.removed).toBe(0);
    expect(cascade).not.toHaveBeenCalled();
  });
});
