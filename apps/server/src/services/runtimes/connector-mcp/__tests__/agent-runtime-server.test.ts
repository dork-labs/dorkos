import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { noopLogger } from '@dorkos/shared/logger';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  composeRegistry,
  defineCapability,
  type CapabilityDomain,
  type CapabilityInvocationContext,
} from '../../../core/capabilities/index.js';
import { capabilitiesForMcpServer } from '../../../core/capabilities/mcp-projection.js';
import { composeCapabilityRegistryForDocs } from '../../../core/self-description/dorkos-registry.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { roomsDomain } from '../../../rooms/room-capabilities.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { createAgentRuntimeMcpServer } from '../agent-runtime-server.js';

const principal = createServerPrincipal({
  kind: 'runtime',
  owner: { kind: 'local_install', installationId: 'install-a' },
  bindingId: 'binding-a',
  runtime: 'opencode',
  canonicalSessionId: 'session-a',
  agentId: 'agent-a',
  agentPath: '/agents/a',
  canonicalCwd: '/work/a',
});

const identity = {
  agentPath: '/agents/a',
  displayName: 'Agent A',
  tierCeiling: 'act' as const,
  createdAt: '2026-09-08T00:00:00.000Z',
};

async function connect(server: ReturnType<typeof createAgentRuntimeMcpServer>) {
  const client = new Client({ name: 'agent-runtime-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected one text MCP result.');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('createAgentRuntimeMcpServer', () => {
  it('projects the established in-session audience without public-only or private tools', async () => {
    const registry = composeCapabilityRegistryForDocs();
    const client = await connect(createAgentRuntimeMcpServer(registry, principal, identity));
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const expected = capabilitiesForMcpServer(registry, 'in-session')
      .map((capability) => capability.surfaces.mcp!.toolName)
      .sort();

    expect(names).toEqual(expected);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_member_rooms',
        'read_room_history',
        'search_room_history',
        'search_member_rooms',
      ])
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        'search_sessions',
        'search_messages',
        'connectors.list_granted_connections',
        'connectors.execute_read',
        'connectors.execute_write',
        'connectors.execute_destructive',
      ])
    );
  });

  it('invokes with identity and session facts derived from the verified principal', async () => {
    const seen = vi.fn((_context: CapabilityInvocationContext) => ({ ok: true }));
    const domain: CapabilityDomain = {
      name: 'probe',
      capabilities: [
        defineCapability({
          id: 'probe.read',
          title: 'Read probe',
          description: 'Read a harmless probe.',
          tier: 'observe',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          surfaces: { mcp: { toolName: 'read_probe', servers: ['in-session'] } },
          invoke: async (_deps, _input, context) => seen(context),
        }),
        defineCapability({
          id: 'probe.owner_only',
          title: 'Owner-only probe',
          description: 'A probe excluded from agent sessions.',
          tier: 'observe',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          surfaces: { mcp: { toolName: 'owner_only_probe', servers: ['external'] } },
          invoke: async () => ({ ok: true }),
        }),
        defineCapability({
          id: 'probe.private',
          title: 'Private probe',
          description: 'A private capability with no projected surface.',
          tier: 'observe',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          surfaces: {},
          invoke: async () => ({ ok: true }),
        }),
      ],
    };
    const registry = composeRegistry([domain], { logger: noopLogger });
    const client = await connect(createAgentRuntimeMcpServer(registry, principal, identity));

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_probe']);
    await client.callTool({ name: 'read_probe', arguments: {} });
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        agentIdentityPresented: true,
        sessionId: 'session-a',
        cwd: '/agents/a',
        serverPrincipal: principal,
      })
    );
  });

  it('lists and reads only rooms belonging to the bound agent', async () => {
    const harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/a': { name: 'a', displayName: 'Agent A', responseMode: 'always' },
      }),
      runner: scriptedRunner(() => null),
    });
    const mine = harness.service.createRoom(
      { kind: 'channel', title: 'Mine', members: [], agentPaths: ['/agents/a'] },
      harness.human
    );
    const outside = harness.service.createRoom(
      { kind: 'channel', title: 'Outside', members: [], agentPaths: [] },
      harness.human
    );
    harness.service.post(mine.id, { authorId: harness.human, text: 'visible after joining' });
    harness.service.post(outside.id, { authorId: harness.human, text: 'must stay private' });
    const registry = composeRegistry([roomsDomain], {
      logger: noopLogger,
      roomDeps: { rooms: harness.service },
    });
    const client = await connect(createAgentRuntimeMcpServer(registry, principal, identity));

    const listed = payload(await client.callTool({ name: 'list_member_rooms', arguments: {} }));
    expect(listed['rooms']).toEqual([expect.objectContaining({ roomId: mine.id, name: '#mine' })]);

    const read = payload(
      await client.callTool({
        name: 'read_room_history',
        arguments: { roomId: mine.id, limit: 20 },
      })
    );
    expect(read['entries']).toEqual([expect.objectContaining({ text: 'visible after joining' })]);

    const refused = payload(
      await client.callTool({
        name: 'read_room_history',
        arguments: { roomId: outside.id, limit: 20 },
      })
    );
    expect(refused).toMatchObject({ code: 'ROOM_NOT_FOUND' });
  });
});
