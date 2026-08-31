/**
 * `createAgentIdentityUnregisterCascade` wired to a REAL `MeshCore`'s
 * `onUnregister`, exactly the one line `index.ts` adds (DOR-490).
 *
 * `unregister-cascade.test.ts` next door proves the cascade FUNCTION revokes
 * tokens when invoked directly — it never proves the wiring: that
 * `meshCore.onUnregister(createAgentIdentityUnregisterCascade(...))` actually
 * fires the cascade when a real unregister happens, with the arguments a real
 * `MeshCore` actually passes. Adversarial review caught this gap directly:
 * deleting the one-line wiring in `index.ts` left every test, typecheck, and
 * lint green. This test drives the real registry so that specific regression
 * cannot happen silently again.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MeshCore } from '@dorkos/mesh';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Logger } from '@dorkos/shared/logger';
import { AgentIdentityService } from '../agent-identity-service.js';
import { createAgentIdentityUnregisterCascade } from '../unregister-cascade.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildLogger(): Pick<Logger, 'info' | 'warn'> {
  return { info: vi.fn(), warn: vi.fn() };
}

let db: Db;
let relay: RelayCore;
let mesh: MeshCore;

beforeEach(async () => {
  db = createTestDb();
  relay = new RelayCore({ dataDir: await makeTempDir('agent-identity-cascade-relay-') });
});

afterEach(async () => {
  mesh?.close();
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('agent identity revocation wired to a real MeshCore unregister (DOR-490)', () => {
  it('revokes a minted token when the agent is unregistered through MeshCore', async () => {
    const base = await makeTempDir('agent-identity-cascade-base-');
    mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

    const agentDir = path.join(base, 'solo', 'agent-x');
    await fs.mkdir(agentDir, { recursive: true });
    const agent = await mesh.registerByPath(agentDir, {
      name: 'agent-x',
      runtime: 'claude-code',
      namespace: 'solo',
    });

    const identityService = new AgentIdentityService(db);
    const token = await identityService.mint({
      agentPath: agentDir,
      displayName: 'Agent X',
    });
    expect(await identityService.resolve(token)).toBeDefined();

    // The exact one-line wiring index.ts adds.
    mesh.onUnregister(createAgentIdentityUnregisterCascade(() => identityService, buildLogger()));

    await mesh.unregister(agent.id);

    // The cascade's own revoke() is fire-and-forget from the callback's
    // perspective; give its promise chain a turn before asserting.
    await vi.waitFor(async () => {
      expect(await identityService.resolve(token)).toBeUndefined();
    });
  });

  it('leaves a different agent unregistering untouched', async () => {
    const base = await makeTempDir('agent-identity-cascade-base-');
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
    await mesh.registerByPath(dirB, {
      name: 'agent-b',
      runtime: 'claude-code',
      namespace: 'team',
    });

    const identityService = new AgentIdentityService(db);
    const tokenA = await identityService.mint({ agentPath: dirA, displayName: 'Agent A' });
    const tokenB = await identityService.mint({ agentPath: dirB, displayName: 'Agent B' });

    mesh.onUnregister(createAgentIdentityUnregisterCascade(() => identityService, buildLogger()));

    await mesh.unregister(a.id);

    await vi.waitFor(async () => {
      expect(await identityService.resolve(tokenA)).toBeUndefined();
    });
    expect(await identityService.resolve(tokenB)).toBeDefined();
  });
});
