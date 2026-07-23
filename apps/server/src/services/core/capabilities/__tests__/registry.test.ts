import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import type { SerializedCapability } from '@dorkos/shared/capabilities';

import {
  defineCapability,
  composeRegistry,
  computeCatalogVersion,
  serializeCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../index.js';

const deps: CapabilityDeps = { logger: noopLogger };

/** A representative read capability exercising optionals, enums, and records. */
const configGet = defineCapability({
  id: 'config.get',
  title: 'Get config',
  description: 'Return the DorkOS config snapshot.',
  tier: 'observe',
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
const configPatch = defineCapability({
  id: 'config.patch',
  title: 'Patch config',
  description: 'Deep-merge a partial config object.',
  tier: 'act',
  input: z.object({ patch: z.record(z.string(), z.unknown()) }),
  output: z.object({ applied: z.boolean() }),
  surfaces: {
    mcp: { toolName: 'config_patch', servers: ['external'] },
    cli: { verb: 'config', subcommand: 'patch' },
  },
  invoke: async () => ({ applied: true }),
});

const configDomain: CapabilityDomain = {
  name: 'config',
  capabilities: [configGet, configPatch],
};

describe('composeRegistry — composition', () => {
  it('registers every capability in registration order', () => {
    const registry = composeRegistry([configDomain], deps);
    expect(registry.capabilities.map((c) => c.id)).toEqual(['config.get', 'config.patch']);
  });

  it('looks up a capability by id', () => {
    const registry = composeRegistry([configDomain], deps);
    expect(registry.get('config.get')?.title).toBe('Get config');
    expect(registry.get('config.missing')).toBeUndefined();
  });

  it('freezes the registry and its capability list', () => {
    const registry = composeRegistry([configDomain], deps);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.capabilities)).toBe(true);
  });
});

describe('composeRegistry — invoke', () => {
  it('validates input against the schema and returns plain typed output', async () => {
    const registry = composeRegistry([configDomain], deps);
    const result = await registry.invoke('config.get', {
      format: 'json',
      overrides: {},
    });
    expect(result).toEqual({ ok: true });
  });

  it('throws a ZodError on invalid input', async () => {
    const registry = composeRegistry([configDomain], deps);
    await expect(
      registry.invoke('config.get', { format: 'xml', overrides: {} })
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('throws on an unknown id', async () => {
    const registry = composeRegistry([configDomain], deps);
    await expect(registry.invoke('config.nope', {})).rejects.toThrow(
      /no capability registered for id "config.nope"/
    );
  });

  it('passes the captured deps bag into the handler', async () => {
    const seen: CapabilityDeps[] = [];
    const probe = defineCapability({
      id: 'probe.ping',
      title: 'Ping',
      description: 'Records the deps it was invoked with.',
      tier: 'observe',
      input: z.object({}),
      output: z.object({ pong: z.boolean() }),
      surfaces: {},
      invoke: async (d) => {
        seen.push(d);
        return { pong: true };
      },
    });
    const registry = composeRegistry([{ name: 'probe', capabilities: [probe] }], deps);
    await registry.invoke('probe.ping', {});
    expect(seen).toEqual([deps]);
  });
});

describe('composeRegistry — startup conflict detection', () => {
  it('throws on a duplicate capability id', () => {
    const dup = defineCapability({ ...configGet, surfaces: {} });
    expect(() =>
      composeRegistry([{ name: 'config', capabilities: [configGet, dup] }], deps)
    ).toThrow(/duplicate capability id "config.get"/);
  });

  it('throws on a duplicate MCP tool name', () => {
    const clash = defineCapability({
      id: 'config.reset',
      title: 'Reset',
      description: 'Reset config.',
      tier: 'destructive',
      input: z.object({}),
      output: z.object({}),
      surfaces: { mcp: { toolName: 'config_get', servers: ['external'] } },
    });
    expect(() =>
      composeRegistry([{ name: 'config', capabilities: [configGet, clash] }], deps)
    ).toThrow(/duplicate MCP tool name "config_get"/);
  });

  it('throws on a duplicate CLI verb+subcommand', () => {
    const clash = defineCapability({
      id: 'config.fetch',
      title: 'Fetch',
      description: 'Fetch config.',
      tier: 'observe',
      input: z.object({}),
      output: z.object({}),
      surfaces: { cli: { verb: 'config', subcommand: 'get' } },
    });
    expect(() =>
      composeRegistry([{ name: 'config', capabilities: [configGet, clash] }], deps)
    ).toThrow(/duplicate CLI verb "config get"/);
  });

  it('does not collide distinct subcommands under one verb', () => {
    expect(() => composeRegistry([configDomain], deps)).not.toThrow();
  });

  it('throws on a duplicate HTTP route', () => {
    const clash = defineCapability({
      id: 'config.snapshot',
      title: 'Snapshot',
      description: 'Snapshot config.',
      tier: 'observe',
      input: z.object({}),
      output: z.object({}),
      surfaces: { http: { method: 'get', path: '/api/config' } },
    });
    expect(() =>
      composeRegistry([{ name: 'config', capabilities: [configGet, clash] }], deps)
    ).toThrow(/duplicate HTTP route "GET \/api\/config"/);
  });

  it('throws when an id is not prefixed with its domain name', () => {
    const misfiled = defineCapability({ ...configGet, id: 'agent.get', surfaces: {} });
    expect(() => composeRegistry([{ name: 'config', capabilities: [misfiled] }], deps)).toThrow(
      /must be prefixed with its domain name "config."/
    );
  });
});

describe('catalog — serialization', () => {
  it('serializes every capability without the invoke handler', () => {
    const registry = composeRegistry([configDomain], deps);
    const catalog = registry.catalog();
    expect(catalog.capabilities.map((c) => c.id)).toEqual(['config.get', 'config.patch']);
    for (const entry of catalog.capabilities) {
      expect(entry).not.toHaveProperty('invoke');
      expect(entry).not.toHaveProperty('input');
      expect(entry.inputSchema).toBeTypeOf('object');
      expect(entry.outputSchema).toBeTypeOf('object');
    }
  });

  it('carries surfaces and tier through unchanged', () => {
    const registry = composeRegistry([configDomain], deps);
    const get = registry.catalog().capabilities.find((c) => c.id === 'config.get');
    expect(get?.tier).toBe('observe');
    expect(get?.surfaces.mcp).toEqual({
      toolName: 'config_get',
      servers: ['in-session', 'external'],
      readOnlyCarveOut: true,
      annotations: { openWorldHint: true, idempotentHint: true },
    });
  });

  it('carries the per-tool MCP annotation hints through unchanged', () => {
    const registry = composeRegistry([configDomain], deps);
    const get = registry.catalog().capabilities.find((c) => c.id === 'config.get');
    expect(get?.surfaces.mcp?.annotations).toEqual({ openWorldHint: true, idempotentHint: true });
  });

  it('renders optionals, enums, and records as faithful JSON Schema', () => {
    const registry = composeRegistry([configDomain], deps);
    const schema = registry.catalog().capabilities.find((c) => c.id === 'config.get')
      ?.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    // Optional field is omitted from `required`; required fields are present.
    expect(schema.required).toContain('format');
    expect(schema.required).toContain('overrides');
    expect(schema.required).not.toContain('section');
    // Enum renders its member list.
    expect(schema.properties.format.enum).toEqual(['json', 'yaml']);
    // Record renders as an open object with string property names.
    expect(schema.properties.overrides.type).toBe('object');
    expect(schema.properties.overrides).toHaveProperty('additionalProperties');
  });
});

describe('catalog — content-hash version stability', () => {
  it('is stable across repeated reads (and independent of generatedAt)', () => {
    const registry = composeRegistry([configDomain], deps);
    const a = registry.catalog();
    const b = registry.catalog();
    expect(a.catalogVersion).toBe(b.catalogVersion);
    expect(a.catalogVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('does not change when object keys are written in a different order', () => {
    const ordered: SerializedCapability = {
      id: 'x.y',
      title: 'T',
      description: 'D',
      tier: 'observe',
      inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
      outputSchema: { type: 'object' },
      surfaces: { mcp: { toolName: 't', servers: ['external'] } },
    };
    // Same content, keys inserted in reverse order at every level.
    const reordered = {
      surfaces: { mcp: { servers: ['external'], toolName: 't' } },
      outputSchema: { type: 'object' },
      inputSchema: {
        properties: { b: { type: 'number' }, a: { type: 'string' } },
        type: 'object',
      },
      tier: 'observe',
      description: 'D',
      title: 'T',
      id: 'x.y',
    } as unknown as SerializedCapability;
    expect(computeCatalogVersion([ordered])).toBe(computeCatalogVersion([reordered]));
  });

  it('does not change when domains (and thus capability order) are composed differently', () => {
    const alpha: CapabilityDomain = {
      name: 'alpha',
      capabilities: [
        defineCapability({
          id: 'alpha.one',
          title: 'One',
          description: 'First.',
          tier: 'observe',
          input: z.object({}),
          output: z.object({}),
          surfaces: {},
        }),
      ],
    };
    const beta: CapabilityDomain = {
      name: 'beta',
      capabilities: [
        defineCapability({
          id: 'beta.two',
          title: 'Two',
          description: 'Second.',
          tier: 'observe',
          input: z.object({}),
          output: z.object({}),
          surfaces: {},
        }),
      ],
    };
    const forward = composeRegistry([alpha, beta], deps).catalog().catalogVersion;
    const reverse = composeRegistry([beta, alpha], deps).catalog().catalogVersion;
    expect(forward).toBe(reverse);
  });

  it('changes when content changes', () => {
    const registry = composeRegistry([configDomain], deps);
    const base = registry.catalog();
    const mutated = serializeCapability(configGet);
    const bumped = computeCatalogVersion([{ ...mutated, description: 'changed' }]);
    expect(bumped).not.toBe(base.catalogVersion);
  });

  it('changes when an MCP annotation hint changes', () => {
    const base = serializeCapability(configGet);
    const flipped: SerializedCapability = {
      ...base,
      surfaces: {
        ...base.surfaces,
        mcp: { ...base.surfaces.mcp!, annotations: { openWorldHint: false, idempotentHint: true } },
      },
    };
    expect(computeCatalogVersion([flipped])).not.toBe(computeCatalogVersion([base]));
  });

  it('memoizes the version across reads while keeping generatedAt fresh', () => {
    const registry = composeRegistry([configDomain], deps);
    const a = registry.catalog();
    const b = registry.catalog();
    // Same memoized content + version, and the same frozen capabilities array.
    expect(a.catalogVersion).toBe(b.catalogVersion);
    expect(a.capabilities).toBe(b.capabilities);
    // generatedAt is a valid ISO timestamp regenerated each read.
    expect(() => new Date(a.generatedAt).toISOString()).not.toThrow();
  });
});

describe('tier presence is enforced by the type system', () => {
  it('rejects a definition missing its tier at compile time', () => {
    // @ts-expect-error — `tier` is required on every CapabilityDefinition.
    const invalid = defineCapability({
      id: 'config.notier',
      title: 'No tier',
      description: 'Missing tier.',
      input: z.object({}),
      output: z.object({}),
      surfaces: {},
      invoke: async () => ({}),
    });
    expect(invalid).toBeDefined();
  });
});
