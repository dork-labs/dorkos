import { describe, expect, it } from 'vitest';
import type { OpenApiDocument, OperationNode, SchemaNode } from '../api-lint/document.ts';
import { listPagingItems } from '../api-lint/rules.ts';

const ok = (schema: SchemaNode) => ({ '200': { content: { 'application/json': { schema } } } });
const query = (...names: string[]) => names.map((name) => ({ name, in: 'query' }));

/** A clean operation: an id, a shared-shape 404 and a plain 200. */
function op(extra: Partial<OperationNode> = {}): OperationNode {
  return {
    operationId: `op-${Math.random()}`,
    responses: {
      ...ok({ type: 'object' }),
      '404': {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } },
      },
    },
    ...extra,
  };
}

function doc(paths: OpenApiDocument['paths'], schemas = {}): OpenApiDocument {
  return { paths, components: { schemas } };
}

describe('list-paging', () => {
  it('finds an unpaged array, an object holding an array, and a $ref one level down', () => {
    const d = doc(
      {
        '/api/a': { get: op({ responses: ok({ type: 'array' }) }) },
        '/api/b': { get: op({ responses: ok({ properties: { items: { type: 'array' } } }) }) },
        '/api/c': { get: op({ responses: ok({ $ref: '#/components/schemas/List' }) }) },
      },
      { List: { type: 'object', properties: { rows: { type: ['array', 'null'] } } } }
    );
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'], b: ['GET /api/b'], c: ['GET /api/c'] });
  });

  it('passes cursor + limit + nextCursor, and never judges an item GET or a non-list', () => {
    const paged = { properties: { items: { type: 'array' }, nextCursor: { type: 'string' } } };
    const d = doc({
      '/api/a': { get: op({ parameters: query('cursor', 'limit'), responses: ok(paged) }) },
      '/api/a/{id}': { get: op({ responses: ok({ type: 'array' }) }) },
      '/api/b': { get: op({ responses: ok({ type: 'object' }) }) },
    });
    expect(listPagingItems(d)).toEqual({});
  });

  it('looks one level into oneOf, anyOf and allOf for a list body and its nextCursor', () => {
    const items = { properties: { items: { type: 'array' } } };
    const paged = { allOf: [items, { properties: { nextCursor: { type: 'string' } } }] };
    const d = doc({
      '/api/a': { get: op({ responses: ok({ oneOf: [{ type: 'object' }, items] }) }) },
      '/api/b': { get: op({ responses: ok({ anyOf: [{ $ref: '#/components/schemas/L' }] }) }) },
      '/api/c': { get: op({ parameters: query('cursor', 'limit'), responses: ok(paged) }) },
    });
    d.components = { schemas: { L: { type: 'array' } } };
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'], b: ['GET /api/b'] });
  });

  it('fails a list that takes cursor and limit but returns no nextCursor', () => {
    const d = doc({
      '/api/a': {
        get: op({ parameters: query('cursor', 'limit'), responses: ok({ type: 'array' }) }),
      },
    });
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'] });
  });

  const obj = { type: 'object', properties: { name: { type: 'string' } } };
  const strings = { type: 'array', items: { type: 'string' } };

  it('counts a top-level array, a wrapped array of objects, and a paged wrapper only when unpaged', () => {
    const agents = { properties: { agents: { type: 'array', items: obj }, nextCursor: {} } };
    const d = doc(
      {
        '/api/a': { get: op({ responses: ok({ type: 'array', items: obj }) }) },
        '/api/b': {
          get: op({ responses: ok({ properties: { items: { type: 'array', items: obj } } }) }),
        },
        '/api/c': { get: op({ responses: ok({ $ref: '#/components/schemas/Agents' }) }) },
        '/api/d': { get: op({ parameters: query('cursor', 'limit'), responses: ok(agents) }) },
      },
      {
        Agents: {
          properties: {
            agents: { type: 'array', items: { $ref: '#/components/schemas/O' } },
            total: { type: 'integer' },
          },
        },
        O: obj,
      }
    );
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'], b: ['GET /api/b'], c: ['GET /api/c'] });
  });

  it('never counts a manifest of scalar arrays, or an object with an id beside an array of objects', () => {
    const tags = { type: 'array', items: { enum: ['a', 'b'] } };
    const manifest = { properties: { name: { type: 'string' }, capabilities: strings, tags } };
    const agent = {
      properties: { id: { type: 'string' }, mcpServers: { type: 'array', items: obj } },
    };
    const d = doc({
      '/api/agents/current': { get: op({ responses: ok(manifest) }) },
      '/api/agents/self': { get: op({ responses: ok(agent) }) },
    });
    expect(listPagingItems(d)).toEqual({});
  });

  it('counts a body of only plain-value arrays: paths and ids grow without bound', () => {
    const d = doc({
      '/api/files': { get: op({ responses: ok({ properties: { files: strings } }) }) },
    });
    expect(listPagingItems(d)).toEqual({ files: ['GET /api/files'] });
  });

  it('ignores the id on a sub-collection, where it names the parent', () => {
    const members = {
      properties: { id: { type: 'string' }, members: { type: 'array', items: obj } },
    };
    const d = doc({ '/api/rooms/{id}/members': { get: op({ responses: ok(members) }) } });
    expect(listPagingItems(d)).toEqual({ rooms: ['GET /api/rooms/{id}/members'] });
  });

  it('reads array items that are a $ref to an enum as plain values', () => {
    const levels = { type: 'array', items: { $ref: '#/components/schemas/Level' } };
    const body = { properties: { name: { type: 'string' }, levels } };
    const d = doc(
      { '/api/agents/current': { get: op({ responses: ok(body) }) } },
      { Level: { type: 'string', enum: ['low', 'high'] } }
    );
    expect(listPagingItems(d)).toEqual({});
  });
});
