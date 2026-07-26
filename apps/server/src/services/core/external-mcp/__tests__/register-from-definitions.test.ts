/**
 * Tests for the external-registration projection (DOR-499).
 *
 * The behavior worth pinning is the refusal: a config entry naming a tool no
 * definition provides means a rename or removal on the in-session side, and
 * without the throw that tool would just stop being registered on `/mcp` with
 * nothing reporting it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistrar, SdkMcpTool } from '../../mcp-tool-gate.js';
import { ToolAnnotationPresets } from '../../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from '../register-from-definitions.js';

/** A registrar that records what it was asked to register. */
function createRecordingRegistrar() {
  const registered: { name: string; config: Record<string, unknown> }[] = [];
  const registrar = {
    registerTool: vi.fn((name: string, config: Record<string, unknown>) => {
      registered.push({ name, config });
    }),
  } as unknown as ToolRegistrar;
  return { registrar, registered };
}

/** A definition shaped like the SDK's `tool()` output. */
function definition(name: string, description: string, inputSchema: z.ZodRawShape): SdkMcpTool {
  return {
    name,
    description,
    inputSchema,
    handler: async (): Promise<CallToolResult> => ({ content: [] }),
  };
}

describe('registerFromDefinitions', () => {
  it('carries the definition description and input schema onto the registrar', () => {
    const { registrar, registered } = createRecordingRegistrar();
    const schema = { id: z.string() };
    registerFromDefinitions(registrar, [definition('mesh_deny', 'Deny a path.', schema)], {
      mesh_deny: { annotations: ToolAnnotationPresets.mutateUpdateLocal },
    });

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('mesh_deny');
    expect(registered[0].config.description).toBe('Deny a path.');
    expect(registered[0].config.inputSchema).toBe(schema);
    expect(registered[0].config.annotations).toBe(ToolAnnotationPresets.mutateUpdateLocal);
  });

  it('skips definitions with no config, keeping them in-session-only', () => {
    const { registrar, registered } = createRecordingRegistrar();
    registerFromDefinitions(
      registrar,
      [
        definition('binding_list', 'List routes.', {}),
        definition('binding_list_sessions', 'List sessions.', {}),
      ],
      { binding_list: { annotations: ToolAnnotationPresets.readOnlyLocal } }
    );

    expect(registered.map((entry) => entry.name)).toEqual(['binding_list']);
  });

  it('attaches an output schema only when one is declared', () => {
    const { registrar, registered } = createRecordingRegistrar();
    const outputSchema = { count: z.number() };
    registerFromDefinitions(
      registrar,
      [definition('mesh_list', 'List agents.', {}), definition('mesh_status', 'Health.', {})],
      {
        mesh_list: { annotations: ToolAnnotationPresets.readOnlyLocal, outputSchema },
        mesh_status: { annotations: ToolAnnotationPresets.readOnlyLocal },
      }
    );

    expect(registered[0].config.outputSchema).toBe(outputSchema);
    expect(registered[1]).not.toHaveProperty('config.outputSchema');
  });

  it('throws when a config names a tool no definition provides', () => {
    // The drift this exists to catch: the tool was renamed or removed in
    // `runtimes/claude-code/mcp-tools/`, so the external server must refuse to
    // build rather than quietly drop it.
    const { registrar } = createRecordingRegistrar();
    const configs: ExternalToolConfigs = {
      mesh_deny: { annotations: ToolAnnotationPresets.mutateUpdateLocal },
    };

    expect(() =>
      registerFromDefinitions(registrar, [definition('mesh_list', 'List agents.', {})], configs)
    ).toThrow(/mesh_deny/);
  });
});
