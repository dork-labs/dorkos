import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import type { SerializedCapability } from '@dorkos/shared/capabilities';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { createCapabilityAuthorityBinding } from '../../../connectors/principal/capability-authority-binding.js';

import {
  defineCapability,
  composeRegistry,
  computeCatalogVersion,
  serializeCapability,
  CapabilityToolError,
  type CapabilityDeps,
  type CapabilityDomain,
  type ExtensionContribution,
  type ExtensionToolSpec,
} from '../index.js';
import {
  buildExtensionDefinitions,
  checkExtensionContribution,
  extensionDomainName,
  EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
} from '../extension-contribution.js';

const deps: CapabilityDeps = { logger: noopLogger };

/** A representative read capability exercising optionals, enums, and records. */
const configGet = defineCapability({
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
const configPatch = defineCapability({
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
  it('forwards an authentic principal and per-call signal through live preflight', async () => {
    const controller = new AbortController();
    const principal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: 'binding-a',
      runtime: 'codex',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      agentPath: '/agents/a',
    });
    const authorityBinding = createCapabilityAuthorityBinding({
      digest: 'authority-a',
      ownerKind: 'local_install',
      ownerId: 'install-a',
      agentId: 'agent-a',
      sessionId: 'session-a',
      connectionId: 'connection-a',
      operationRevisionId: 'revision-a',
    });
    const seen: unknown[] = [];
    const probe = defineCapability({
      id: 'probe.authority',
      title: 'Probe authority',
      description: 'Records authenticated invocation authority.',
      tier: 'observe',
      area: null,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      surfaces: {},
      preflight: async (_deps, _input, context) => {
        seen.push(['preflight', context.serverPrincipal, context.signal]);
        return { authorityBinding };
      },
      invoke: async (_deps, _input, context) => {
        seen.push([
          'invoke',
          context.serverPrincipal,
          context.signal,
          context.preflight?.authorityBinding,
        ]);
        return { ok: true };
      },
    });
    const registry = composeRegistry([{ name: 'probe', capabilities: [probe] }], deps);

    await expect(
      registry.invoke(
        'probe.authority',
        {},
        { serverPrincipal: principal, signal: controller.signal }
      )
    ).resolves.toEqual({ ok: true });
    expect(seen).toEqual([
      ['preflight', principal, controller.signal],
      ['invoke', principal, controller.signal, authorityBinding],
    ]);
  });

  it('refuses structural principal and preflight proof lookalikes', async () => {
    const forgedPrincipal = defineCapability({
      id: 'probe.principal',
      title: 'Probe principal',
      description: 'Never runs for a forged principal.',
      tier: 'observe',
      area: null,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      surfaces: {},
      invoke: async () => ({ ok: true }),
    });
    const forgedPreflight = defineCapability({
      id: 'probe.binding',
      title: 'Probe binding',
      description: 'Never runs for a forged authority binding.',
      tier: 'observe',
      area: null,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      surfaces: {},
      preflight: async () => ({
        authorityBinding: {
          approvalScope: {
            digest: 'forged',
            ownerKind: 'local_install',
            ownerId: 'install-a',
            connectionId: 'connection-a',
            operationRevisionId: 'revision-a',
          },
        },
      }),
      invoke: async () => ({ ok: true }),
    });
    const registry = composeRegistry(
      [{ name: 'probe', capabilities: [forgedPrincipal, forgedPreflight] }],
      deps
    );

    await expect(
      registry.invoke(
        'probe.principal',
        {},
        {
          serverPrincipal: {
            claims: {
              kind: 'operator',
              owner: { kind: 'local_install', installationId: 'install-a' },
            },
          },
        }
      )
    ).rejects.toThrow(/unauthenticated server principal/);
    await expect(registry.invoke('probe.binding', {})).rejects.toThrow(
      /unauthenticated authority binding/
    );
  });

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
      area: null,
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
      area: null,
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
      area: null,
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
      area: null,
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

  it('carries the declared permission area on every entry, null included', () => {
    // The catalog is where readers and the docs projection read an action's area
    // from (spec `agent-permissions` D2), so a capability whose area never
    // reached the wire would be listed under the wrong row. Present on every
    // entry, `null` for an area-less one, so no reader has to guess what a
    // missing key means.
    const inArea = defineCapability({
      id: 'config.manage',
      title: 'Manage config',
      description: 'A capability declaring a permission area, for the catalog assertion.',
      tier: 'act',
      area: 'settings',
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'config_manage', servers: ['external'] } },
      invoke: async () => ({ ok: true }),
    });
    const registry = composeRegistry([{ name: 'config', capabilities: [configGet, inArea] }], deps);
    const entries = registry.catalog().capabilities;

    expect(entries.find((c) => c.id === 'config.manage')?.area).toBe('settings');
    expect(entries.find((c) => c.id === 'config.get')?.area).toBeNull();
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
      area: null,
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
      area: null,
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
          area: null,
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
          area: null,
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

/** One extension tool spec, recording calls into `calls` when given. */
function extensionTool(
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
function contribution(
  owner: string,
  tools: ExtensionToolSpec[] = [extensionTool('send_message')]
): ExtensionContribution {
  return { owner, displayName: `Ext ${owner}`, tools };
}

describe('extension layer — contribute and remove (DOR-2685)', () => {
  it('adds tools to get, capabilities and the catalog, and takes them away on remove', () => {
    // The whole point of the live layer: an extension's tools exist exactly
    // while it runs, and removing them leaves the catalog byte-identical,
    // version included, to what it was before.
    const registry = composeRegistry([configDomain], deps);
    const original = registry.catalog().catalogVersion;

    const result = registry.contribute(contribution('mail-app'));
    expect(result.ok).toBe(true);
    expect(registry.get('ext_mail_app.send_message')?.title).toBe('Tool send_message');
    expect(registry.capabilities.map((c) => c.id)).toEqual([
      'config.get',
      'config.patch',
      'ext_mail_app.send_message',
    ]);
    expect(Object.isFrozen(registry.capabilities)).toBe(true);
    const during = registry.catalog();
    expect(during.capabilities.map((c) => c.id)).toContain('ext_mail_app.send_message');
    expect(during.catalogVersion).not.toBe(original);

    if (result.ok) result.remove();
    expect(registry.get('ext_mail_app.send_message')).toBeUndefined();
    expect(registry.capabilities.map((c) => c.id)).toEqual(['config.get', 'config.patch']);
    expect(registry.catalog().capabilities.map((c) => c.id)).toEqual([
      'config.get',
      'config.patch',
    ]);
    expect(registry.catalog().catalogVersion).toBe(original);
  });

  it('refuses an MCP tool name the core already claims, leaving the registry unchanged', () => {
    // An extension id can never collide with a core id (the ext_ prefix is
    // reserved), but a core capability's MCP tool name is free-form, so the
    // claim table must still be consulted.
    const squatter = defineCapability({
      id: 'probe.squat',
      title: 'Squat',
      description: 'Claims a tool name in the extension namespace.',
      tier: 'observe',
      area: null,
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'ext_mail_app__send_message', servers: ['in-session'] } },
      invoke: async () => ({}),
    });
    const registry = composeRegistry([{ name: 'probe', capabilities: [squatter] }], deps);
    const before = registry.catalog().catalogVersion;

    const result = registry.contribute(
      contribution('mail-app', [extensionTool('archive'), extensionTool('send_message')])
    );

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('already taken') });
    expect(registry.capabilities.map((c) => c.id)).toEqual(['probe.squat']);
    expect(registry.get('ext_mail_app.archive')).toBeUndefined();
    expect(registry.catalog().catalogVersion).toBe(before);
  });

  it('refuses a tool name another contribution claims, adding nothing from the second', () => {
    // `a--b` + `c` and `a` + `b__c` both project to `ext_a__b__c`: different
    // ids, one MCP name. The first keeps it; the second adds none of its tools.
    const registry = composeRegistry([configDomain], deps);
    expect(registry.contribute(contribution('a--b', [extensionTool('c')])).ok).toBe(true);

    const second = registry.contribute(
      contribution('a', [extensionTool('first_ok'), extensionTool('b__c')])
    );

    expect(second).toEqual({ ok: false, reason: expect.stringContaining('ext_a__b__c') });
    expect(registry.get('ext_a.first_ok')).toBeUndefined();
    expect(registry.get('ext_a.b__c')).toBeUndefined();
    expect(registry.capabilities.map((c) => c.id)).toEqual([
      'config.get',
      'config.patch',
      'ext_a__b.c',
    ]);
  });

  it('refuses a malformed contribution whole, even when only one tool is wrong', () => {
    // All-or-nothing applies to validation too: one bad tool means none load.
    const registry = composeRegistry([configDomain], deps);
    const result = registry.contribute(
      contribution('mail-app', [extensionTool('ok_tool'), extensionTool('Bad-Name')])
    );
    expect(result.ok).toBe(false);
    expect(registry.get('ext_mail_app.ok_tool')).toBeUndefined();
  });

  it('refuses a second contribution from a live owner, and accepts it after remove', () => {
    // Nothing is ever replaced in place: a restart is remove, then contribute.
    const registry = composeRegistry([configDomain], deps);
    const first = registry.contribute(contribution('mail-app'));
    expect(first.ok).toBe(true);

    const again = registry.contribute(contribution('mail-app', [extensionTool('archive')]));
    expect(again).toEqual({ ok: false, reason: expect.stringContaining('already has tools') });
    expect(registry.get('ext_mail_app.archive')).toBeUndefined();

    if (first.ok) first.remove();
    expect(registry.contribute(contribution('mail-app', [extensionTool('archive')])).ok).toBe(true);
    expect(registry.get('ext_mail_app.archive')).toBeDefined();
  });

  it('makes remove idempotent, and a stale handle cannot remove a newer contribution', () => {
    // Shutdown paths can overlap (a reload racing a disable); calling remove
    // twice, or on a handle from before a restart, must never take away the
    // tools the extension registered since.
    const registry = composeRegistry([configDomain], deps);
    const versions: number[] = [];
    registry.onChange((v) => versions.push(v));
    const first = registry.contribute(contribution('mail-app'));
    if (!first.ok) throw new Error('expected the first contribution to land');
    first.remove();
    first.remove();
    const second = registry.contribute(contribution('mail-app'));
    first.remove();

    expect(second.ok).toBe(true);
    expect(registry.get('ext_mail_app.send_message')).toBeDefined();
    expect(versions).toEqual([1, 2, 3]);
  });

  it('fires onChange once per successful change, with increasing versions, until unsubscribed', () => {
    // Open clients and tool-list builders key off this; a refused contribution
    // changed nothing and must not announce a change.
    const registry = composeRegistry([configDomain], deps);
    const versions: number[] = [];
    const stop = registry.onChange((v) => versions.push(v));

    const a = registry.contribute(contribution('mail-app'));
    registry.contribute(contribution('mail-app')); // refused: owner is live
    const b = registry.contribute(contribution('calendar'));
    if (a.ok) a.remove();
    expect(versions).toEqual([1, 2, 3]);

    stop();
    if (b.ok) b.remove();
    expect(versions).toEqual([1, 2, 3]);
  });

  it('keeps calling other listeners when one throws', () => {
    // A broken subscriber must not stop the SSE broadcast from hearing it.
    const registry = composeRegistry([configDomain], deps);
    const heard: number[] = [];
    registry.onChange(() => {
      throw new Error('boom');
    });
    registry.onChange((v) => heard.push(v));
    expect(registry.contribute(contribution('mail-app')).ok).toBe(true);
    expect(heard).toEqual([1]);
  });

  it('answers a removed extension tool with the plain not-available tool error', async () => {
    // An agent may still hold a tool list built while the extension ran; it
    // gets a sentence it can act on, not an internal "no capability" throw.
    const registry = composeRegistry([configDomain], deps);
    const result = registry.contribute(contribution('mail-app'));
    if (result.ok) result.remove();

    const error = await registry
      .invoke('ext_mail_app.send_message', { to: 'a@example.com' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CapabilityToolError);
    expect((error as CapabilityToolError).payload).toEqual({
      error: EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
      code: 'EXTENSION_TOOL_UNAVAILABLE',
    });
    // A core id that does not exist keeps today's error.
    await expect(registry.invoke('config.nope', {})).rejects.not.toBeInstanceOf(
      CapabilityToolError
    );
  });

  it('runs a live extension tool through invoke with its parsed input', async () => {
    // The contributed definition is a real capability: same parse, same path.
    const calls: unknown[] = [];
    const registry = composeRegistry([configDomain], deps);
    registry.contribute(
      contribution('mail-app', [extensionTool('send_message', { tier: 'observe' }, calls)])
    );
    await expect(
      registry.invoke('ext_mail_app.send_message', { to: 'a@example.com', extra: 1 })
    ).resolves.toEqual({ sent: true });
    expect(calls).toEqual([{ to: 'a@example.com' }]);
  });
});

