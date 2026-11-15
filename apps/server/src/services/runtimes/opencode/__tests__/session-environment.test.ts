import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenCodeSessionEnvironment } from '../session-environment.js';

const environments: OpenCodeSessionEnvironment[] = [];
afterEach(async () => {
  await Promise.all(environments.splice(0).map((env) => env.close()));
});

it('DOR-4380: concurrent OpenCode shells use server chat bindings, including vendor child sessions', async () => {
  const environment = new OpenCodeSessionEnvironment();
  environments.push(environment);
  const plugin = environment.plugin();
  await Promise.all([
    environment.bind('chat-alpha', 'ses_vendor_alpha'),
    environment.bind('chat-beta', 'ses_vendor_beta'),
  ]);
  // Import the actual generated module in another process, as the sidecar does.
  const script = `
    const { default: plugin } = await import(${JSON.stringify(plugin)});
    const hooks = await plugin({ client: { session: { get: async ({ path }) => ({
      data: { parentID: path.id === 'ses_child' ? 'ses_vendor_alpha' : undefined }
    }) } } });
    const results = await Promise.all(['ses_vendor_alpha', 'ses_vendor_beta', 'ses_child'].map(async sessionID => {
      const output = { env: { EXISTING: 'kept' } };
      await hooks['shell.env']({ sessionID }, output);
      return output.env;
    }));
    process.stdout.write(JSON.stringify(results));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      env: { DORKOS_SESSION_ID: 'ambient-chat' },
      timeout: 10000,
    }
  );
  expect(JSON.parse(stdout)).toEqual([
    { EXISTING: 'kept', DORKOS_SESSION_ID: 'chat-alpha' },
    { EXISTING: 'kept', DORKOS_SESSION_ID: 'chat-beta' },
    { EXISTING: 'kept', DORKOS_SESSION_ID: 'chat-alpha' },
  ]);
});
