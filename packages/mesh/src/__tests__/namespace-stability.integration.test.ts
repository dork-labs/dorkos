/**
 * Integration: a managed agent's namespace is the same five minutes after it
 * was created as it was at creation (DOR-1342).
 *
 * Managed agents — the ones DorkOS creates for you, plus DorkBot — live under
 * `{dorkHome}/agents/<slug>`. Two different code paths used to derive their
 * namespace from two different scan roots: creation (`syncFromDisk`) fell back
 * to the home directory and produced `dork` (the first segment of
 * `.dork/agents/<slug>`), while the reconciler walked the agents home dir five
 * minutes later and produced `<slug>`. Two agents created in the app could
 * therefore talk for a few minutes and then silently could not, and the
 * abandoned namespace's Relay rules lingered forever.
 *
 * Drives the REAL MeshCore over a REAL RelayCore, with a temp directory
 * standing in for the home directory, so the two derivations are compared
 * exactly as production wires them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { MeshCore } from '../mesh-core.js';
import { AgentRegistry } from '../agent-registry.js';
import { writeManifest } from '../manifest.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JKNSDRIFT0001',
    name: 'alpha',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-18T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
}

let db: Db;
let relay: RelayCore;
let mesh: MeshCore | undefined;
/** Stands in for the operator's home directory. */
let home: string;
/** `{dorkHome}/agents` — where managed agents live. */
let agentsHomeDir: string;

beforeEach(async () => {
  db = createTestDb();
  const dataDir = await makeTempDir('mesh-ns-relay-');
  relay = new RelayCore({ dataDir });
  home = await makeTempDir('mesh-ns-home-');
  agentsHomeDir = path.join(home, '.dork', 'agents');
  await fs.mkdir(agentsHomeDir, { recursive: true });
});

