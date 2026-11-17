/**
 * The in-session server tells a capability when the calling turn runs at Never ask (DOR-3971), so
 * a read like `running_chats` can leave out words a stranger may have chosen. Read off the live
 * session at call time; driven through the real SDK server and a real client.
 *
 * @vitest-environment node
 * @module services/runtimes/claude-code/mcp-tools/__tests__/never-ask-context
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry, defineCapability } from '../../../../core/capabilities/index.js';
import { createDorkOsToolServer } from '../index.js';
import type { McpToolDeps } from '../types.js';

/** A read that answers with what it was told about the calling turn. */
const probe = {
  name: 'probe',
  capabilities: [
    defineCapability({
      id: 'probe.turn_facts',
      title: 'Probe the turn',
      description: 'Says whether the calling turn runs at Never ask.',
      tier: 'observe',
      area: null,
      areaNote: 'test probe',
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'probe_turn_facts', servers: ['in-session'] } },
      invoke: async (_deps, _input, context) => ({ neverAsks: context?.neverAsks === true }),
    }),
  ],
};

async function connect(session: { permissionMode: string }) {
  const registry = composeRegistry([probe], { logger: noopLogger });
  const live = { eventQueue: [], cwd: '/tmp/never-ask-probe', sdkSessionId: 'ses-1', ...session };
  const deps = { defaultCwd: '/tmp/never-ask-probe', dorkHome: '/tmp/never-ask-home' };
  const server = createDorkOsToolServer(
    deps as unknown as McpToolDeps,
    live,
    'ses-1',
    undefined,
    registry
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'never-ask-probe', version: '0.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const ask = async () => {
    const result = (await client.callTool({
      name: 'probe_turn_facts',
      arguments: {},
    })) as CallToolResult;
    const text = result.content.find((block) => block.type === 'text') as { text: string };
    return JSON.parse(text.text) as { neverAsks: boolean };
  };
  return { live, ask };
}

describe('the Never ask fact a capability is told', () => {
  it('is set for a turn at Never ask', async () => {
    const { ask } = await connect({ permissionMode: 'dontAsk' });
    expect(await ask()).toEqual({ neverAsks: true });
  });

  it('is not set in any other mode', async () => {
    for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions']) {
      const { ask } = await connect({ permissionMode });
      expect(await ask(), permissionMode).toEqual({ neverAsks: false });
    }
  });

  it('is read at call time, not when the server was built', async () => {
    const { live, ask } = await connect({ permissionMode: 'default' });
    live.permissionMode = 'dontAsk';
    expect(await ask()).toEqual({ neverAsks: true });
  });
});
