/**
 * Which declared tool input schemas DorkOS accepts (DOR-2685, task 2.2). The
 * agreement with the server's `registry.contribute` is pinned in
 * `apps/server/src/services/extensions/agent-tools/__tests__/tool-check-agreement.test.ts`.
 *
 * The property under test: a tool accepted here is a tool the registry's
 * `contribute` accepts and every agent tool list can render, and a schema that
 * would turn into an open-ended map is refused before any extension code runs.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ExtensionManifestSchema, type ExtensionManifest } from '../manifest-schema.js';

import { checkDeclaredTools, checkToolInputSchema, plainReason } from '../tool-check.js';

/** A closed object schema around the given properties. */
function closed(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type: 'object', properties, additionalProperties: false, ...extra };
}

/** Parse a manifest declaring the given tools, failing loudly if it does not parse. */
function manifestWith(
  tools: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
): ExtensionManifest {
  return ExtensionManifestSchema.parse({
    id: 'mail-app',
    name: 'Mail',
    version: '1.0.0',
    serverCapabilities: { serverEntry: './server.ts' },
    tools,
    ...extra,
  });
}

/** An observe tool with the given input schema. */
function observeTool(name: string, inputSchema: unknown, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: `Read ${name}`,
    description: `Reads ${name}.`,
    tier: 'observe',
    inputSchema,
    ...extra,
  };
}

describe('checkToolInputSchema', () => {
  it.each([
    ['additionalProperties: true', closed({}, { additionalProperties: true }), /open-ended map/],
    [
      'additionalProperties as a schema',
      closed({}, { additionalProperties: { type: 'string' } }),
      /open-ended map/,
    ],
    ['patternProperties', closed({}, { patternProperties: { '^x': {} } }), /patternProperties/],
    ['propertyNames', closed({}, { propertyNames: { pattern: '^a' } }), /propertyNames/],
    ['$ref', closed({ a: { $ref: '#/$defs/x' } }), /\$ref is not supported/],
    ['$defs', closed({}, { $defs: { x: { type: 'string' } } }), /\$defs is not supported/],
    [
      'an unknown keyword',
      closed({ a: { type: 'string', oneOf: [] } }),
      /"oneOf", which is not supported/,
    ],
    [
      'an object without additionalProperties',
      { type: 'object', properties: {} },
      /must set "additionalProperties": false/,
    ],
    ['a root that is not an object', { type: 'string' }, /must be an object schema/],
    ['a boolean schema', closed({ a: true }), /is not a schema object/],
    [
      'a required name it does not define',
      closed({}, { required: ['toString'] }),
      /requires "toString"/,
    ],
    [
      'a reserved property name',
      closed({ constructor: { type: 'string' } }),
      /reserved property name/,
    ],
    ['an unknown type', closed({ a: { type: 'date' } }), /unknown type/],
    // An untyped node converts to "anything": an open hole in a closed schema.
    ['an untyped node', closed({ a: {} }), /must say its type/],
    ['an array with no items', closed({ a: { type: 'array' } }), /must describe its items/],
    // The converter passes a default through untouched, straight to the handler.
    [
      'a default that breaks its own schema',
      closed({ n: { type: 'integer', default: 'rm -rf /' } }),
      /default that does not fit its own schema/,
    ],
    [
      'an object default that breaks additionalProperties',
      closed({
        o: closed({ a: { type: 'string' } }, { default: { a: 'x', extra: true } }),
      }),
      /default that does not fit its own schema/,
    ],
  ])('refuses %s, naming why', (_label, schema, why) => {
    // Purpose: each construct that converts to a record (or worse), or that
    // the subset does not cover, is refused with a sentence an author can act
    // on.
    const result = checkToolInputSchema(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(why);
  });

  it('refuses an open object nested deep inside an array item', () => {
    // Purpose: the walk follows items and properties all the way down, so an
    // `additionalProperties: {}` three levels in is caught like a top-level one.
    const schema = closed({
      batches: {
        type: 'array',
        items: closed({ meta: { type: 'object', properties: {}, additionalProperties: {} } }),
      },
    });
    const result = checkToolInputSchema(schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/open-ended map/);
  });

  it('accepts the stated subset and converts it to a closed Zod object', () => {
    // Purpose: every allowed keyword together converts, renders back as closed
    // JSON Schema, and parses a call the way the declaration says.
    const schema = closed(
      {
        to: { type: 'string', format: 'email', description: 'Who it goes to' },
        subject: { type: 'string', minLength: 1, maxLength: 200, title: 'Subject' },
        priority: { enum: ['low', 'high'], default: 'low' },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' }, maxItems: 5 },
        reply: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        kind: { const: 'mail' },
        flag: { type: 'boolean' },
      },
      { required: ['to'] }
    );
    const result = checkToolInputSchema(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = JSON.stringify(z.toJSONSchema(result.zod));
    expect(rendered).not.toMatch(/propertyNames|"additionalProperties":\{/);
    expect(result.zod.safeParse({ to: 'a@b.co' }).success).toBe(true);
    expect(result.zod.safeParse({ to: 'a@b.co', extra: 1 }).success).toBe(false);
    expect(result.zod.safeParse({}).success).toBe(false);
  });
});

describe('plainReason', () => {
  it('flattens control and invisible characters and caps the length', () => {
    // Purpose: refusal sentences can carry author text; none of it may fake a
    // second line or hide characters on a card.
    const reason = plainReason(`bad\nline\u202Ehidden\u200B${'x'.repeat(500)}`);
    expect(reason).not.toMatch(/[\n\u202E\u200B]/);
    expect(reason.length).toBeLessThanOrEqual(300);
  });
});

describe('checkDeclaredTools', () => {
  it('refuses one bad tool and keeps its siblings', () => {
    // Purpose: one author mistake must not take every tool of the extension
    // down; the refusal names the tool.
    const checks = checkDeclaredTools(
      manifestWith([
        observeTool('list_inbox', closed({ limit: { type: 'integer' } })),
        observeTool('dump_headers', closed({}, { additionalProperties: { type: 'string' } })),
      ])
    );
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ['list_inbox', true],
      ['dump_headers', false],
    ]);
  });

  it('refuses at discovery what contribute would refuse later', () => {
    // Purpose: the manifest parses, but a title with a quote and an act tool
    // with no card fields break the registry's own rules. Discovery runs the
    // registry's check itself, so both are refused here, with its reasons.
    const checks = checkDeclaredTools(
      manifestWith([
        observeTool('quoted', closed({}), { title: 'Read "everything"' }),
        { ...observeTool('send', closed({ to: { type: 'string' } })), tier: 'act' },
      ])
    );
    expect(checks.every((c) => !c.ok)).toBe(true);
    expect(checks[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/no quotes/) });
    expect(checks[1]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/which fields its approval card shows/),
    });
  });

  it('refuses every tool of an extension whose name could pass for DorkOS', () => {
    // Purpose: the display name is checked by the same function, so a name the
    // registry would refuse never reaches it.
    const checks = checkDeclaredTools(
      manifestWith([observeTool('list_inbox', closed({}))], { name: 'DorkOS' })
    );
    expect(checks[0]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/may not call itself/),
    });
  });

  it('caps the timeout it hands the lifecycle', () => {
    // Purpose: whatever reached the record, the deadline the wrapper uses is
    // between 1 and 300 seconds.
    const manifest = manifestWith([observeTool('list_inbox', closed({}))]);
    manifest.tools![0]!.timeoutSeconds = 100_000;
    const [check] = checkDeclaredTools(manifest);
    expect(check).toMatchObject({ ok: true, timeoutSeconds: 300 });
  });
});
