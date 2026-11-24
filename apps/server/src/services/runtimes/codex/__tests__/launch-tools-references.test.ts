/**
 * The references a Codex turn's shells carry for signatures (DOR-5138): the
 * Mesh agent registered at the turn's home, and the local space. A file of its
 * own because it initialises the real config manager, which an agent home's
 * folder-consent check reads, against a temporary data directory.
 *
 * @vitest-environment node
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { resetLocalSpaceIdForTests, loadLocalSpaceId } from '../../../../lib/identity/space-id.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { resolveCodexLaunchTools } from '../mcp-server-config.js';

let configHome: string;
beforeAll(async () => {
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-refs-config-'));
  initConfigManager(configHome);
});
afterAll(async () => {
  await fs.rm(configHome, { recursive: true, force: true });
});

describe('resolveCodexLaunchTools — the references a signature carries (DOR-5138)', () => {
  async function launchTools(mesh: AgentRegistryPort | undefined) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-refs-'));
    const dorkHome = path.join(root, 'dork');
    const home = path.join(root, 'agent');
    const spaceId = await loadLocalSpaceId(dorkHome);
    try {
      const tools = await resolveCodexLaunchTools(
        home,
        home,
        false,
        undefined,
        mesh,
        null,
        [],
        'app-server'
      );
      return { tools, home, spaceId };
    } finally {
      resetLocalSpaceIdForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('names the Mesh agent registered at the turn’s home, and the local space', async () => {
    let asked: string | undefined;
    const mesh = {
      getByPath: (dir: string) => {
        asked = dir;
        return { id: '01JAGENT0000000000000000', name: 'scout' };
      },
      listWithPaths: () => [],
    } as unknown as AgentRegistryPort;
    const { tools, home, spaceId } = await launchTools(mesh);
    expect(asked).toBe(home);
    expect(spaceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(tools.referenceEnv).toEqual({
      DORKOS_AGENT_ID: '01JAGENT0000000000000000',
      DORKOS_SPACE_ID: spaceId,
    });
  });

  it('leaves the agent out when no agent is registered there', async () => {
    const { tools, spaceId } = await launchTools(undefined);
    expect(tools.referenceEnv).toEqual({ DORKOS_SPACE_ID: spaceId });
  });
});
