import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import {
  defineCapability,
  composeRegistry,
  registerCapabilitiesInOpenApi,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../index.js';

const deps: CapabilityDeps = { logger: noopLogger };

/** A read capability with query-shaped input and a precise output schema. */
const listThings = defineCapability({
  id: 'demo.list',
  title: 'List things',
  description: 'List demo things, filtered by an optional prefix.',
  tier: 'observe',
  area: null,
  input: z.object({ prefix: z.string().optional() }),
  output: z.object({ items: z.array(z.string()) }),
  surfaces: { http: { method: 'get', path: '/api/demo/things' } },
  invoke: async () => ({ items: [] }),
});

/** A write capability, so its input projects as a request body, not query. */
const createThing = defineCapability({
  id: 'demo.create',
  title: 'Create thing',
  description: 'Create a demo thing.',
  tier: 'act',
  area: null,
  input: z.object({ name: z.string() }),
  output: z.unknown(),
  surfaces: { http: { method: 'post', path: '/api/demo/things' } },
  invoke: async () => ({}),
});

/** A capability with no http surface — must not project any path. */
const mcpOnly = defineCapability({
  id: 'demo.ping',
  title: 'Ping',
  description: 'MCP-only capability.',
  tier: 'observe',
  area: null,
  input: z.object({}),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_ping', servers: ['external'] } },
  invoke: async () => ({}),
});

/** A read capability whose path carries `{id}`, which its input also names. */
const getThing = defineCapability({
  id: 'demo.get',
  title: 'Get thing',
  description: 'Read one demo thing.',
  tier: 'observe',
  area: null,
  input: z.object({
    id: z.string().describe('The thing to read'),
    verbose: z.boolean().optional(),
  }),
  output: z.unknown(),
  surfaces: { http: { method: 'get', path: '/api/demo/things/{id}' } },
  invoke: async () => ({}),
});

/** A write capability whose path carries `{agentId}`, which its input also names. */
const pauseAgent = defineCapability({
  id: 'demo.pause',
  title: 'Pause agent',
  description: 'Pause a demo agent.',
  tier: 'act',
  area: null,
  input: z.object({ agentId: z.string(), reason: z.string() }),
  output: z.unknown(),
  surfaces: { http: { method: 'post', path: '/api/demo/agents/{agentId}/pause' } },
  invoke: async () => ({}),
});

/** A capability whose path carries a param its (empty) input never names. */
const resumeAgent = defineCapability({
  id: 'demo.resume',
  title: 'Resume agent',
  description: 'Resume a demo agent.',
  tier: 'act',
  area: null,
  input: z.object({}),
  output: z.unknown(),
  surfaces: { http: { method: 'post', path: '/api/demo/agents/{agentId}/resume' } },
  invoke: async () => ({}),
});

const demoDomain: CapabilityDomain = {
  name: 'demo',
  capabilities: [listThings, createThing, mcpOnly],
};

const pathDomain: CapabilityDomain = {
  name: 'demo',
  capabilities: [getThing, pauseAgent, resumeAgent],
};

/** The parameters an operation declares, as `in:name` pairs. */
function declared(operation: { parameters?: unknown[] } | undefined): string[] {
  return ((operation?.parameters ?? []) as Array<{ name: string; in: string }>).map(
    (p) => `${p.in}:${p.name}`
  );
}

/** Generate the document so projected routes are observable as paths. */
function generate(doc: OpenAPIRegistry) {
  return new OpenApiGeneratorV31(doc.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'test', version: '0' },
  });
}