afterEach(async () => {
  mesh?.close();
  mesh = undefined;
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Scaffold a managed agent on disk the way the agent creator does. */
async function scaffoldManagedAgent(slug: string, overrides: Partial<AgentManifest> = {}) {
  const dir = path.join(agentsHomeDir, slug);
  await fs.mkdir(dir, { recursive: true });
  await writeManifest(dir, makeManifest({ name: slug, ...overrides }));
  return dir;
}

/** Every access rule Relay holds that names this namespace on either side. */
function rulesNaming(namespace: string) {
  const pattern = `relay.agent.${namespace}.*`;
  return relay.listAccessRules().filter((r) => r.from === pattern || r.to === pattern);
}

/** Build production's wiring: agents home dir set, scan root left to the home dir. */
function bootMesh(logger?: ConstructorParameters<typeof MeshCore>[0]['logger']): MeshCore {
  return new MeshCore({
    db,
    relayCore: relay,
    agentsHomeDir,
    // Production passes no `defaultScanRoot`, so MeshCore falls back to the
    // home directory. The temp dir stands in for it, keeping the test off the
    // real one while reproducing the same shape: `{home}/.dork/agents/<slug>`.
    defaultScanRoot: home,
    logger,
  });
}

describe('managed-agent namespace stability (real MeshCore + RelayCore)', () => {
  it('keeps the namespace it derived at creation when the reconciler walks the same agent', async () => {
    mesh = bootMesh();
    const dir = await scaffoldManagedAgent('alpha');

    // Creation: the agent creator writes the manifest, then syncs it in.
    expect(await mesh.syncFromDisk(dir)).toBe('synced');
    const atCreation = mesh.agentRegistry.getByPath(dir)?.namespace;
    expect(atCreation).toBe('alpha');

    // Five minutes later.
    await mesh.reconcileOnStartup();

    expect(mesh.agentRegistry.getByPath(dir)?.namespace).toBe(atCreation);
  });

  it('gives two agents created in the app one Relay identity each, before and after reconcile', async () => {
    mesh = bootMesh();
    const dirA = await scaffoldManagedAgent('alpha', { id: '01JKNSDRIFT000A' });
    const dirB = await scaffoldManagedAgent('beta', { id: '01JKNSDRIFT000B' });

    await mesh.syncFromDisk(dirA);
    await mesh.syncFromDisk(dirB);
    const subjectsAtCreation = relay
      .listEndpoints()
      .map((e) => e.subject)
      .sort();

    await mesh.reconcileOnStartup();

    expect(
      relay
        .listEndpoints()
        .map((e) => e.subject)
        .sort()
    ).toEqual(subjectsAtCreation);
    expect(subjectsAtCreation).toEqual([
      'relay.agent.alpha.01JKNSDRIFT000A',
      'relay.agent.beta.01JKNSDRIFT000B',
    ]);
  });

  it('cleans up the abandoned namespace when an existing install flips on its first reconcile', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    mesh = bootMesh(logger);
    const dir = await scaffoldManagedAgent('alpha');

    // An install from before the fix: the row landed in the `dork` namespace,
    // with the home directory recorded as its scan root, and Relay holds that
    // namespace's default rules and its endpoint.
    const registry = new AgentRegistry(db);
    registry.upsert({
      ...makeManifest({ name: 'alpha' }),
      projectPath: dir,
      namespace: 'dork',
      scanRoot: home,
    });
    await relay.registerEndpoint('relay.agent.dork.01JKNSDRIFT0001');
    relay.addAccessRule({
      from: 'relay.agent.dork.*',
      to: 'relay.agent.dork.*',
      action: 'allow',
      priority: 100,
    });
    relay.addAccessRule({
      from: 'relay.agent.dork.*',
      to: 'relay.agent.>',
      action: 'deny',
      priority: 10,
    });

    await mesh.reconcileOnStartup();

    expect(registry.getByPath(dir)?.namespace).toBe('alpha');
    // No rules and no endpoint left behind for a namespace with zero agents.
    expect(rulesNaming('dork')).toEqual([]);
    expect(relay.listEndpoints().map((e) => e.subject)).toEqual([
      'relay.agent.alpha.01JKNSDRIFT0001',
    ]);
    // A flip is now a signal, so it is said out loud exactly once.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('namespace'),
      expect.objectContaining({ from: 'dork', to: 'alpha' })
    );
  });

  it("keeps a namespace's rules while another agent still lives in it", async () => {
    mesh = bootMesh();
    const dir = await scaffoldManagedAgent('alpha');
    const registry = new AgentRegistry(db);
    registry.upsert({
      ...makeManifest({ name: 'alpha' }),
      projectPath: dir,
      namespace: 'dork',
      scanRoot: home,
    });
    // A second agent genuinely lives in `dork` — outside the agents home dir,
    // so nothing moves it.
    const outsider = path.join(home, '.dork', 'legacy-agent');
    await fs.mkdir(outsider, { recursive: true });
    await mesh.registerByPath(outsider, { name: 'legacy', runtime: 'claude-code' }, 'test', home);

    await mesh.reconcileOnStartup();

    expect(registry.getByPath(dir)?.namespace).toBe('alpha');
    expect(registry.getByPath(outsider)?.namespace).toBe('dork');

    expect(rulesNaming('dork').length).toBeGreaterThan(0);
  });

  it('sweeps away rules an older version orphaned, and leaves live and user-configured ones alone', async () => {
    mesh = bootMesh();
    const dir = await scaffoldManagedAgent('alpha');
    await mesh.syncFromDisk(dir);

    // What an install that already flipped in an earlier version is carrying:
    // a whole namespace's default rules with no agent behind them.
    relay.addAccessRule({
      from: 'relay.agent.dork.*',
      to: 'relay.agent.dork.*',
      action: 'allow',
      priority: 100,
    });
    relay.addAccessRule({
      from: 'relay.agent.dork.*',
      to: 'relay.agent.>',
      action: 'deny',
      priority: 10,
    });
    relay.addAccessRule({
      from: 'relay.agent.>',
      to: 'relay.agent.dork.*',
      action: 'allow',
      priority: 200,
    });
    // A grant the person configured themselves, naming a namespace with no
    // agents in it. Theirs to keep: the Mesh rule store owns it, not Relay.
    relay.addAccessRule({
      from: 'relay.agent.alpha.*',
      to: 'relay.agent.dork.*',
      action: 'allow',
      priority: 50,
    });

    await mesh.reconcileOnStartup();

    expect(rulesNaming('dork')).toEqual([
      {
        from: 'relay.agent.alpha.*',
        to: 'relay.agent.dork.*',
        action: 'allow',
        priority: 50,
      },
    ]);
    // The live namespace keeps its own rules.
    expect(rulesNaming('alpha').some((r) => r.to === 'relay.agent.alpha.*')).toBe(true);
  });
});
