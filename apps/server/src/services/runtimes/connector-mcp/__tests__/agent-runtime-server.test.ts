import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { noopLogger } from '@dorkos/shared/logger';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { uiDomain } from '../../../session/browser-seat/ui-capabilities.js';
import { devtoolsCaptureStore } from '../../../session/devtools-capture-store.js';
import { AgentIdentitySnapshotPrincipalPort } from '../agent-identity-snapshots.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';

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

/** A turn-bound principal for one runtime and one session. */
function runtimePrincipal(runtime: 'codex' | 'opencode', sessionId: string) {
  return createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId: `binding-${sessionId}`,
    runtime,
    canonicalSessionId: sessionId,
    agentId: 'agent-a',
    agentPath: '/agents/a',
    canonicalCwd: '/work/a',
  });
}

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

  it('keeps a manifest ceiling change out of the active turn MCP dispatch', async () => {
    const invoked = vi.fn(() => ({ ok: true }));
    const registry = composeRegistry(
      [
        {
          name: 'probe',
          capabilities: [
            defineCapability({
              id: 'probe.act',
              title: 'Change probe',
              description: 'Change a probe reversibly.',
              tier: 'act',
              input: z.object({}),
              output: z.object({ ok: z.boolean() }),
              surfaces: { mcp: { toolName: 'change_probe', servers: ['in-session'] } },
              invoke: async () => invoked(),
            }),
          ],
        },
      ],
      { logger: noopLogger }
    );
    let manifestTier: 'observe' | 'destructive' = 'observe';
    let binding = 0;
    const backing: ConnectorRuntimePrincipalPort = {
      openTurn: vi.fn(async () => ({
        bindingId: `binding-${++binding}`,
        bearer: `bearer-${binding}`,
        expiresAt: '2026-09-09T00:00:00.000Z',
        renewalPermit: Object.freeze({}) as never,
      })),
      renew: vi.fn(),
      resolve: vi.fn(),
      revoke: vi.fn(),
    };
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals: backing,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: manifestTier,
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    const first = await snapshots.openTurn(
      {
        runtime: 'opencode',
        canonicalSessionId: 'session-a',
        agentPath: '/agents/a',
        canonicalCwd: '/work/a',
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );

    manifestTier = 'destructive';
    const activePrincipal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: first.bindingId,
      runtime: 'opencode',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/agents/a',
      canonicalCwd: '/work/a',
    });
    const activeIdentity = await snapshots.identityFor(activePrincipal);
    if (!activeIdentity) throw new Error('Expected active turn identity.');
    const activeClient = await connect(
      createAgentRuntimeMcpServer(registry, activePrincipal, activeIdentity)
    );
    const denied = payload(await activeClient.callTool({ name: 'change_probe', arguments: {} }));

    expect(denied).toMatchObject({ status: 'denied', reason: 'tier_ceiling', approvable: false });
    expect(invoked).not.toHaveBeenCalled();

    const next = await snapshots.openTurn(
      {
        runtime: 'opencode',
        canonicalSessionId: 'session-b',
        agentPath: '/agents/a',
        canonicalCwd: '/work/a',
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );
    const nextPrincipal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: next.bindingId,
      runtime: 'opencode',
      canonicalSessionId: 'session-b',
      agentId: 'agent-a',
      agentPath: '/agents/a',
      canonicalCwd: '/work/a',
    });
    const nextIdentity = await snapshots.identityFor(nextPrincipal);
    if (!nextIdentity) throw new Error('Expected next turn identity.');
    const nextClient = await connect(
      createAgentRuntimeMcpServer(registry, nextPrincipal, nextIdentity)
    );

    expect(payload(await nextClient.callTool({ name: 'change_probe', arguments: {} }))).toEqual({
      ok: true,
    });
    expect(invoked).toHaveBeenCalledOnce();
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


/**
 * The parity this whole phase exists for: Codex and OpenCode reach the canvas
 * and the browser through the loopback `dorkos` server, with the same tool names
 * a Claude Code session has always had (spec `canvas-agent-seat` §5).
 *
 * Driven through the REAL server and a REAL client, because the thing under test
 * is the projection: which capabilities this surface advertises, and what caller
 * facts a call arrives with. A unit test of the handlers would prove neither.
 */
