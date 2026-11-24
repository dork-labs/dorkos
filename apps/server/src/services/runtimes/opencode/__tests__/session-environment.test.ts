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

it('DOR-4380: a session lookup that fails leaves the chat id unset instead of failing the command', async () => {
  const environment = new OpenCodeSessionEnvironment();
  environments.push(environment);
  const plugin = environment.plugin();
  await environment.bind('chat-alpha', 'ses_vendor_alpha');
  const script = `
    const { default: plugin } = await import(${JSON.stringify(plugin)});
    const hooks = await plugin({ client: { session: { get: async () => {
      throw new Error('lookup failed');
    } } } });
    const output = { env: { EXISTING: 'kept' } };
    await hooks['shell.env']({ sessionID: 'ses_unbound_child' }, output);
    process.stdout.write(JSON.stringify(output.env));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 10000 }
  );
  expect(JSON.parse(stdout)).toEqual({ EXISTING: 'kept' });
});

it('DOR-5138: shells carry their chat’s agent and space, and never an ambient or stale one', async () => {
  const environment = new OpenCodeSessionEnvironment();
  environments.push(environment);
  const plugin = environment.plugin();
  await Promise.all([
    environment.bind('chat-alpha', 'ses_vendor_alpha', {
      DORKOS_AGENT_ID: '01JAGENT0000000000000000',
      DORKOS_SPACE_ID: '01JSPACE0000000000000000AB',
    }),
    // A chat with no agent: only the space rides.
    environment.bind('chat-beta', 'ses_vendor_beta', {
      DORKOS_SPACE_ID: '01JSPACE0000000000000000AB',
    }),
  ]);
  const script = `
    const { default: plugin } = await import(${JSON.stringify(plugin)});
    const hooks = await plugin({ client: { session: { get: async ({ path }) => ({
      data: { parentID: path.id === 'ses_child' ? 'ses_vendor_alpha' : undefined }
    }) } } });
    const results = await Promise.all(['ses_vendor_alpha', 'ses_vendor_beta', 'ses_child'].map(async sessionID => {
      const output = { env: { EXISTING: 'kept', DORKOS_AGENT_ID: 'ambient-agent', DORKOS_SPACE_ID: 'ambient-space' } };
      await hooks['shell.env']({ sessionID }, output);
      return output.env;
    }));
    process.stdout.write(JSON.stringify(results));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 10000 }
  );
  const alpha = {
    EXISTING: 'kept',
    DORKOS_SESSION_ID: 'chat-alpha',
    DORKOS_AGENT_ID: '01JAGENT0000000000000000',
    DORKOS_SPACE_ID: '01JSPACE0000000000000000AB',
  };
  expect(JSON.parse(stdout)).toEqual([
    alpha,
    {
      EXISTING: 'kept',
      DORKOS_SESSION_ID: 'chat-beta',
      DORKOS_SPACE_ID: '01JSPACE0000000000000000AB',
    },
    alpha,
  ]);
});

it('DOR-5138: a failed lookup clears the agent and space too', async () => {
  const environment = new OpenCodeSessionEnvironment();
  environments.push(environment);
  const plugin = environment.plugin();
  const script = `
    const { default: plugin } = await import(${JSON.stringify(plugin)});
    const hooks = await plugin({ client: { session: { get: async () => {
      throw new Error('lookup failed');
    } } } });
    const output = { env: { EXISTING: 'kept', DORKOS_AGENT_ID: 'ambient', DORKOS_SPACE_ID: 'ambient' } };
    await hooks['shell.env']({ sessionID: 'ses_unbound' }, output);
    process.stdout.write(JSON.stringify(output.env));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 10000 }
  );
  expect(JSON.parse(stdout)).toEqual({ EXISTING: 'kept' });
});
