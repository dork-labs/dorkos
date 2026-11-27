import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { generateOpenAPISpec } from '../../openapi-registry.js';
import { fixNullableRefs } from '../nullable-refs.js';

extendZodWithOpenApi(z);

/** A document where a registered enum and object are each used once plain and once `.nullable()`. */
function generated() {
  const registry = new OpenAPIRegistry();
  const State = registry.register('State', z.enum(['blocked', 'ask', 'allowed']));
  const Ref = registry.register('Ref', z.object({ id: z.string() }));
  registry.register(
    'Body',
    z.object({
      plain: State,
      state: State.nullable(),
      areas: z.record(z.string(), State.nullable()),
      ref: Ref.nullable(),
      described: State.nullable().openapi({ description: 'Reset with null.', default: null }),
    })
  );
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 't', version: '0' },
  });
}

describe('fixNullableRefs', () => {
  it('turns every nullable $ref into anyOf [ref, null], which lets null through', () => {
    const document = generated();
    fixNullableRefs(document);
    const body = document.components?.schemas?.Body as { properties: Record<string, unknown> };
    const nullableState = { anyOf: [{ $ref: '#/components/schemas/State' }, { type: 'null' }] };
    expect(body.properties.plain).toEqual({ $ref: '#/components/schemas/State' });
    expect(body.properties.state).toEqual(nullableState);
    expect(body.properties.areas).toEqual({ type: 'object', additionalProperties: nullableState });
    expect(body.properties.ref).toEqual({
      anyOf: [{ $ref: '#/components/schemas/Ref' }, { type: 'null' }],
    });
    // Metadata the library put on the null part moves up beside the anyOf.
    expect(body.properties.described).toEqual({
      ...nullableState,
      description: 'Reset with null.',
      default: null,
    });
  });

  it('leaves no allOf part whose type admits null in the real API document', () => {
    const offenders: string[] = [];
    const visit = (value: unknown, at: string): void => {
      if (Array.isArray(value)) return value.forEach((item, i) => visit(item, `${at}/${i}`));
      if (typeof value !== 'object' || value === null) return;
      const node = value as Record<string, unknown>;
      if (Array.isArray(node.allOf)) {
        for (const part of node.allOf as Array<{ type?: unknown }>) {
          if (Array.isArray(part?.type) && part.type.includes('null')) offenders.push(at);
        }
      }
      for (const [key, child] of Object.entries(node)) visit(child, `${at}/${key}`);
    };
    visit(generateOpenAPISpec(), '');
    expect(offenders).toEqual([]);
  });

  it('leaves an allOf alone when its type is not the referenced schema type plus null', () => {
    const narrowing = {
      allOf: [{ $ref: '#/components/schemas/State' }, { type: ['number', 'null'] }],
    };
    const document = {
      components: { schemas: { State: { type: 'string', enum: ['a'] }, Body: narrowing } },
    };
    fixNullableRefs(document);
    expect(document.components.schemas.Body).toBe(narrowing);
  });
});