describe('the `ui` domain over the loopback runtime server', () => {
  const registry = composeRegistry([uiDomain], { logger: noopLogger });

  afterEach(() => devtoolsCaptureStore.clear());

  it('advertises every `ui` verb to a Codex session', async () => {
    const client = await connect(
      createAgentRuntimeMcpServer(registry, runtimePrincipal('codex', 'session-codex'), identity)
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      uiDomain.capabilities.map((capability) => capability.surfaces.mcp!.toolName).sort()
    );
    // The five a Codex agent could not reach at all before: one was a stub with
    // no session behind it, and four did not exist on this runtime.
    expect(names).toEqual(
      expect.arrayContaining([
        'control_ui',
        'get_ui_state',
        'browser_read_console',
        'browser_click',
        'browser_screenshot',
      ])
    );
  });

  it('advertises the same set to an OpenCode session', async () => {
    const client = await connect(
      createAgentRuntimeMcpServer(
        registry,
        runtimePrincipal('opencode', 'session-opencode'),
        identity
      )
    );
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      uiDomain.capabilities.map((capability) => capability.surfaces.mcp!.toolName).sort()
    );
  });

  it('reads the capture buffer of the session the PRINCIPAL names, and no other', async () => {
    // The security property, driven rather than reasoned about: there is no
    // session argument on any of these verbs, so the only session a call can
    // reach is the one the verified turn binding names. Two live sessions, two
    // servers, and neither can see the other's preview.
    devtoolsCaptureStore.ingest('session-codex', {
      seq: 1,
      console: [{ level: 'error', text: 'codex saw this', timestamp: 1 }],
      network: [],
    });
    devtoolsCaptureStore.ingest('session-opencode', {
      seq: 1,
      console: [{ level: 'error', text: 'opencode saw this', timestamp: 1 }],
      network: [],
    });

    const codex = await connect(
      createAgentRuntimeMcpServer(registry, runtimePrincipal('codex', 'session-codex'), identity)
    );
    const opencode = await connect(
      createAgentRuntimeMcpServer(
        registry,
        runtimePrincipal('opencode', 'session-opencode'),
        identity
      )
    );

    const codexRead = payload(
      await codex.callTool({ name: 'browser_read_console', arguments: {} })
    );
    const opencodeRead = payload(
      await opencode.callTool({ name: 'browser_read_console', arguments: {} })
    );

    const textsOf = (read: Record<string, unknown>) =>
      (read['entries'] as { text: string }[]).map((entry) => entry.text);
    expect(textsOf(codexRead)).toEqual(['codex saw this']);
    expect(textsOf(opencodeRead)).toEqual(['opencode saw this']);
  });

  it('refuses an action that writes to the machine, on Codex AND on OpenCode', async () => {
    // The rule used to be "refused on Codex" and lived in that adapter. It is a
    // property of this SURFACE: an agent reaching in from outside the DorkOS app
    // has no way to put the question to the person first, and that is as true of
    // OpenCode as it is of Codex (spec `canvas-agent-seat` §5).
    for (const runtime of ['codex', 'opencode'] as const) {
      const client = await connect(
        createAgentRuntimeMcpServer(
          registry,
          runtimePrincipal(runtime, `session-${runtime}`),
          identity
        )
      );
      const refused = payload(
        await client.callTool({
          name: 'control_ui',
          arguments: { action: 'apply_layout', shape: 'nightly-release' },
        })
      );

      expect(refused['success'], runtime).toBe(false);
      expect(String(refused['error']), runtime).toContain('apply_layout');
      expect(String(refused['error']), runtime).toContain('DorkOS app');
    }
  });

  it('lets a client-only action through on the same surface', async () => {
    // The discriminator on the case above: the refusal is about what the action
    // REACHES, not about the door it came through being closed.
    const client = await connect(
      createAgentRuntimeMcpServer(registry, runtimePrincipal('codex', 'session-codex'), identity)
    );

    expect(
      payload(
        await client.callTool({
          name: 'control_ui',
          arguments: { action: 'show_toast', message: 'hello', level: 'info' },
        })
      )
    ).toMatchObject({ success: true, action: 'show_toast' });
  });
});
