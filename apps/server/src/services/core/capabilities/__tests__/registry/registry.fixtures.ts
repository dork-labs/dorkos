import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import {
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type ExtensionContribution,
  type ExtensionToolSpec,
} from '../../index.js';

export const deps: CapabilityDeps = { logger: noopLogger };

/** A representative read capability exercising optionals, enums, and records. */
export const configGet = defineCapability({
  id: 'config.get',
  title: 'Get config',
  description: 'Return the DorkOS config snapshot.',
  tier: 'observe',
  area: null,
  input: z.object({
    section: z.string().optional(),
    format: z.enum(['json', 'yaml']),
    overrides: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ ok: z.boolean() }),
  surfaces: {
    mcp: {
      toolName: 'config_get',
      servers: ['in-session', 'external'],
      readOnlyCarveOut: true,
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    cli: { verb: 'config', subcommand: 'get' },
    http: { method: 'get', path: '/api/config' },
  },
  invoke: async (_deps, input) => ({ ok: input.format === 'json' }),
});

/** A representative mutation capability. */
export const configPatch = defineCapability({
  id: 'config.patch',
  title: 'Patch config',
  description: 'Deep-merge a partial config object.',
  tier: 'act',
  area: null,
  input: z.object({ patch: z.record(z.string(), z.unknown()) }),
  output: z.object({ applied: z.boolean() }),
  surfaces: {
    mcp: { toolName: 'config_patch', servers: ['external'] },
    cli: { verb: 'config', subcommand: 'patch' },
  },
  invoke: async () => ({ applied: true }),
});

export const configDomain: CapabilityDomain = {
  name: 'config',
  capabilities: [configGet, configPatch],
};

/** One extension tool spec, recording calls into `calls` when given. */
export function extensionTool(
  name: string,
  overrides: Partial<ExtensionToolSpec> = {},
  calls: unknown[] = []
): ExtensionToolSpec {
  return {
    name,
    title: `Tool ${name}`,
    description: `The ${name} probe tool.`,
    tier: 'act',
    input: z.object({ to: z.string() }),
    approvalDisplayFields: ['to'],
    invoke: async (input) => {
      calls.push(input);
      return { sent: true };
    },
    ...overrides,
  };
}

/** A contribution from one extension with the given tools. */
export function contribution(
  owner: string,
  tools: ExtensionToolSpec[] = [extensionTool('send_message')]
): ExtensionContribution {
  return { owner, displayName: `Ext ${owner}`, tools };
}
