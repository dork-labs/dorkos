import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { noopLogger } from '@dorkos/shared/logger';
import { defineCapability, composeRegistry } from '../index.js';
import { capabilityInputObject } from '../input-projection.js';
import { capabilityInputShape } from '../mcp-projection.js';
import { registerCapabilitiesInOpenApi } from '../openapi-projection.js';

function fixture(method: 'get' | 'post' = 'post') {
  const handler = vi.fn(async () => ({}));
  const input = z.preprocess(
    (raw, context) => {
      if (JSON.stringify(raw).length > 40) {
        context.addIssue({ code: 'custom', message: 'Envelope too large' });
        return z.NEVER;
      }
      return raw;
    },
    z.preprocess(
      (raw) => raw,
      z.object({ text: z.string(), limit: z.number().default(5) }).strict()
    )
  );
  const capability = defineCapability({
    id: 'demo.bounded',
    title: 'Bounded input',
    description: 'Bounded input projection.',
    tier: 'observe',
    area: null,
    input,
    output: z.object({}),
    surfaces: {
      mcp: { toolName: 'demo_bounded', servers: ['external'] },
      http: { method, path: '/api/demo/bounded' },
    },
    invoke: handler,
  });
  return {
    capability,
    handler,
    registry: composeRegistry([{ name: 'demo', capabilities: [capability] }], {
      logger: noopLogger,
    }),
  };
}

describe('preprocessed capability input projection', () => {
  it('advertises nested pipe output fields and portable defaults while execution retains the full bound', async () => {
    const { capability, registry, handler } = fixture();
    expect(Object.keys(capabilityInputObject(capability).shape)).toEqual(['text', 'limit']);
    const projected = z.object(capabilityInputShape(capability));
    expect(projected.parse({ text: 'hello' })).toEqual({ text: 'hello' });
    await registry.invoke('demo.bounded', { text: 'hello' });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'hello', limit: 5 })])
    );
    await expect(registry.invoke('demo.bounded', { text: 'x'.repeat(50) })).rejects.toThrow();
    await expect(
      registry.invoke('demo.bounded', { text: 'hello', authority: true })
    ).rejects.toThrow();
    expect(handler).toHaveBeenCalledOnce();
  });
  it.each(['get', 'post'] as const)(
    'projects a piped %s input into OpenAPI without losing the object fields',
    (method) => {
      const { registry } = fixture(method);
      const doc = new OpenAPIRegistry();
      registerCapabilitiesInOpenApi(registry, doc);
      const spec = new OpenApiGeneratorV31(doc.definitions).generateDocument({
        openapi: '3.1.0',
        info: { title: 'test', version: '0' },
      });
      const operation = spec.paths!['/api/demo/bounded']![method]!;
      if (method === 'get')
        expect(operation.parameters).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: 'text', required: true })])
        );
      else
        expect(operation.requestBody).toMatchObject({
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { text: { type: 'string' }, limit: { default: 5 } },
                required: ['text'],
              },
            },
          },
        });
    }
  );
  it('fails explicitly when pipe output is not an object', () => {
    const { capability } = fixture();
    expect(() =>
      capabilityInputObject({ ...capability, input: z.preprocess((raw) => raw, z.string()) })
    ).toThrow('demo.bounded');
  });
});
