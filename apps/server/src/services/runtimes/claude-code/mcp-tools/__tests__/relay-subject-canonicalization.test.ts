/**
 * `canonicalizeAgentSubject` against a REAL `MeshCore` and a REAL `RelayCore`.
 *
 * The unit tests next door drive it through a stubbed `getSubject`, which proves
 * the wiring but cannot prove the RULE: a stub answers whatever the test told it
 * to, so a pass-through case against one is satisfied by the stub's own silence
 * rather than by the registry genuinely not knowing that id. These cases use the
 * registry the production code uses, so "this is not an agent id" is a fact
 * about the registry and not about the fixture.
 *
 * What has to hold, in both directions:
 *
 * - a bare `relay.agent.<agentId>` for a REGISTERED agent becomes that agent's
 *   canonical four-segment endpoint — the address every access rule matches;
 * - a subject that merely LOOKS like one does not move. The wildcard forms
 *   (`relay.agent.*`, `relay.agent.>`) matter most here: they parse as the same
 *   three-token shape, they are what an ACL rule is written in, and rewriting
 *   one would silently narrow a broadcast to a single agent.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MeshCore } from '@dorkos/mesh';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

import { canonicalizeAgentSubject } from '../relay-helpers.js';
import type { McpToolDeps } from '../types.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dor1337-canon-'));
  tempDirs.push(dir);
  return dir;
}

let db: Db;
let relay: RelayCore;
let mesh: MeshCore;
let deps: McpToolDeps;
let agentId: string;
let canonical: string;

beforeEach(async () => {
  db = createTestDb();
  relay = new RelayCore({ dataDir: await makeTempDir() });
  const base = await makeTempDir();
  mesh = new MeshCore({ db, relayCore: relay, defaultScanRoot: base });

  const agentDir = path.join(base, 'proj-b', 'agent-b');
  await fs.mkdir(agentDir, { recursive: true });
  const manifest = await mesh.registerByPath(agentDir, {
    name: 'agent-b',
    runtime: 'claude-code',
  });
  agentId = manifest.id;
  canonical = mesh.inspect(agentId)!.relaySubject!;

  deps = { meshCore: mesh } as unknown as McpToolDeps;
});

afterEach(async () => {
  mesh?.close();
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('canonicalizeAgentSubject against the real registry (DOR-1337)', () => {
  it('rewrites a bare registered agent id to the address the ACL matches', () => {
    expect(canonical).toBe(`relay.agent.proj-b.${agentId}`);
    expect(canonicalizeAgentSubject(deps, `relay.agent.${agentId}`)).toBe(canonical);
  });

  it('leaves the canonical subject exactly as it is', () => {
    expect(canonicalizeAgentSubject(deps, canonical)).toBe(canonical);
  });

  it.each([
    ['single-segment wildcard', 'relay.agent.*'],
    ['multi-segment wildcard', 'relay.agent.>'],
    ['namespaced wildcard', 'relay.agent.proj-b.*'],
  ])('never rewrites a %s — it is how rules and broadcasts are addressed', (_label, subject) => {
    expect(canonicalizeAgentSubject(deps, subject)).toBe(subject);
  });

  it('leaves a legacy session subject alone: a session id is not an agent id', () => {
    const sessionSubject = 'relay.agent.7f3c9a12-0000-4000-8000-000000000000';
    expect(canonicalizeAgentSubject(deps, sessionSubject)).toBe(sessionSubject);
  });

  it('leaves a runtime-scoped session subject alone', () => {
    const runtimeScoped = `relay.agent.claude-code.${agentId}`;
    expect(canonicalizeAgentSubject(deps, runtimeScoped)).toBe(runtimeScoped);
  });

  it('leaves non-agent subjects alone', () => {
    for (const subject of [
      `relay.inbox.${agentId}`,
      'relay.system.console',
      'relay.human.console.client-1',
      'relay.agent',
    ]) {
      expect(canonicalizeAgentSubject(deps, subject)).toBe(subject);
    }
  });

  it('stops rewriting the moment the agent is unregistered', async () => {
    // The registry is the whole rule, so removing the row must remove the
    // rewrite — a cached or hard-coded mapping would keep answering here.
    await mesh.unregister(agentId);
    expect(canonicalizeAgentSubject(deps, `relay.agent.${agentId}`)).toBe(`relay.agent.${agentId}`);
  });
});
