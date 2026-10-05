/**
 * Discovery's tool check and the capability registry agree (DOR-2685).
 *
 * `checkDeclaredTools` lives in `@dorkos/extension-api/tool-check` so
 * `dorkos marketplace validate` can run it; the registry's `contribute` runs
 * the same rules. Every tool discovery accepts, handed to a real registry the
 * way the lifecycle hands it, is accepted.
 */
import { describe, it, expect } from 'vitest';
import { ExtensionManifestSchema, type ExtensionManifest } from '@dorkos/extension-api';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { noopLogger } from '@dorkos/shared/logger';

import { composeRegistry } from '../../../core/capabilities/registry.js';

/** A closed object schema around the given properties. */
function closed(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'object', properties, additionalProperties: false, ...extra };
}

/** Parse a manifest declaring the given tools, failing loudly if it does not parse. */
function manifestWith(
  tools: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
): ExtensionManifest {
  return ExtensionManifestSchema.parse({
    id: 'mail-app',
    name: 'Mail',
    version: '1.0.0',
    serverCapabilities: { serverEntry: './server.ts' },
    tools,
    ...extra,
  });
}

/** An observe tool with the given input schema. */
function observeTool(name: string, inputSchema: unknown, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: `Read ${name}`,
    description: `Reads ${name}.`,
    tier: 'observe',
    inputSchema,
    ...extra,
  };
}

describe('checkDeclaredTools and registry.contribute', () => {
  it('agrees with registry.contribute on every tool it accepts', () => {
    // Purpose: the agreement property itself. Every accepted tool, handed to a
    // real registry exactly as the lifecycle will hand it, is accepted.
    const checks = checkDeclaredTools(
      manifestWith([
        observeTool('list_inbox', closed({ limit: { type: 'integer', default: 20 } })),
        {
          ...observeTool('send', closed({ to: { type: 'string' } }, { required: ['to'] })),
          tier: 'act',
          approvalDisplayFields: ['to'],
        },
        {
          ...observeTool('purge', closed({ folder: { type: 'string' } })),
          tier: 'destructive',
          approvalDisplayFields: ['folder'],
        },
      ])
    );
    const accepted = checks.filter((c) => c.ok);
    expect(accepted).toHaveLength(3);
    const registry = composeRegistry([], { logger: noopLogger });
    const result = registry.contribute({
      owner: 'mail-app',
      displayName: 'Mail',
      tools: accepted.map((tool) => ({ ...tool, invoke: async () => 'ok' })),
    });
    expect(result).toMatchObject({ ok: true });
    expect(registry.get('ext_mail_app.purge')?.tier).toBe('destructive');
  });
});
