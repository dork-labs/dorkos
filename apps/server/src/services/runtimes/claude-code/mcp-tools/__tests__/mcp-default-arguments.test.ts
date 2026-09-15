/**
 * A tool with a defaulted argument answers a call that omits it (DOR-2053).
 *
 * `list_capabilities` is how an agent finds out what DorkOS can do, and calling
 * it the obvious way — no arguments, or a `query` and nothing else — came back
 * as `MCP error -32602: Input validation error: … expected nonoptional, received
 * undefined` at `limit`, a field whose whole point is that it has a default.
 *
 * The cause is not in the schema; it is in the wire between two Zods. Zod 4.6
 * split optionality into three rungs and put `.default(…)` on a new middle one
 * (`optin: "defaulted"`). A raw field map is not a schema: whoever receives one
 * rebuilds it into an object of their own, and that object reads those rungs to
 * decide which keys may be absent. The Claude Agent SDK inlines its own copies of
 * Zod and the MCP SDK rather than importing ours, and its copy predates the
 * middle rung — it asks `optin === "optional"`, reads `"defaulted"`, and files
 * the key as required. Nine tools were affected, not one.
 *
 * These tests run the real in-session server through a real MCP client, so they
 * fail against the actual SDK the product ships with rather than against a
 * restatement of how it is believed to behave. The last two sweep the WHOLE tool
 * surface, so the next `.default(…)` anyone writes is covered the day it lands.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createDorkOsToolServer, handRegisteredInSessionTools } from '../index.js';
import { NotifyBudget } from '../../../../relay/notify-budget.js';
import type { McpToolDeps } from '../types.js';
import { noopLogger } from '@dorkos/shared/logger';
import {
  capabilitiesForMcpServer,
  capabilityInputShape,
} from '../../../../core/capabilities/mcp-projection.js';
import type {
  CapabilityDefinition,
  CapabilityDeps,
  CapabilityRegistry,
} from '../../../../core/capabilities/index.js';
import { defineCapability } from '../../../../core/capabilities/index.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../../connectors/runtime-capability-scope.js';
import { composeDorkOsCapabilityRegistry } from '../../../../core/self-description/dorkos-registry.js';
import { registerCapabilitiesAsMcpTools } from '../../../../core/external-mcp/capability-mcp-tools.js';
import { DEFAULT_CAPABILITY_LIMIT } from '../../../../core/self-description/catalog-projection.js';

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-2053-defaults',
    dorkHome: '/tmp/dorkos-test-home',
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    meshCore: stub,
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
    notifyBudget: new NotifyBudget(),
  };
}

/**
 * The registry with EVERY domain enabled, composed the way boot composes it so
 * the self-description capability can serialize the registry it belongs to.
 */
function createFullRegistry(): CapabilityRegistry {
  const deps: CapabilityDeps = {
    logger: noopLogger,
    operatorDeps: {} as CapabilityDeps['operatorDeps'],
    marketplaceDeps: {} as CapabilityDeps['marketplaceDeps'],
    connectorDeps: {} as CapabilityDeps['connectorDeps'],
    connectorExecutionDeps: {} as CapabilityDeps['connectorExecutionDeps'],
    mcpDeps: {} as CapabilityDeps['mcpDeps'],
    roomDeps: {} as CapabilityDeps['roomDeps'],
  };
  return composeDorkOsCapabilityRegistry(deps);
}

