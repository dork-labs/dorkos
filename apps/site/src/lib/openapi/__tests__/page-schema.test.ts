import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GeneratedPageProps } from 'fumadocs-openapi';
import type { OpenAPIPageProps_Preloaded } from 'fumadocs-openapi/server';
import { projectOpenAPIPage } from '../page-schema';

type Preloaded = OpenAPIPageProps_Preloaded['preloaded'];

function project(document: Record<string, unknown>, page: Partial<GeneratedPageProps> = {}) {
  const preloaded = { docs: { schema: document }, proxyUrl: '/api/proxy' } as unknown as Preloaded;
  return projectOpenAPIPage(preloaded, {
    document: 'schema',
    operations: [{ path: '/items', method: 'post' }],
    ...page,
  });
}

function fixture() {
  return {
    openapi: '3.1.0',
    info: { title: 'API', version: '1' },
    servers: [{ url: 'https://example.test' }],
    security: [{ oauth: ['read'] }],
    tags: [{ name: 'items', description: 'Items' }],
    'x-root': { kept: true },
    paths: {
      '/items': {
        summary: 'Inherited summary',
        description: 'Inherited description',
        servers: [{ url: 'https://path.test' }],
        'x-path': { kept: true },
        parameters: [{ $ref: '#/components/parameters/tenant' }],
        post: {
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/A' } },
              },
            },
          },
        },
        delete: { responses: { '204': { description: 'Deleted' } } },
      },
      '/unrelated': { get: { responses: { '200': { description: 'Other' } } } },
      'x-container': { kept: true },
    },
    components: {
      schemas: {
        A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
        Unused: { description: 'x'.repeat(100_000) },
      },
      parameters: { tenant: { name: 'tenant', in: 'header', schema: { type: 'string' } } },
      securitySchemes: {
        oauth: {
          type: 'oauth2',
          flows: {
            clientCredentials: { tokenUrl: 'https://auth.test', scopes: { read: 'Read' } },
          },
        },
      },
    },
  };
}

