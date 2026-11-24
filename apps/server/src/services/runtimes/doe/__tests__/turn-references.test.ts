/**
 * The references a Doe builder's shells carry for signatures (DOR-5138): the
 * chat's Mesh agent and the local space, beside the chat id. A file of its own
 * because it initialises the real config manager, which an agent home's
 * folder-consent check reads, against a temporary data directory.
 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { holdLocalSpaceId, loadLocalSpaceId } from '../../../../lib/identity/space-id.js';
import { initConfigManager } from '../../../core/config-manager.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { makeRuntime, projectDir, collect } from './runtime-fixture.js';

let configHome: string;
beforeAll(async () => {
  configHome = await mkdtemp(path.join(os.tmpdir(), 'doe-refs-config-'));
  initConfigManager(configHome);
});
afterAll(async () => {
  await rm(configHome, { recursive: true, force: true });
});

it('DOR-5138: the builder env names the chat’s Mesh agent and the local space', async () => {
  const { assembleDoeHost } = await import('../tools.js');
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'doe-refs-')));
  const dorkHome = path.join(root, 'dork');
  const agentDir = path.join(root, 'agent');
  await mkdir(path.join(agentDir, '.dork'), { recursive: true });
  await writeFile(
    path.join(agentDir, '.dork', 'agent.json'),
    JSON.stringify({
      id: '01JAGENT0000000000000000',
      name: 'builder',
      runtime: 'doe',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'test',
    })
  );
  registerTestHomes([agentDir]);
  const spaceId = await loadLocalSpaceId(dorkHome);
  vi.stubEnv('DORKOS_AGENT_ID', 'ambient-agent');
  vi.stubEnv('DORKOS_SPACE_ID', 'ambient-space');
  const environments: Array<Readonly<Record<string, string>>> = [];
  const runtime = makeRuntime({
    assembleHost: async (options) => {
      if (options.builderExecutionPolicy?.kind === 'unrestricted')
        environments.push(options.builderExecutionPolicy.environment);
      return assembleDoeHost(options);
    },
  });
  runtime.setMeshCore({
    getByPath: (dir: string) =>
      dir === agentDir ? { id: '01JAGENT0000000000000000', name: 'builder' } : undefined,
    listWithPaths: () => [],
    updateLastSeen: () => {},
  } as unknown as AgentRegistryPort);
  try {
    for (const [id, cwd] of [
      ['doe-agent-chat', agentDir],
      ['doe-folder-chat', projectDir],
    ] as const) {
      runtime.ensureSession(id, { cwd, permissionMode: 'bypassPermissions' });
      const events = await collect(
        runtime.sendMessage(id, 'hello', { cwd, permissionMode: 'bypassPermissions' })
      );
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    }
    expect(spaceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(environments[0]).toMatchObject({
      DORKOS_SESSION_ID: 'doe-agent-chat',
      DORKOS_AGENT_ID: '01JAGENT0000000000000000',
      DORKOS_SPACE_ID: spaceId,
    });
    // A plain folder has no agent: the id is left out, never guessed or inherited.
    expect(environments[1]).toMatchObject({
      DORKOS_SESSION_ID: 'doe-folder-chat',
      DORKOS_SPACE_ID: spaceId,
    });
    expect(environments[1]).not.toHaveProperty('DORKOS_AGENT_ID');
  } finally {
    vi.unstubAllEnvs();
    holdLocalSpaceId(undefined);
    clearTestHomes();
    await rm(root, { recursive: true, force: true });
  }
});
