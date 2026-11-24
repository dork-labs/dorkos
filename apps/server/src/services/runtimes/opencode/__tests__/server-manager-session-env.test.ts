/**
 * The glue between the OpenCode runtime and its shells (DOR-5138): the real
 * `OpenCodeServerManager.bindSessionEnvironment` resolves the turn's references
 * (the agent id it is given, and the space id boot loaded) and binds them, and
 * the generated shell plugin then hands them to a command. No sidecar runs: the
 * bind and the plugin are files, which is all this path touches.
 *
 * @vitest-environment node
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { holdLocalSpaceId, loadLocalSpaceId } from '../../../../lib/identity/space-id.js';
import { OpenCodeServerManager } from '../server-manager.js';
import type { OpenCodeSessionEnvironment } from '../session-environment.js';

let dorkHome: string;
let manager: OpenCodeServerManager;

beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-refs-'));
  manager = new OpenCodeServerManager();
});

afterEach(async () => {
  holdLocalSpaceId(undefined);
  await manager.shutdown();
  await rm(dorkHome, { recursive: true, force: true });
});

/** Run the manager's generated plugin, as the sidecar would, for one session. */
async function shellEnvFor(sessionID: string): Promise<Record<string, string>> {
  // The plugin URL is what the sidecar config is given; read it the same way.
  const plugin = (
    manager as unknown as { sessionEnvironment: OpenCodeSessionEnvironment }
  ).sessionEnvironment.plugin();
  const script = `
    const { default: plugin } = await import(${JSON.stringify(plugin)});
    const hooks = await plugin({ client: { session: { get: async () => ({ data: {} }) } } });
    const output = { env: { EXISTING: 'kept' } };
    await hooks['shell.env']({ sessionID: ${JSON.stringify(sessionID)} }, output);
    process.stdout.write(JSON.stringify(output.env));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 10000 }
  );
  return JSON.parse(stdout) as Record<string, string>;
}

it('binds the agent id it is given and the space id boot loaded', async () => {
  const spaceId = await loadLocalSpaceId(dorkHome);
  expect(spaceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

  await manager.bindSessionEnvironment('chat-alpha', 'ses_alpha', '01JAGENT0000000000000000');

  expect(await shellEnvFor('ses_alpha')).toEqual({
    EXISTING: 'kept',
    DORKOS_SESSION_ID: 'chat-alpha',
    DORKOS_AGENT_ID: '01JAGENT0000000000000000',
    DORKOS_SPACE_ID: spaceId,
  });
});

it('binds only the chat id when there is no agent and the server never booted', async () => {
  await manager.bindSessionEnvironment('chat-beta', 'ses_beta');

  expect(await shellEnvFor('ses_beta')).toEqual({
    EXISTING: 'kept',
    DORKOS_SESSION_ID: 'chat-beta',
  });
});
