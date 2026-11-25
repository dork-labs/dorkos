import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { type CapabilitySurfaces, type SerializedCapability } from '@dorkos/shared/capabilities';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { createCapabilityAuthorityBinding } from '../../../connectors/principal/capability-authority-binding.js';
import {
  defineCapability,
  composeRegistry,
  computeCatalogVersion,
  serializeCapability,
} from '../index.js';
import { deps, configGet, configDomain } from './registry/registry.fixtures.js';

describe('composeRegistry — composition', () => {
  it('registers every capability in order and looks each up by id', () => {
    const registry = composeRegistry([configDomain], deps);
    expect(registry.capabilities.map((c) => c.id)).toEqual(['config.get', 'config.patch']);
    expect(registry.get('config.get')?.title).toBe('Get config');
    expect(registry.get('config.missing')).toBeUndefined();
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

  it('validates input against the schema, throwing a ZodError on invalid input', async () => {
    const registry = composeRegistry([configDomain], deps);
    await expect(registry.invoke('config.get', { format: 'json', overrides: {} })).resolves.toEqual(
      { ok: true }
    );
    await expect(
      registry.invoke('config.get', { format: 'xml', overrides: {} })
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});

describe('composeRegistry — startup conflict detection', () => {
  it('throws on a duplicate capability id', () => {
    const dup = defineCapability({ ...configGet, surfaces: {} });
    expect(() =>
      composeRegistry([{ name: 'config', capabilities: [configGet, dup] }], deps)
    ).toThrow(/duplicate capability id "config.get"/);
  });

  it.each([
    [
      'config.reset',
      { mcp: { toolName: 'config_get', servers: ['external'] } },
      /duplicate MCP tool name "config_get"/,
    ],
    [
      'config.fetch',
      { cli: { verb: 'config', subcommand: 'get' } },
      /duplicate CLI verb "config get"/,
    ],
    [
      'config.snapshot',
      { http: { method: 'get', path: '/api/config' } },
      /duplicate HTTP route "GET \/api\/config"/,
    ],
  ] as const)(
    'throws when %s claims a surface config.get already holds',
    (id, surfaces, message) => {
      const clash = defineCapability({
        id,
        title: 'Clash',
        description: 'Clashes with config.get.',
        tier: 'observe',
        area: null,
        input: z.object({}),
        output: z.object({}),
        surfaces: surfaces as CapabilitySurfaces,
        invoke: async () => ({}),
      });
      expect(() =>
        composeRegistry([{ name: 'config', capabilities: [configGet, clash] }], deps)
      ).toThrow(message);
    }
  );
});

describe('catalog — serialization', () => {
  it('serializes every capability without the handler, carrying tier and surfaces', () => {
    const catalog = composeRegistry([configDomain], deps).catalog();
    expect(catalog.capabilities.map((c) => c.id)).toEqual(['config.get', 'config.patch']);
    for (const entry of catalog.capabilities) {
      expect(entry).not.toHaveProperty('invoke');
      expect(entry).not.toHaveProperty('input');
      expect(entry.inputSchema).toBeTypeOf('object');
    }
    const get = catalog.capabilities.find((c) => c.id === 'config.get');
    expect(get?.tier).toBe('observe');
    expect(get?.surfaces.mcp).toEqual(configGet.surfaces.mcp);
  });

  it('carries the declared permission area on every entry, null included', () => {
    // The catalog is where readers and the docs projection read an action's area
    // from (spec `agent-permissions` D2): present on every entry, `null` for an
    // area-less one, so no reader has to guess what a missing key means.
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
});

describe('catalog — content-hash version stability', () => {
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
    // Pinned: the canonical form, and so every published version, stays as it was.
    expect(computeCatalogVersion([ordered])).toBe('10c105deb46e');
  });

  it('changes when content changes', () => {
    const base = composeRegistry([configDomain], deps).catalog();
    const bumped = computeCatalogVersion([
      { ...serializeCapability(configGet), description: 'changed' },
    ]);
    expect(bumped).not.toBe(base.catalogVersion);
  });
});
