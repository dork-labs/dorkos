/** Extension listability contracts, composed into the real SDK default suite. */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { createDorkOsToolServer } from '../index.js';
import type { McpContractHarness } from './current-input-schemas.js';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { extensionDomainName, extensionMcpToolName } from '@dorkos/shared/capabilities';

/** Register accepted/defaulted and refused extension contracts beside real core tools. */
export function registerExtensionListabilityTests({
  createFullDeps,
  connect,
  payloadOf,
}: McpContractHarness): void {
  describe('supported extensions beside the real core SDK listing', () => {
    it('accepts declared defaults and excludes unsupported declared siblings before registration', async () => {
      const registry = composeCapabilityRegistryForDocs();
      const manifest = ExtensionManifestSchema.parse({
        id: 'wire-extension',
        name: 'Wire extension',
        version: '1.0.0',
        serverCapabilities: { serverEntry: './server.ts' },
        tools: [
          {
            name: 'read_default',
            title: 'Read a folder',
            description: 'Reads a defaulted folder.',
            tier: 'observe',
            inputSchema: {
              type: 'object',
              properties: { folder: { type: 'string', default: 'inbox' } },
              additionalProperties: false,
            },
          },
          {
            name: 'read_unsupported',
            title: 'Read unsupported',
            description: 'Unsupported declaration.',
            tier: 'observe',
            inputSchema: {
              type: 'object',
              properties: { constructor: { type: 'string' } },
              additionalProperties: false,
            },
          },
        ],
      });
      const checks = checkDeclaredTools(manifest);
      expect(checks.map((check) => [check.name, check.ok])).toEqual([
        ['read_default', true],
        ['read_unsupported', false],
      ]);
      expect(checks[1]).toMatchObject({ reason: expect.stringMatching(/reserved property name/) });
      const handler = vi.fn(async (input: unknown) => input);
      const accepted = checks.filter((check) => check.ok);
      expect(accepted).toHaveLength(1);
      const contribution = registry.contribute({
        owner: manifest.id,
        displayName: manifest.name,
        tools: accepted.map((check) => ({ ...check, invoke: handler })),
      });
      expect(contribution.ok).toBe(true);
      expect(registry.get('ext_wire_extension.read_unsupported')).toBeUndefined();
      const server = createDorkOsToolServer(
        createFullDeps(),
        undefined,
        undefined,
        undefined,
        registry
      );
      const { client, close } = await connect(server.instance);
      try {
        const listed = (await client.listTools()).tools;
        expect(listed.filter((tool) => tool.name === 'list_capabilities')).toHaveLength(1);
        expect(
          listed
            .filter((tool) => tool.name.startsWith('ext_wire_extension__'))
            .map((tool) => tool.name)
        ).toEqual(['ext_wire_extension__read_default']);
        expect(
          (await client.callTool({ name: 'ext_wire_extension__read_unsupported', arguments: {} }))
            .isError
        ).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        expect(
          payloadOf(
            (await client.callTool({
              name: 'ext_wire_extension__read_default',
              arguments: {},
            })) as CallToolResult
          )
        ).toEqual({ folder: 'inbox' });
        expect(
          payloadOf(
            (await client.callTool({
              name: 'ext_wire_extension__read_default',
              arguments: { folder: 'sent' },
            })) as CallToolResult
          )
        ).toEqual({ folder: 'sent' });
        expect(handler.mock.calls.map((args) => args[0])).toEqual([
          { folder: 'inbox' },
          { folder: 'sent' },
        ]);
      } finally {
        await close();
      }
    });

    it.each([
      [
        'record',
        z.object({ value: z.record(z.string(), z.string()) }).strict(),
        'Test extension',
        /record|propertyNames/,
      ],
      ['lazy', z.object({ value: z.lazy(() => z.string()) }).strict(), 'Test extension', /lazy/],
      ['date', z.object({ value: z.date() }).strict(), 'Test extension', /JSON Schema/],
      ['open', z.object({ value: z.string() }).loose(), 'Test extension', /additionalProperties/],
      ['reserved', z.object({ value: z.string() }).strict(), 'DorkOS', /may not call itself/],
    ] as const)(
      'rejects %s before registration and still lists the same-name defaulted replacement beside core',
      async (kind, input, displayName, why) => {
        const registry = composeCapabilityRegistryForDocs();
        const owner = `schema-${kind}`;
        const handler = vi.fn(async (args: unknown) => args);
        const tool = {
          name: 'read_value',
          title: 'Read a value',
          description: 'Reads one extension value.',
          tier: 'observe' as const,
          input,
          invoke: handler,
        };
        expect(registry.contribute({ owner, displayName, tools: [tool] })).toMatchObject({
          ok: false,
          reason: expect.stringMatching(why),
        });
        const id = `${extensionDomainName(owner)}.read_value`,
          name = extensionMcpToolName(owner, 'read_value');
        expect(registry.get(id)).toBeUndefined();
        expect(handler).not.toHaveBeenCalled();
        const replacement = registry.contribute({
          owner,
          displayName: 'Test extension',
          tools: [{ ...tool, input: z.object({ value: z.string().default('inbox') }).strict() }],
        });
        expect(replacement.ok).toBe(true);
        const server = createDorkOsToolServer(
          createFullDeps(),
          undefined,
          undefined,
          undefined,
          registry
        );
        const { client, close } = await connect(server.instance);
        try {
          const listed = (await client.listTools()).tools;
          expect(listed.filter((entry) => entry.name === 'list_capabilities')).toHaveLength(1);
          expect(listed.filter((entry) => entry.name === name)).toHaveLength(1);
          expect(
            payloadOf((await client.callTool({ name, arguments: {} })) as CallToolResult)
          ).toEqual({ value: 'inbox' });
          expect(handler).toHaveBeenCalledExactlyOnceWith({ value: 'inbox' }, expect.anything());
        } finally {
          await close();
        }
      }
    );
  });
}