/** A connected MCP client plus the cleanup that closes it. */
async function connect(instance: {
  connect: (transport: InMemoryTransport) => Promise<void>;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dor-2053-probe', version: '0.0.0' });
  await Promise.all([instance.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

/** The JSON payload a DorkOS tool result carries in its single text block. */
function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content?.[0];
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(first?.type).toBe('text');
  return JSON.parse((first as { text: string }).text) as Record<string, unknown>;
}

/**
 * Zod's optionality rung for a field, read off the internal it is stored on.
 *
 * Deliberately internal: the rung is the exact thing a foreign Zod reads to
 * decide whether a key may be absent, so a guard that asked anything else would
 * be guarding a different property than the one that broke.
 */
function rungOf(field: unknown): string | undefined {
  return (field as { _zod: { optin?: string } })._zod.optin;
}

/** Every `${toolName}.${field}` on a shape that still sits on the middle rung. */
function defaultedFields(toolName: string, shape: z.ZodRawShape): string[] {
  return Object.entries(shape)
    .filter(([, field]) => rungOf(field) === 'defaulted')
    .map(([key]) => `${toolName}.${key}`);
}

/** Each capability paired with the fields its OWN schema defaults. */
function capabilitiesWithDefaults(
  registry: CapabilityRegistry,
  server: 'in-session' | 'external'
): { toolName: string; fields: string[]; capability: CapabilityDefinition }[] {
  return capabilitiesForMcpServer(registry, server)
    .map((capability) => ({
      toolName: capability.surfaces.mcp!.toolName,
      fields: Object.entries((capability.input as z.ZodObject<z.ZodRawShape>).shape)
        .filter(([, field]) => rungOf(field) === 'defaulted')
        .map(([key]) => key),
      capability,
    }))
    .filter((entry) => entry.fields.length > 0);
}

describe('a defaulted argument may be omitted (DOR-2053)', () => {
  it('answers list_capabilities with no arguments, and applies the default page size', async () => {
    const registry = createFullRegistry();
    const server = createDorkOsToolServer(
      createFullDeps(),
      undefined,
      undefined,
      undefined,
      registry
    );
    const { client, close } = await connect(server.instance);

    const result = (await client.callTool({
      name: 'list_capabilities',
      arguments: {},
    })) as CallToolResult;
    const page = payloadOf(result);

    expect(page.detail).toBe('compact');
    // The default only PROVES it applied while the catalog is larger than one
    // page; assert that premise rather than let the proof quietly weaken as the
    // catalog shrinks.
    expect(page.total as number).toBeGreaterThan(DEFAULT_CAPABILITY_LIMIT);
    expect(page.returned).toBe(DEFAULT_CAPABILITY_LIMIT);
    expect(page.nextCursor).toEqual(expect.any(String));
    await close();
  });

  it('answers the exact call that was reported: a query and no limit', async () => {
    const registry = createFullRegistry();
    const server = createDorkOsToolServer(
      createFullDeps(),
      undefined,
      undefined,
      undefined,
      registry
    );
    const { client, close } = await connect(server.instance);

    const result = (await client.callTool({
      name: 'list_capabilities',
      arguments: { query: 'sidebar' },
    })) as CallToolResult;

    expect(payloadOf(result)).toMatchObject({ offset: 0 });
    await close();
  });

  // This surface never had the bug — it builds its object with OUR Zod, which
  // knows the middle rung — so this case went green before the fix too. It is
  // here to pin that the rewrite introduced none: a field re-advertised as
  // optional must still come back with its default applied where it already was.
  it('answers list_capabilities with no arguments on the external /mcp surface too', async () => {
    const registry = createFullRegistry();
    const server = new McpServer({ name: 'dorkos-external', version: '0.0.0' });
    registerCapabilitiesAsMcpTools(server, registry);
    const { client, close } = await connect(server);

    const page = payloadOf(
      (await client.callTool({ name: 'list_capabilities', arguments: {} })) as CallToolResult
    );

    expect(page.total as number).toBeGreaterThan(DEFAULT_CAPABILITY_LIMIT);
    expect(page.returned).toBe(DEFAULT_CAPABILITY_LIMIT);
    await close();
  });

  it('reaches the handler with no arguments for every defaulted capability field', async () => {
    const registry = createFullRegistry();
    const affected = capabilitiesWithDefaults(registry, 'in-session');
    // The sweep is only worth running while it covers something; a projection
    // that stopped returning capabilities would otherwise pass by testing none.
    expect(affected.length).toBeGreaterThanOrEqual(9);

    // One probe tool per defaulted field, carrying the shape the real projection
    // produces, registered on a real SDK server and called with no arguments.
    const probes = affected.flatMap(({ toolName, fields, capability }) => {
      const shape = capabilityInputShape(capability);
      return fields.map((field) =>
        tool(
          `${toolName}__${field}`,
          `probe for ${toolName}.${field}`,
          { [field]: shape[field]! },
          async (args: Record<string, unknown>) => ({
            content: [{ type: 'text' as const, text: JSON.stringify(args) }],
          })
        )
      );
    });
    const server = createSdkMcpServer({ name: 'dor-2053', version: '0.0.0', tools: probes });
    const { client, close } = await connect(server.instance);

    const refused: string[] = [];
    for (const probe of probes) {
      const result = (await client.callTool({
        name: probe.name,
        arguments: {},
      })) as CallToolResult;
      if (result.isError) refused.push(`${probe.name}: ${JSON.stringify(result.content)}`);
    }

    expect(refused).toEqual([]);
    await close();
  });

  it('advertises each defaulted field as optional, default and description intact', async () => {
    const registry = createFullRegistry();
    const server = createDorkOsToolServer(
      createFullDeps(),
      undefined,
      undefined,
      undefined,
      registry
    );
    const { client, close } = await connect(server.instance);
    const { tools } = await client.listTools();

    const advertised = new Map(tools.map((entry) => [entry.name, entry.inputSchema]));
    const missing: string[] = [];
    for (const { toolName, fields } of capabilitiesWithDefaults(registry, 'in-session')) {
      const schema = advertised.get(toolName) as
        { properties?: Record<string, { default?: unknown }>; required?: string[] } | undefined;
      for (const field of fields) {
        const property = schema?.properties?.[field];
        if (property === undefined) missing.push(`${toolName}.${field} is not advertised`);
        else if (!('default' in property)) missing.push(`${toolName}.${field} lost its default`);
        if (schema?.required?.includes(field)) missing.push(`${toolName}.${field} reads required`);
      }
    }

    expect(missing).toEqual([]);
    // `limit` is the field the report named; pin its advertised default exactly.
    const limit = (
      advertised.get('list_capabilities') as unknown as {
        properties: { limit: { default: number; description: string } };
      }
    ).properties.limit;
    expect(limit.default).toBe(DEFAULT_CAPABILITY_LIMIT);
    expect(limit.description).toContain('Maximum entries to return');
    await close();
  });

  it('puts no RAW field map crossing to the Agent SDK on the middle rung', () => {
    const registry = createFullRegistry();
    const stranded = [
      ...handRegisteredInSessionTools(createFullDeps()).flatMap((entry) =>
        defaultedFields(entry.name, entry.inputSchema)
      ),
      ...(['in-session', 'external'] as const).flatMap((surface) =>
        capabilitiesForMcpServer(registry, surface).flatMap((capability) =>
          defaultedFields(
            `${surface} ${capability.surfaces.mcp!.toolName}`,
            capabilityInputShape(capability)
          )
        )
      ),
    ];

    // A `.default(…)` reaching a raw field map is invisible until an agent calls
    // the tool without that argument, and then the call fails outright. The two
    // halves have different remedies. A CAPABILITY's shape is normalized on its
    // way out of `capabilityInputShape`, so one showing up here means a capability
    // reached a surface without going through that projection. A HAND-REGISTERED
    // tool is parsed once and its handler receives whatever the SDK produced, so
    // there is nothing that could fill the default in afterwards: apply the
    // fallback inside the handler, or define the tool as a capability.
    expect(stranded).toEqual([]);
  });

  it('hands the connector capabilities over as whole objects, not as field maps', () => {
    const registry = createFullRegistry();

    // These seven declare `surfaces: {}` and are registered by
    // `registerClaudeConnectorCapabilityTools` with `capability.input` itself, so
    // the guard above cannot see them — and does not need to. A whole `ZodObject`
    // crosses to the Agent SDK intact and is parsed by its own `run`, which never
    // consults the optionality rung, which is why
    // `connectors.request_connection` can default `requestedEvents` and still
    // answer a call that omits it. That safety is entirely a property of handing
    // over an object, so this pins the object.
    for (const id of CONNECTOR_RUNTIME_CAPABILITY_IDS) {
      expect(registry.get(id)?.input, id).toBeInstanceOf(z.ZodObject);
    }
    // The premise the paragraph above rests on: at least one of them really does
    // default a field, so this is not a vacuous guard over schemas that would be
    // safe either way.
    const defaulted = CONNECTOR_RUNTIME_CAPABILITY_IDS.flatMap((id) =>
      Object.entries((registry.get(id)!.input as z.ZodObject<z.ZodRawShape>).shape)
        .filter(([, field]) => rungOf(field) === 'defaulted')
        .map(([key]) => `${id}.${key}`)
    );
    expect(defaulted).toContain('connectors.request_connection.requestedEvents');
  });

  it('re-labels a prefaulted field, and a default hidden under an optional', async () => {
    // Neither spelling is in the product today, and both are one `instanceof`
    // branch of `substitutingDefault` that nothing else reaches: delete either
    // branch and the matching probe below goes red rather than silently shipping
    // a field the Agent SDK reads as required.
    const fixture = defineCapability({
      id: 'fixture.substituting',
      title: 'Substituting field fixture',
      description: 'Exercises the two substituting wrappers the product does not use yet.',
      tier: 'observe',
      input: z.object({
        prefaulted: z.coerce.number().int().min(1).prefault(7).describe('a prefaulted field'),
        defaultedThenOptional: z.array(z.string()).default([]).optional().describe('both wrappers'),
      }),
      output: z.object({ ok: z.boolean() }),
      surfaces: {},
      invoke: async () => ({ ok: true }),
    });

    const shape = capabilityInputShape(fixture);
    const probe = tool(
      'fixture_substituting',
      'probe',
      shape,
      async (args: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(args) }],
      })
    );
    const server = createSdkMcpServer({
      name: 'dor-2053-fixture',
      version: '0.0.0',
      tools: [probe],
    });
    const { client, close } = await connect(server.instance);

    const result = (await client.callTool({
      name: 'fixture_substituting',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);

    // And the substituted value still reaches the model as a JSON Schema default,
    // which is the half a bare `.optional()` rewrite would have thrown away.
    const advertised = (await client.listTools()).tools.find(
      (entry) => entry.name === 'fixture_substituting'
    )?.inputSchema as unknown as {
      properties: Record<string, { default?: unknown }>;
      required?: string[];
    };
    expect(advertised.properties.prefaulted?.default).toBe(7);
    expect(advertised.properties.defaultedThenOptional?.default).toEqual([]);
    expect(advertised.required ?? []).toEqual([]);
    await close();
  });
});
