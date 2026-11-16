/**
 * Defaulted arguments remain optional through real SDK and registry execution.
 * DOR-2053's older raw-default failure no longer reproduces on the pinned SDK.
 * Full objects retain defaults, refinements and strict top-level validation.
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
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
import { capabilityInputObject } from '../../../../core/capabilities/input-projection.js';
import type { McpToolDeps } from '../types.js';
import { noopLogger } from '@dorkos/shared/logger';
import {
  capabilitiesForMcpServer,
  capabilityMcpInputObject,
} from '../../../../core/capabilities/mcp-projection.js';
import type {
  CapabilityDefinition,
  CapabilityDeps,
  CapabilityRegistry,
} from '../../../../core/capabilities/index.js';
import { composeRegistry, defineCapability } from '../../../../core/capabilities/index.js';
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
      fields: Object.entries(capabilityInputObject(capability).shape)
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

  // The external surface shares the full ordinary object projection and keeps
  // its own sessionless invocation path.
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

    const probes = affected.flatMap(({ toolName, fields, capability }) =>
      fields.map((field) =>
        defineCapability({
          id: `probe.${toolName}_${field}`,
          title: 'Read a default',
          description: 'Reads one original defaulted field.',
          tier: 'observe',
          area: null,
          input: z.object({ [field]: capabilityMcpInputObject(capability).shape[field]! }),
          output: z.unknown(),
          surfaces: { mcp: { toolName: `${toolName}__${field}`, servers: ['in-session'] } },
          invoke: async (_deps, args) => args,
        })
      )
    );
    const probeRegistry = composeRegistry([{ name: 'probe', capabilities: probes }], {
      logger: noopLogger,
    });
    const server = createDorkOsToolServer(
      createFullDeps(),
      undefined,
      undefined,
      undefined,
      probeRegistry
    );
    const { client, close } = await connect(server.instance);

    const refused: string[] = [];
    for (const probe of probes) {
      const result = (await client.callTool({
        name: probe.surfaces.mcp!.toolName,
        arguments: {},
      })) as CallToolResult;
      if (result.isError) refused.push(`${probe.id}: ${JSON.stringify(result.content)}`);
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

  it('keeps the hand-tool once-only parse guard independent', () => {
    const hand = handRegisteredInSessionTools(createFullDeps());
    expect(hand.length).toBeGreaterThan(0);
    // Hand tools receive the SDK's parsed result directly. This deliberately
    // narrow authoring guard survives the capability raw-map retirement.
    expect(hand.flatMap((entry) => defaultedFields(entry.name, entry.inputSchema))).toEqual([]);
  });

  it('hands the connector capabilities over as whole objects, not as field maps', () => {
    const registry = createFullRegistry();

    // These capabilities declare `surfaces: {}` and are registered by
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
});

describe('ordinary full-object registration through the SDK', () => {
  it.each(
    (['in-session', 'external'] as const).flatMap((surface) =>
      ['extra', 'ownerId'].map((key) => ({ surface, key }))
    )
  )('refuses $key on $surface before the same handler', async ({ surface, key }) => {
    const handler = vi.fn(async (_deps, input) => input);
    const capability = defineCapability({
      id: 'fixture.range',
      title: 'Read a range',
      description: 'Reads a range.',
      tier: 'observe',
      area: null,
      input: z
        .object({ start: z.number().default(1), end: z.number().default(5) })
        .refine(({ start, end }) => start < end, 'Start must precede end'),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'read_range', servers: ['in-session', 'external'] } },
      invoke: handler,
    });
    const registry = composeRegistry([{ name: 'fixture', capabilities: [capability] }], {
      logger: noopLogger,
    });
    const server =
      surface === 'in-session'
        ? createDorkOsToolServer(createFullDeps(), undefined, undefined, undefined, registry)
            .instance
        : new McpServer({ name: 'external-range-proof', version: '1.0.0' });
    if (surface === 'external') registerCapabilitiesAsMcpTools(server, registry);
    const { client, close } = await connect(server);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.filter((t) => t.name === 'read_range')).toHaveLength(1);
      expect(
        payloadOf((await client.callTool({ name: 'read_range', arguments: {} })) as CallToolResult)
      ).toEqual({ start: 1, end: 5 });
      expect(handler).toHaveBeenCalledTimes(1);
      const result = await client.callTool({
        name: 'read_range',
        arguments: { start: 2, end: 6, [key]: 'untrusted' },
      });
      expect(result.isError).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      const refined = await client.callTool({
        name: 'read_range',
        arguments: { start: 6, end: 2 },
      });
      expect(refined.isError).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(
        payloadOf(
          (await client.callTool({
            name: 'read_range',
            arguments: { start: 2, end: 6 },
          })) as CallToolResult
        )
      ).toEqual({ start: 2, end: 6 });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await close();
    }
  });
});
