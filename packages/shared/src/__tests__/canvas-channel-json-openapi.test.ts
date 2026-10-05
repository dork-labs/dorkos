import { describe, expect, it } from 'vitest';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { CanvasChannelJsonValueSchema, CanvasChannelStateSchema } from '../canvas-channel-json.js';

describe('recursive document JSON OpenAPI projection', () => {
  it('uses a named recursive reference without weakening runtime JSON preflight', () => {
    const registry = new OpenAPIRegistry();
    registry.register('DocEventPayload', CanvasChannelJsonValueSchema);
    registry.register('DocLiveState', CanvasChannelStateSchema);
    const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 'Document JSON', version: 'test' },
    });
    expect(document.components?.schemas).toHaveProperty('CanvasChannelJson');
    const encoded = JSON.stringify(document.components?.schemas);
    expect(encoded).toContain('"$ref":"#/components/schemas/CanvasChannelJson"');
    expect(
      CanvasChannelJsonValueSchema.parse({ nested: [null, { value: 'actual JSON' }] })
    ).toEqual({ nested: [null, { value: 'actual JSON' }] });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(CanvasChannelJsonValueSchema.safeParse(cycle).success).toBe(false);
    expect(CanvasChannelStateSchema.safeParse({ value: Infinity }).success).toBe(false);
    const getter = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('Must not invoke raw accessor');
      },
    });
    expect(CanvasChannelStateSchema.safeParse(getter).success).toBe(false);
  });
});
