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
  input: z.object({}),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'demo_ping', servers: ['external'] } },
  invoke: async () => ({}),
});

const demoDomain: CapabilityDomain = {
  name: 'demo',
  capabilities: [listThings, createThing, mcpOnly],
};

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
    // `demo.ping` has no http surface, so no extra path appears.
    expect(Object.keys(spec.paths ?? {})).toEqual(['/api/demo/things']);
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
