/**
 * Before the permission gate is wired, it reads no agent's own settings
 * (review D1): the wired reader is the only one that narrows an arriving
 * agent's unscreened folder settings, so a turn started early in boot must
 * follow the defaults rather than whatever a folder's file says.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { permissionGateSources, resetPermissionGate } from '../permission-enforcement.js';
import { readAgentExecutionDefaults } from '../../../session/resolve-session-defaults.js';

const dirs: string[] = [];
afterEach(async () => {
  resetPermissionGate();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('the permission gate before it is wired', () => {
  it("reads no agent's own settings, so a pending agent's file cannot start it at autonomy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-default-'));
    dirs.push(dir);
    await writeManifest(dir, {
      id: '01JKGATEDEFAULT00000000000',
      name: 'early',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'test',
      personaEnabled: true,
      mcpServers: [],
      permissions: { areas: { rooms: 'allowed' }, filesAndCommands: 'autonomy' },
    } as unknown as AgentManifest);
    resetPermissionGate();

    expect(await permissionGateSources().readAgentPermissions(dir)).toBeUndefined();
    expect((await readAgentExecutionDefaults(dir)).filesAndCommands).toBeUndefined();
  });
});
