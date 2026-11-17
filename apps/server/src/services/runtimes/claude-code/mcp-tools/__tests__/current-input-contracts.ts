/** Original executable schema contracts, composed into the real SDK default suite. */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry, defineCapability } from '../../../../core/capabilities/index.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import type { McpContractHarness } from './current-input-schemas.js';
import { capabilityInputObject } from '../../../../core/capabilities/input-projection.js';
import { capabilitiesForMcpServer } from '../../../../core/capabilities/mcp-projection.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../../connectors/runtime-capability-scope.js';
import { CANVAS_CHANNEL_ENVELOPE_BYTES } from '@dorkos/shared/canvas-channel-schemas';
import { inputNodes } from './current-input-schemas.js';
import { createCapabilityMcpClient } from './capability-mcp-client.js';

/** Register the source census and finite current-schema SDK/registry proofs. */
export function registerCurrentInputContractTests({ payloadOf }: McpContractHarness): void {
  describe('current executable schema census and parse semantics', () => {
    const actual = composeCapabilityRegistryForDocs();
    const relevant = actual.capabilities.filter(
      (cap) =>
        cap.surfaces.mcp?.servers.length ||
        CONNECTOR_RUNTIME_CAPABILITY_IDS.some((id) => id === cap.id)
    );
    const defaults = relevant.flatMap((cap) =>
      inputNodes(cap.input)
        .filter((node) => node.schema instanceof z.ZodDefault)
        .map((node) => ({ id: cap.id, ...node }))
    );

    it('enumerates the complete current MCP declarations and every default node', () => {
      // These are measured source-census baselines, not a production allowlist.
      // A declaration change must explain its real census drift here.
      // +1 total/relevant/ordinary/inSession/external for
      // `operator.update_agent_config` (DOR-4266), which has no defaults.
      const topDefaults = relevant.map(
        (cap) =>
          Object.values(capabilityInputObject(cap).shape).filter(
            (field) => field instanceof z.ZodDefault
          ).length
      );
      expect({
        total: actual.capabilities.length,
        relevant: relevant.length,
        ordinary: relevant.filter((cap) => cap.surfaces.mcp?.servers.length).length,
        inSession: capabilitiesForMcpServer(actual, 'in-session').length,
        external: capabilitiesForMcpServer(actual, 'external').length,
        private: CONNECTOR_RUNTIME_CAPABILITY_IDS.length,
        defaultNodes: defaults.length,
        topDefaultFields: topDefaults.reduce((a, b) => a + b, 0),
        topDefaultCapabilities: topDefaults.filter(Boolean).length,
      }).toEqual({
        total: 132,
        relevant: 130,
        ordinary: 118,
        inSession: 117,
        external: 85,
        private: 12,
        defaultNodes: 29,
        topDefaultFields: 15,
        topDefaultCapabilities: 14,
      });
      expect(
        relevant
          .filter((cap) => cap.input instanceof z.ZodPipe)
          .map((cap) => cap.id)
          .sort()
      ).toEqual(['ui.patch_canvas_state', 'ui.send_canvas_event']);
      expect(
        relevant.flatMap((cap) =>
          inputNodes(cap.input)
            .filter((node) => node.schema instanceof z.ZodPrefault)
            .map((node) => `${cap.id}:${node.path}`)
        )
      ).toEqual([]);
      expect(
        relevant
          .flatMap((cap) =>
            inputNodes(cap.input)
              .filter((node) => node.schema instanceof z.ZodTransform)
              .map(() => cap.id)
          )
          .sort()
      ).toEqual(['ui.patch_canvas_state', 'ui.send_canvas_event']);
      for (const id of CONNECTOR_RUNTIME_CAPABILITY_IDS) expect(actual.get(id), id).toBeDefined();
    });

    it('preserves omitted and explicit values for all 29 original default nodes through SDK and registry', async () => {
      expect(defaults).toHaveLength(29);
      const received = new Map<string, unknown[]>();
      const probes = defaults.map((node, index) =>
        defineCapability({
          id: `defaults.node_${index}`,
          title: 'Read a current default',
          description: `Original field ${node.id}:${node.path}; recording handler only.`,
          tier: 'observe',
          area: null,
          input: z.object({ value: node.schema }),
          output: z.unknown(),
          surfaces: { mcp: { toolName: `default_node_${index}`, servers: ['in-session'] } },
          invoke: async (_deps, args) => {
            const calls = received.get(node.id + node.path) ?? [];
            calls.push(args);
            received.set(node.id + node.path, calls);
            return args;
          },
        })
      );
      const registry = composeRegistry([{ name: 'defaults', capabilities: probes }], {
        logger: noopLogger,
      });
      const { client } = await createCapabilityMcpClient(registry);
      const listed = (await client.listTools()).tools;
      expect(listed).toHaveLength(29);
      for (const [index, node] of defaults.entries()) {
        const name = `default_node_${index}`;
        const value = node.schema.parse(undefined);
        const candidates: unknown[] = [1, 2, 'feature', ['event'], { TEST: 'value' }, value];
        const explicit = candidates.find(
          (candidate) =>
            node.schema.safeParse(candidate).success &&
            JSON.stringify(candidate) !== JSON.stringify(value)
        );
        expect(explicit, `${node.id}:${node.path} explicit control`).not.toBeUndefined();
        expect(explicit).not.toEqual(value);
        const schema = listed.find((tool) => tool.name === name)!.inputSchema;
        expect(schema.properties?.value, `${node.id}:${node.path}`).toMatchObject({
          default: value,
        });
        expect(schema.required ?? []).not.toContain('value');
        expect(
          payloadOf((await client.callTool({ name, arguments: {} })) as CallToolResult)
        ).toEqual({ value });
        const expected = node.schema.parse(explicit);
        expect(
          payloadOf(
            (await client.callTool({ name, arguments: { value: explicit } })) as CallToolResult
          )
        ).toEqual({ value: expected });
        expect(received.get(node.id + node.path)).toEqual([{ value }, { value: expected }]);
      }
      expect(received.size).toBe(29);
    });

    it('preserves every current numeric coercion and rejects invalid values before the same handler', async () => {
      const nodes = relevant.flatMap((cap) =>
        inputNodes(cap.input)
          .filter(
            (node) =>
              node.schema instanceof z.ZodNumber &&
              (node.schema._zod.def as { coerce?: boolean }).coerce
          )
          .map((node) => ({ id: cap.id, ...node }))
      );
      expect(nodes).toHaveLength(11);
      const handlers = nodes.map(() => vi.fn(async (_deps, input) => input));
      const probes = nodes.map((node, index) =>
        defineCapability({
          id: `numbers.node_${index}`,
          title: 'Read a current number',
          description: `Original numeric node ${node.id}:${node.path}.`,
          tier: 'observe',
          area: null,
          input: z.object({ value: node.schema }),
          output: z.unknown(),
          surfaces: { mcp: { toolName: `number_node_${index}`, servers: ['in-session'] } },
          invoke: handlers[index]!,
        })
      );
      const { client } = await createCapabilityMcpClient(
        composeRegistry([{ name: 'numbers', capabilities: probes }], { logger: noopLogger })
      );
      for (const [index, node] of nodes.entries()) {
        const expected = { value: node.schema.parse('2') };
        expect(
          payloadOf(
            (await client.callTool({
              name: `number_node_${index}`,
              arguments: { value: '2' },
            })) as CallToolResult
          )
        ).toEqual(expected);
        expect(handlers[index]).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expected,
          expect.anything()
        );
        expect(
          (
            await client.callTool({
              name: `number_node_${index}`,
              arguments: { value: 'invalid-number' },
            })
          ).isError
        ).toBe(true);
        expect(handlers[index]).toHaveBeenCalledTimes(1);
      }
    });

    it('keeps nested traits and MCP connection defaults on the original whole executable schemas', async () => {
      const cases = [
        { id: 'operator.update_agent', input: { agent_id: 'agent-a', traits: { humor: 5 } } },
        {
          id: 'mcp.add',
          input: {
            agentId: 'agent-a',
            name: 'test',
            connection: { transport: 'stdio', command: 'test-command' },
          },
        },
        {
          id: 'mcp.update',
          input: {
            agentId: 'agent-a',
            name: 'test',
            connection: {
              transport: 'http',
              url: 'https://example.com/mcp',
              headers: { 'X-Test': 'explicit' },
            },
          },
        },
      ];
      expect(cases).toHaveLength(3);
      const handlers = cases.map(() => vi.fn(async (_deps, input) => input));
      const probes = cases.map((item, index) =>
        defineCapability({
          id: `nested.case_${index}`,
          title: 'Read nested defaults',
          description: 'Original executable schema; no production service.',
          tier: 'observe',
          area: null,
          input: actual.get(item.id)!.input,
          output: z.unknown(),
          surfaces: { mcp: { toolName: `nested_case_${index}`, servers: ['in-session'] } },
          invoke: handlers[index]!,
        })
      );
      const { client } = await createCapabilityMcpClient(
        composeRegistry([{ name: 'nested', capabilities: probes }], { logger: noopLogger })
      );
      for (const [index, item] of cases.entries()) {
        const expected = actual.get(item.id)!.input.parse(item.input);
        expect(
          payloadOf(
            (await client.callTool({
              name: `nested_case_${index}`,
              arguments: item.input,
            })) as CallToolResult
          )
        ).toEqual(expected);
        expect(handlers[index]).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expected,
          expect.anything()
        );
      }
    });

    it.each(['ui.send_canvas_event', 'ui.patch_canvas_state'])(
      'preserves %s at exactly 16,384 bytes and refuses 16,385 before its handler',
      async (id) => {
        const original = actual.get(id)!;
        expect(
          inputNodes(original.input).filter((node) => node.schema instanceof z.ZodDefault)
        ).toEqual([]);
        const event = id === 'ui.send_canvas_event';
        const input = event
          ? {
              documentId: 'doc',
              eventId: '00000000-0000-4000-8000-000000000001',
              type: 'custom.event',
              payload: '',
            }
          : {
              documentId: 'doc',
              eventId: '00000000-0000-4000-8000-000000000002',
              expectedStateRev: 0,
              operations: [{ op: 'set', path: '/value', value: '' }],
            };
        const fill = (extra: number) => {
          const value = 'x'.repeat(
            CANVAS_CHANNEL_ENVELOPE_BYTES - Buffer.byteLength(JSON.stringify(input)) + extra
          );
          return event
            ? { ...input, payload: value }
            : { ...input, operations: [{ op: 'set', path: '/value', value }] };
        };
        const handler = vi.fn(async () => ({ ok: true }));
        const cap = defineCapability({
          id: 'canvas.bound',
          title: 'Canvas schema',
          description: 'Original executable input; recording service.',
          tier: 'observe',
          area: null,
          input: original.input,
          output: z.unknown(),
          surfaces: { mcp: { toolName: 'canvas_bound', servers: ['in-session'] } },
          invoke: handler,
        });
        const { client } = await createCapabilityMcpClient(
          composeRegistry([{ name: 'canvas', capabilities: [cap] }], { logger: noopLogger })
        );
        const valid = fill(0),
          over = fill(1);
        expect(Buffer.byteLength(JSON.stringify(valid))).toBe(16_384);
        expect(Buffer.byteLength(JSON.stringify(over))).toBe(16_385);
        expect(
          payloadOf(
            (await client.callTool({ name: 'canvas_bound', arguments: valid })) as CallToolResult
          )
        ).toEqual({ ok: true });
        expect(original.input.parse(valid)).toEqual(valid);
        expect(handler).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          valid,
          expect.anything()
        );
        expect((await client.callTool({ name: 'canvas_bound', arguments: over })).isError).toBe(
          true
        );
        expect(handler).toHaveBeenCalledTimes(1);
      }
    );
  });
}
