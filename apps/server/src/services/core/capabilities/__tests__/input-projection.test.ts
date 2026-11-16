import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { noopLogger } from '@dorkos/shared/logger';
import { defineCapability, composeRegistry } from '../index.js';
import { capabilityInputObject } from '../input-projection.js';
import { capabilityInputShape, capabilityMcpInputObject } from '../mcp-projection.js';
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

describe('full ordinary MCP input object', () => {
  const project = capabilityMcpInputObject;

  it.each(['extra', 'ownerId'])(
    'refuses top-level %s while preserving nested maps',
    async (key) => {
      const { capability, registry, handler } = fixture();
      const input = z.object({
        values: z.record(z.string(), z.unknown()),
        limit: z.coerce.number().default(5),
      });
      const subject = { ...capability, input };
      const projected = project(subject);
      const valid = { values: { ownerId: 'nested data', extra: { enabled: true } }, limit: '3' };
      expect(projected.parse(valid)).toEqual({ ...valid, limit: 3 });
      expect(projected.safeParse({ ...valid, [key]: 'untrusted' }).success).toBe(false);
      expect(projected.parse({ values: {} })).toEqual({ values: {}, limit: 5 });
      expect(projected).not.toBe(input);
      expect(subject.input).toBe(input);
      expect(input.safeParse({ ...valid, [key]: 'untrusted' }).success).toBe(true);
      // Original executable preprocessors remain authoritative, independent of projection.
      await registry.invoke('demo.bounded', { text: 'hello' });
      await expect(registry.invoke('demo.bounded', { text: 'x'.repeat(50) })).rejects.toThrow(
        'Envelope too large'
      );
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        { text: 'hello', limit: 5 },
        expect.anything()
      );
    }
  );

  it('keeps object refinements when adding an eligible approval token without changing the original', () => {
    const { capability } = fixture();
    const input = z
      .object({ start: z.number(), end: z.number().default(5) })
      .refine(({ start, end }) => start < end, 'Start must precede end');
    const subject = { ...capability, tier: 'destructive' as const, input };
    const projected = project(subject);
    expect(Object.keys(projected.shape)).toEqual(['start', 'end', 'approvalToken']);
    expect(projected.parse({ start: 1, approvalToken: 'granted' })).toEqual({
      start: 1,
      end: 5,
      approvalToken: 'granted',
    });
    const refused = projected.safeParse({ start: 6, approvalToken: 'granted' });
    expect(refused.success).toBe(false);
    if (!refused.success)
      expect(refused.error.issues).toEqual([
        expect.objectContaining({ message: 'Start must precede end' }),
      ]);
    expect(Object.keys(input.shape)).toEqual(['start', 'end']);
    expect(input.parse({ start: 1 })).toEqual({ start: 1, end: 5 });
    expect(input.safeParse({ start: 6 }).success).toBe(false);
  });

  it('advertises approval tokens for exactly the existing ordinary eligibility rules', () => {
    const { capability } = fixture();
    const cases = [
      { tier: 'observe', area: null, expected: false },
      { tier: 'act', area: null, expected: false },
      { tier: 'act', area: 'tasks', expected: true },
      { tier: 'destructive', area: null, expected: true },
      { tier: 'observe', area: null, forwardsApproval: true, expected: true },
    ] as const;
    expect(cases).toHaveLength(5);
    for (const { expected, ...policy } of cases) {
      const projected = project({ ...capability, ...policy });
      expect('approvalToken' in projected.shape).toBe(expected);
      expect(projected.safeParse({ text: 'hello' }).success).toBe(true);
      expect(projected.safeParse({ text: 'hello', approvalToken: 'token' }).success).toBe(expected);
    }
  });
});