describe('projectOpenAPIPage', () => {
  it('keeps recursive ref closure, root security and path inheritance without unrelated payload', () => {
    const original = fixture();
    const before = JSON.stringify(original);
    const result = project(original);
    expect(result.proxyUrl).toBe('/api/proxy');
    expect(result.docs.schema).toEqual({
      ...original,
      paths: {
        '/items': {
          summary: original.paths['/items'].summary,
          description: original.paths['/items'].description,
          servers: original.paths['/items'].servers,
          'x-path': original.paths['/items']['x-path'],
          parameters: original.paths['/items'].parameters,
          post: original.paths['/items'].post,
        },
        'x-container': original.paths['x-container'],
      },
      components: {
        schemas: { A: original.components.schemas.A, B: original.components.schemas.B },
        parameters: original.components.parameters,
        securitySchemes: original.components.securitySchemes,
      },
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(result).length).toBeLessThan(before.length / 10);
  });

  it('unions selected methods and preserves operation security and server overrides', () => {
    const original = fixture();
    const post = {
      ...original.paths['/items'].post,
      security: [],
      servers: [{ url: 'https://op.test' }],
    };
    original.paths['/items'].post = post;
    const result = project(original, {
      operations: [
        { path: '/items', method: 'post' },
        { path: '/items', method: 'delete' },
      ],
    });
    expect(result.docs.schema.paths?.['/items']).toEqual(original.paths['/items']);
  });

  it('keeps escaped and nested component pointers and discriminator mapping closure', () => {
    const original = {
      openapi: '3.1.0',
      info: { title: 'API', version: '1' },
      paths: {
        '/items': { post: { responses: { '200': { $ref: '#/components/responses/a~1b~0c' } } } },
      },
      components: {
        responses: {
          'a/b~c': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Union/properties/item' },
              },
            },
          },
        },
        schemas: {
          Union: {
            properties: {
              item: {
                discriminator: {
                  propertyName: 'kind',
                  mapping: {
                    cat: '#/components/schemas/Cat',
                  },
                },
              },
            },
          },
          Cat: { type: 'object' },
          Unused: { type: 'string' },
        },
      },
    };
    expect(project(original).docs.schema.components).toEqual({
      responses: original.components.responses,
      schemas: { Union: original.components.schemas.Union, Cat: original.components.schemas.Cat },
    });
  });

  it('keeps internal operationRef target path metadata and transitive schemas', () => {
    const original = fixture();
    const target = {
      description: 'Target path',
      get: {
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/B' } } },
          },
        },
      },
    };
    const document = {
      ...original,
      paths: {
        ...original.paths,
        '/target': target,
        '/items': {
          post: {
            responses: {
              '200': {
                description: 'OK',
                links: {
                  next: { operationRef: '#/paths/~1target/get' },
                },
              },
            },
          },
        },
      },
    };
    expect(project(document).docs.schema.paths?.['/target']).toEqual(target);
    expect(project(document).docs.schema.components?.schemas).toEqual({
      A: original.components.schemas.A,
      B: original.components.schemas.B,
    });
  });

  it('retains referenced path items and selected webhook inheritance', () => {
    const original = fixture();
    const document = {
      ...original,
      paths: { ...original.paths, '/alias': { $ref: '#/paths/~1items' } },
      webhooks: {
        changed: {
          summary: 'Hook',
          parameters: original.paths['/items'].parameters,
          post: original.paths['/items'].post,
          delete: original.paths['/items'].delete,
        },
      },
    };
    const result = project(document, {
      operations: [{ path: '/alias', method: 'post' }],
      webhooks: [{ name: 'changed', method: 'post' }],
    });
    expect(result.docs.schema.paths?.['/items']).toEqual(original.paths['/items']);
    expect(result.docs.schema.webhooks?.changed).toEqual({
      summary: 'Hook',
      parameters: original.paths['/items'].parameters,
      post: original.paths['/items'].post,
    });
  });

  it('preserves own webhook metadata when its name matches an inherited object property', () => {
    const hook = {
      summary: 'Own hook',
      description: 'Inherited by operation',
      servers: [{ url: 'https://hook.test' }],
      post: { responses: { '200': { description: 'OK' } } },
    };
    const document = {
      openapi: '3.1.0',
      info: { title: 'API', version: '1' },
      webhooks: { ['__proto__']: hook },
    };
    const result = project(document, {
      operations: [],
      webhooks: [{ name: '__proto__', method: 'post' }],
    });
    expect(Object.hasOwn(result.docs.schema.webhooks ?? {}, '__proto__')).toBe(true);
    expect(result.docs.schema.webhooks?.['__proto__']).toEqual(hook);
    expect(Object.getPrototypeOf(result.docs.schema.webhooks)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'summary')).toBe(false);
  });

  it('preserves external references without loading or rewriting them', () => {
    const document = {
      openapi: '3.1.0',
      info: { title: 'API', version: '1' },
      paths: {
        '/items': {
          post: { responses: { '200': { $ref: 'https://external.test/schema.json#/response' } } },
        },
      },
    };
    expect(project(document).docs.schema.paths).toEqual(document.paths);
  });

  it.each(['#node', '#', '#/missing', '#/bad~2pointer', '#%ZZ'])(
    'preserves full context for %s',
    (ref) => {
      const original = fixture();
      const document = {
        ...original,
        paths: { ...original.paths, '/items': { post: { responses: { '200': { $ref: ref } } } } },
      };
      expect(project(document).docs.schema).toBe(document);
    }
  );

  it('preserves full context for schema IDs and implicit discriminator names', () => {
    const document = fixture();
    for (const schema of [
      { $id: 'https://schema.test', type: 'object' },
      { discriminator: { propertyName: 'kind', mapping: { cat: 'Cat' } } },
    ]) {
      const input = {
        ...document,
        components: {
          ...document.components,
          schemas: { ...document.components.schemas, A: schema },
        },
      };
      expect(project(input).docs.schema).toBe(input);
    }
  });

  it('reduces a genuine generated Doc operation without mutating the full raw specification', () => {
    const rawPath = resolve(import.meta.dirname, '../../../../../../docs/api/openapi.json');
    const raw = readFileSync(rawPath, 'utf8');
    const original = JSON.parse(raw) as Record<string, unknown>;
    const result = project(original, {
      operations: [{ path: '/api/canvas/docs/{id}/events', method: 'post' }],
    });
    expect(Object.keys(result.docs.schema.paths ?? {})).toEqual(['/api/canvas/docs/{id}/events']);
    expect(JSON.stringify(result.docs.schema).length).toBeLessThan(raw.length / 10);
    expect(readFileSync(rawPath, 'utf8')).toBe(raw);
    expect(JSON.parse(JSON.stringify(original))).toEqual(JSON.parse(raw));
  });
});