describe('extension layer — reserved namespace (DOR-2685)', () => {
  it('refuses a core domain named in the ext_ namespace at boot', () => {
    // Otherwise a core domain could pre-claim an extension's ids, or an
    // extension's tools could be mistaken for core ones.
    expect(() => composeRegistry([{ name: 'ext_x', capabilities: [] }], deps)).toThrow(
      /reserved for extension tools/
    );
  });

  it('refuses a core capability that claims an extension source', () => {
    // `source` on the catalog must always mean what it says.
    const pretender = defineCapability({
      ...configGet,
      source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
    });
    expect(() => composeRegistry([{ name: 'config', capabilities: [pretender] }], deps)).toThrow(
      /declares a source/
    );
  });

  it('maps an extension id to its domain injectively', () => {
    expect(extensionDomainName('mail-app')).toBe('ext_mail_app');
    expect(extensionDomainName('mail')).toBe('ext_mail');
  });
});

describe('extension layer — host-built definitions carry no privileged fields (DOR-2685)', () => {
  it('builds only the allowed keys, even from a spec smuggling privileged ones', () => {
    // An extension object is author-controlled. Whatever extra keys it
    // carries, the built definition has exactly these fields and no others:
    // no preflight, forwardsApproval, inSessionCard, approvalSubject,
    // areasForInput, describeApprovalChange, approvalDetailField, approvalView.
    const smuggled = {
      ...extensionTool('send_message'),
      preflight: async () => ({}),
      forwardsApproval: true,
      inSessionCard: 'oauth',
      approvalSubject: { field: 'to', registry: 'agents' },
      areasForInput: () => ['permissions'],
      describeApprovalChange: async () => 'x',
      approvalDetailField: 'to',
      approvalView: () => ({}),
      areaNote: 'x',
      source: { kind: 'extension', id: 'someone-else', name: 'Spoof' },
      surfaces: { cli: { verb: 'x' }, http: { method: 'get', path: '/x' } },
    } as unknown as ExtensionToolSpec;
    const checked = checkExtensionContribution(contribution('mail-app', [smuggled]));
    if (!checked.ok) throw new Error(checked.reason);
    // The checked copy is the first wall: only spec fields survive it.
    expect(Object.keys(checked.value.tools[0]!).sort()).toEqual(
      ['approvalDisplayFields', 'description', 'input', 'invoke', 'name', 'tier', 'title'].sort()
    );
    const [definition] = buildExtensionDefinitions(checked.value, 'extensions');

    expect(Object.keys(definition!).sort()).toEqual(
      [
        'approvalDisplayFields',
        'area',
        'description',
        'id',
        'input',
        'invoke',
        'output',
        'source',
        'surfaces',
        'tier',
        'title',
      ].sort()
    );
    expect(definition!.surfaces).toEqual({
      mcp: { toolName: 'ext_mail_app__send_message', servers: ['in-session'] },
    });
    expect(definition!.source).toEqual({ kind: 'extension', id: 'mail-app', name: 'Ext mail-app' });
    expect(definition!.area).toBe('extensions');
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it('refuses display fields the input lacks or that name a secret', () => {
    // A display field reaches the broadcast approval card.
    const missing = checkExtensionContribution(
      contribution('mail-app', [extensionTool('send', { approvalDisplayFields: ['nope'] })])
    );
    expect(missing.ok).toBe(false);
    const secret = checkExtensionContribution(
      contribution('mail-app', [
        extensionTool('send', {
          input: z.object({ apiToken: z.string() }),
          approvalDisplayFields: ['apiToken'],
        }),
      ])
    );
    expect(secret.ok).toBe(false);
  });

  it('never throws on hostile input, answering a refusal instead', () => {
    // contribute's contract is "never throws"; a getter that throws is the
    // sharpest version of a malformed contribution.
    const registry = composeRegistry([configDomain], deps);
    const hostile = {
      owner: 'mail-app',
      displayName: 'Mail',
      get tools(): never {
        throw new Error('gotcha');
      },
    } as unknown as ExtensionContribution;
    expect(registry.contribute(hostile)).toEqual({
      ok: false,
      reason: expect.stringContaining('gotcha'),
    });
    expect(registry.contribute(null as unknown as ExtensionContribution).ok).toBe(false);
    expect(registry.contribute(contribution('Bad_Id')).ok).toBe(false);
    expect(registry.contribute(contribution('mail-app', [])).ok).toBe(false);
  });
});