describe('registerCapabilitiesInOpenApi', () => {
  it('projects one path per http surface, tagged by domain', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const spec = generate(doc);

    const paths = spec.paths ?? {};
    expect(paths['/api/demo/things']?.get).toBeDefined();
    expect(paths['/api/demo/things']?.post).toBeDefined();
    expect(paths['/api/demo/things']?.get?.tags).toEqual(['Demo']);
  });

  it('projects a read capability input as query parameters', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const spec = generate(doc);

    const params = spec.paths?.['/api/demo/things']?.get?.parameters ?? [];
    expect(params).toHaveLength(1);
    expect((params[0] as { name: string; in: string }).name).toBe('prefix');
    expect((params[0] as { name: string; in: string }).in).toBe('query');
  });

  it('projects a write capability input as a request body', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const spec = generate(doc);

    const post = spec.paths?.['/api/demo/things']?.post;
    expect(post?.requestBody).toBeDefined();
    expect(post?.parameters).toBeUndefined();
  });

  it('projects the output schema as the 200 response', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const spec = generate(doc);

    const schema =
      spec.paths?.['/api/demo/things']?.get?.responses?.['200']?.content?.['application/json']
        ?.schema;
    expect(schema).toMatchObject({ properties: { items: { type: 'array' } } });
  });

  it('skips capabilities without an http surface', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const spec = generate(doc);
    // `demo.ping` has no http surface, so no extra path appears: only the
    // generic invoke endpoint, which reaches every capability.
    expect(Object.keys(spec.paths ?? {})).toEqual([
      '/api/demo/things',
      '/api/capabilities/{id}/invoke',
    ]);
  });

  it('documents the invoke endpoint once, with every status the dispatcher answers', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const invoke = generate(doc).paths?.['/api/capabilities/{id}/invoke']?.post;
    expect(invoke?.operationId).toBe('capabilities.invoke');
    expect(Object.keys(invoke?.responses ?? {})).toEqual([
      '200',
      '202',
      '400',
      '401',
      '403',
      '404',
      '409',
      '412',
      '500',
      '502',
      '503',
    ]);
  });

  it('documents the dispatcher’s standard responses on every projected operation', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const get = generate(doc).paths?.['/api/demo/things']?.get;
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(
      ['200', '202', '400', '401', '403', '404', '409', '412', '500', '502', '503'].sort()
    );
    // Every error is a problem document, never the old `ErrorResponse`.
    expect(get?.responses?.['404']?.content?.['application/problem+json']?.schema).toEqual({
      $ref: '#/components/schemas/Problem',
    });
    expect(get?.responses?.['404']?.content?.['application/json']).toBeUndefined();
  });

  it('reads a renamed path segment, a POST’s query fields and the success status from the surface', () => {
    const write = defineCapability({
      id: 'demo.tag',
      title: 'Tag thing',
      description: 'Tag a demo thing.',
      tier: 'act',
      area: null,
      input: z.object({ thingId: z.string(), dryRun: z.boolean().optional(), tag: z.string() }),
      output: z.object({ ok: z.boolean() }),
      surfaces: {
        http: {
          method: 'post',
          path: '/api/demo/things/{id}/tags',
          params: { id: 'thingId' },
          query: ['dryRun'],
          success: 201,
        },
      },
      invoke: async () => ({ ok: true }),
    });
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(
      composeRegistry([{ name: 'demo', capabilities: [write] }], deps),
      doc
    );
    const post = generate(doc).paths?.['/api/demo/things/{id}/tags']?.post;
    expect(declared(post)).toEqual(['path:id', 'query:dryRun']);
    const body = post?.requestBody as { content: Record<string, { schema: object }> } | undefined;
    expect(Object.keys(body?.content['application/json']?.schema ?? {})).toContain('properties');
    expect(body?.content['application/json']?.schema).toMatchObject({
      properties: { tag: { type: 'string' } },
    });
    expect(
      Object.keys((body?.content['application/json']?.schema as { properties: object }).properties)
    ).toEqual(['tag']);
    expect(Object.keys(post?.responses ?? {})).toContain('201');
    expect(Object.keys(post?.responses ?? {})).not.toContain('200');
  });

  it('throws when a capability path collides with a hand-registered one', () => {
    const doc = new OpenAPIRegistry();
    // Hand-register the same method+path the capability would project.
    doc.registerPath({
      method: 'get',
      path: '/api/demo/things',
      responses: { 200: { description: 'hand-registered' } },
    });

    expect(() => registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc)).toThrow(
      /already.*hand-registered/i
    );
  });

  it('names each projected operation by its capability id', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc);
    const paths = generate(doc).paths ?? {};

    expect(paths['/api/demo/things']?.get?.operationId).toBe('demo.list');
    expect(paths['/api/demo/things']?.post?.operationId).toBe('demo.create');
  });

  it('declares a read path segment as a path parameter, not a query parameter', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([pathDomain], deps), doc);
    const get = generate(doc).paths?.['/api/demo/things/{id}']?.get;

    expect(declared(get).sort()).toEqual(['path:id', 'query:verbose']);
    const id = (
      get?.parameters as Array<{ name: string; required?: boolean; description?: string }>
    ).find((p) => p.name === 'id');
    // The field's own description rides along, and a path segment is required.
    expect(id).toMatchObject({ required: true, description: 'The thing to read' });
  });

  it('declares a write path segment as a path parameter and leaves it out of the body', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([pathDomain], deps), doc);
    const post = generate(doc).paths?.['/api/demo/agents/{agentId}/pause']?.post;

    expect(declared(post)).toEqual(['path:agentId']);
    const body = JSON.stringify(post?.requestBody);
    expect(body).toContain('reason');
    expect(body).not.toContain('agentId');
  });

  it('declares a path segment the input never names as a plain string', () => {
    const doc = new OpenAPIRegistry();
    registerCapabilitiesInOpenApi(composeRegistry([pathDomain], deps), doc);
    const post = generate(doc).paths?.['/api/demo/agents/{agentId}/resume']?.post;

    expect(post?.parameters).toEqual([
      expect.objectContaining({ name: 'agentId', in: 'path', schema: { type: 'string' } }),
    ]);
    expect(post?.requestBody).toBeUndefined();
  });

  it('does not collide when method differs on the same path', () => {
    const doc = new OpenAPIRegistry();
    doc.registerPath({
      method: 'delete',
      path: '/api/demo/things',
      responses: { 204: { description: 'hand-registered delete' } },
    });
    expect(() =>
      registerCapabilitiesInOpenApi(composeRegistry([demoDomain], deps), doc)
    ).not.toThrow();
  });
});
