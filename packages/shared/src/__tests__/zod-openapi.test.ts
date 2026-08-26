/**
 * Guards the leak repair in `zod-openapi.ts` — see that module for why it
 * exists. These tests are the reason an upgrade of
 * `@asteasolutions/zod-to-openapi` cannot quietly reintroduce DOR-1577.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToOpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { extendZodWithOpenApiOnce } from '../zod-openapi.js';

/** The bundled registry's private schema map, whatever kind it currently is. */
function schemaMap(): Map<object, unknown> | WeakMap<object, unknown> {
  return (zodToOpenAPIRegistry as unknown as { _map: Map<object, unknown> })._map;
}

describe('extendZodWithOpenApiOnce', () => {
  it('leaves the openapi metadata registry holding schemas WEAKLY', () => {
    extendZodWithOpenApiOnce();

    // The whole point. A strong `Map` here pins every schema `.openapi()` has
    // ever been called on for the life of the process, which is what took a
    // vitest worker past V8's heap ceiling in `routes/__tests__/config.test.ts`.
    expect(schemaMap()).toBeInstanceOf(WeakMap);
    expect(schemaMap()).not.toBeInstanceOf(Map);
  });

  it('still answers metadata lookups for a schema it was given', () => {
    extendZodWithOpenApiOnce();

    const schema = z.string().openapi('ZodOpenApiGuardProbe', { description: 'probe' });

    // Weak or strong, a live schema must still resolve — the repair is only
    // sound because every reader holds the schema it asks about.
    expect(zodToOpenAPIRegistry.get(schema)).toMatchObject({
      _internal: { refId: 'ZodOpenApiGuardProbe' },
      description: 'probe',
    });
  });

  it('is idempotent, so a second call cannot drop what the first recorded', () => {
    extendZodWithOpenApiOnce();
    const schema = z.string().openapi('ZodOpenApiIdempotenceProbe');
    const before = schemaMap();

    extendZodWithOpenApiOnce();

    // Same map object, same entry. A repair that rebuilt the map on every call
    // would erase the metadata of every module that loaded before it.
    expect(schemaMap()).toBe(before);
    expect(zodToOpenAPIRegistry.get(schema)).toMatchObject({
      _internal: { refId: 'ZodOpenApiIdempotenceProbe' },
    });
  });

  it('carries pre-existing entries across the swap', () => {
    // Reproduces the ordering the server's test aliases create: something has
    // already registered metadata against a STRONG map by the time the repair
    // runs. Those entries have to survive, or a module that loaded first would
    // silently lose its `refId` and drop out of the generated OpenAPI document.
    const internals = zodToOpenAPIRegistry as unknown as {
      _map: Map<object, unknown> | WeakMap<object, unknown>;
    };
    const restore = internals._map;
    const early = z.string();
    const strong = new Map<object, unknown>([[early, { _internal: { refId: 'EarlyArrival' } }]]);
    internals._map = strong;

    try {
      extendZodWithOpenApiOnce();

      expect(internals._map).toBeInstanceOf(WeakMap);
      expect(zodToOpenAPIRegistry.get(early)).toMatchObject({
        _internal: { refId: 'EarlyArrival' },
      });
    } finally {
      internals._map = restore;
    }
  });
});
