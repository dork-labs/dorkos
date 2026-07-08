/**
 * Integration: sender identity resolution against the REAL registry + REAL
 * RelayCore access control.
 *
 * Regression coverage for the M6 identity fix: `MeshCore.getByPath()` returns
 * a public manifest with `namespace` stripped, so building a subject from it
 * silently degrades the namespace to `basename(projectPath)` — matching no
 * access rule for nested or explicit-namespace agents. Identity must come
 * from `getSubjectByPath()` (the un-stripped registry entry), and must equal
 * the `relaySubject` that `inspect()` reports — the same subject the Relay
 * endpoint and allow/deny rules were registered with.
 *
 * Also proves the system-agent (DorkBot) access invariants end-to-end through
 * RelayCore's real AccessControl: DorkBot <-> project agents allowed in both
 * directions; project agent -> project agent across namespaces denied.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-identity-int-'));
  tempDirs.push(dir);
  return dir;
}

let db: Db;
let relay: RelayCore;
let mesh: MeshCore;

beforeEach(async () => {
  db = createTestDb();
  const dataDir = await makeTempDir();
  relay = new RelayCore({ dataDir });
});

afterEach(async () => {
  mesh?.close();
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('sender identity resolves the registered namespace (M6 regression)', () => {
  it('nested layout: getSubjectByPath matches inspect().relaySubject, not basename', async () => {
    const base = await makeTempDir();
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

    // Nested: namespace derives from the FIRST segment under the scan root
    // ("teams"), while basename(projectPath) is "agent-a".
    const agentDir = path.join(base, 'teams', 'alpha', 'agent-a');
    await fs.mkdir(agentDir, { recursive: true });
    const manifest = await mesh.registerByPath(agentDir, {
      name: 'agent-a',
      runtime: 'claude-code',
    });

    const identity = mesh.getSubjectByPath(agentDir);
    expect(identity).toBeDefined();
    expect(identity!.agentId).toBe(manifest.id);

    // The invariant: the identity subject IS the registered endpoint subject.
    expect(identity!.subject).toBe(mesh.inspect(manifest.id)!.relaySubject);
    expect(identity!.subject).toBe(`relay.agent.teams.${manifest.id}`);

    // The bug shape: a basename-derived subject matches no registered rule.
    expect(identity!.subject).not.toBe(`relay.agent.agent-a.${manifest.id}`);
  });

  it('explicit-namespace manifest: getSubjectByPath carries the manifest namespace', async () => {
    const base = await makeTempDir();
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

    const agentDir = path.join(base, 'other', 'agent-b');
    await fs.mkdir(agentDir, { recursive: true });
    const manifest = await mesh.registerByPath(agentDir, {
      name: 'agent-b',
      runtime: 'claude-code',
      namespace: 'custom-ns',
    });

    const identity = mesh.getSubjectByPath(agentDir);
    expect(identity!.subject).toBe(`relay.agent.custom-ns.${manifest.id}`);
    expect(identity!.subject).toBe(mesh.inspect(manifest.id)!.relaySubject);
  });

  it('getSubjectByPath returns undefined for unregistered paths', async () => {
    const base = await makeTempDir();
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });
    expect(mesh.getSubjectByPath(path.join(base, 'nowhere'))).toBeUndefined();
  });
});

describe('system agent (DorkBot) access through real AccessControl', () => {
  it('DorkBot <-> project agents allowed both ways; cross-namespace peers denied', async () => {
    const base = await makeTempDir();
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

    // Two project agents in different namespaces + the system agent.
    const dirA = path.join(base, 'proj-a', 'agent');
    const dirB = path.join(base, 'proj-b', 'agent');
    const dirBot = path.join(base, 'system', 'dorkbot');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.mkdir(dirBot, { recursive: true });

    await mesh.registerByPath(dirA, { name: 'agent-a', runtime: 'claude-code' });
    await mesh.registerByPath(dirB, { name: 'agent-b', runtime: 'claude-code' });
    await mesh.registerByPath(dirBot, {
      name: 'dorkbot',
      runtime: 'claude-code',
      namespace: 'system',
      isSystem: true,
    });

    const subjectA = mesh.getSubjectByPath(dirA)!.subject;
    const subjectB = mesh.getSubjectByPath(dirB)!.subject;
    const subjectBot = mesh.getSubjectByPath(dirBot)!.subject;

    // Cross-namespace peer messaging: denied by default (ADR-0033).
    await expect(relay.publish(subjectB, { hi: 1 }, { from: subjectA })).rejects.toThrow(
      /Access denied/
    );

    // Same-namespace self loop: allowed.
    await expect(relay.publish(subjectA, { hi: 1 }, { from: subjectA })).resolves.toBeDefined();

    // DorkBot -> project agent: allowed (system allow beats the deny).
    await expect(relay.publish(subjectA, { hi: 1 }, { from: subjectBot })).resolves.toBeDefined();

    // Project agent -> DorkBot: allowed.
    await expect(relay.publish(subjectBot, { hi: 1 }, { from: subjectA })).resolves.toBeDefined();
  });
});
