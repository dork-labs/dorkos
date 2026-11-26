import { describe, expect, it } from 'vitest';
import { CompiledCanvasAppManifest, parseCanvasAppManifest } from '../canvas-app-manifest.js';

const manifest = (
  schema: unknown = {
    type: 'object',
    properties: { checked: { type: 'boolean' } },
    required: ['checked'],
    additionalProperties: false,
  }
) => ({ v: 1, types: { 'task.toggled': schema } });

describe('bounded local app manifest grammar', () => {
  it('validates exact declared payloads without changing data', () => {
    const app = new CompiledCanvasAppManifest(manifest());
    const payload = { checked: true };
    expect(app.validate('task.toggled', payload)).toBe('valid');
    expect(payload).toEqual({ checked: true });
    expect(app.validate('task.toggled', { checked: 'true' })).toBe('invalid');
    expect(app.validate('task.toggled', { checked: true, extra: 1 })).toBe('invalid');
    expect(app.validate('task.other', payload)).toBe('undeclared');
    expect(app.validate('tasking.toggled', payload)).toBe('undeclared');
  });
  it.each([
    '$ref',
    '$id',
    '$schema',
    'pattern',
    'patternProperties',
    'format',
    'allOf',
    'anyOf',
    'oneOf',
    'not',
    'if',
    'then',
    'else',
    'uniqueItems',
    'contains',
    'default',
  ])('refuses unsupported %s before Ajv compilation', (keyword) => {
    expect(
      () => new CompiledCanvasAppManifest(manifest({ [keyword]: 'https://example.invalid/schema' }))
    ).toThrow();
  });
  it('accepts scalar, enum, const, array and property limits from the allowed subset', () => {
    const app = new CompiledCanvasAppManifest(
      manifest({
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'string', minLength: 1, maxLength: 3, enum: ['yes', 'no'] },
      })
    );
    expect(app.validate('task.toggled', ['yes'])).toBe('valid');
    expect(app.validate('task.toggled', ['maybe'])).toBe('invalid');
    expect(new CompiledCanvasAppManifest(manifest({ const: 1 })).validate('task.toggled', 2)).toBe(
      'invalid'
    );
    expect(
      new CompiledCanvasAppManifest(
        manifest({ type: 'number', minimum: 0, exclusiveMaximum: 3 })
      ).validate('task.toggled', 2)
    ).toBe('valid');
  });
  it('bounds total schema nodes and exact event types', () => {
    const wide = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 128 }, (_, i) => [`p${i}`, { type: 'string' }])
      ),
    };
    expect(() =>
      parseCanvasAppManifest({
        v: 1,
        types: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`app.t${i}`, wide])),
      })
    ).toThrow(/work limit/);
    expect(() =>
      parseCanvasAppManifest({
        v: 1,
        types: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`app.t${i}`, true])),
      })
    ).toThrow();
    expect(() => parseCanvasAppManifest({ v: 1, types: { 'task.*': true } })).toThrow();
  });
  it('accepts depth sixteen and refuses the next schema level', () => {
    let schema: unknown = { type: 'string' };
    for (let depth = 0; depth < 16; depth++) schema = { items: schema };
    expect(() => parseCanvasAppManifest(manifest(schema))).not.toThrow();
    expect(() => parseCanvasAppManifest(manifest({ items: schema }))).toThrow(/work limit/);
  });
  it('refuses unsafe keys, huge UTF-8 content, nonfinite numbers and invalid length bounds', () => {
    expect(() =>
      parseCanvasAppManifest(
        JSON.parse('{"v":1,"types":{"app.x":{"properties":{"__proto__":true}}}}')
      )
    ).toThrow();
    expect(() => parseCanvasAppManifest(manifest({ const: '☃'.repeat(23000) }))).toThrow();
    expect(() => parseCanvasAppManifest(manifest({ maximum: Infinity }))).toThrow();
    expect(() => parseCanvasAppManifest(manifest({ maxLength: 0.5 }))).toThrow();
    expect(() => parseCanvasAppManifest(manifest({ enum: Array(129).fill('x') }))).toThrow();
  });
  it('allows only narrower platform limits and never routing or grant fields', () => {
    expect(
      parseCanvasAppManifest({
        ...manifest(),
        limits: { envelopeBytes: 1024, eventsPerMinute: 2, turnsPerHour: 1 },
      }).limits
    ).toEqual({ envelopeBytes: 1024, eventsPerMinute: 2, turnsPerHour: 1 });
    expect(() =>
      parseCanvasAppManifest({ ...manifest(), limits: { eventsPerMinute: 61 } })
    ).toThrow();
    expect(() => parseCanvasAppManifest({ ...manifest(), routes: [] })).toThrow();
    expect(() => parseCanvasAppManifest({ ...manifest(), grants: [] })).toThrow();
  });
  it('uses canonical key ordering and rejects semantically invalid Draft-07 schema', () => {
    expect(
      new CompiledCanvasAppManifest(manifest({ type: 'string', maxLength: 3 })).canonicalJson
    ).toEqual(
      new CompiledCanvasAppManifest(manifest({ maxLength: 3, type: 'string' })).canonicalJson
    );
    expect(() => new CompiledCanvasAppManifest(manifest({ enum: [1, 1] }))).toThrow();
  });
});

it('isolates cached compiled authority from caller mutation', () => {
  const input = {
    v: 1,
    types: { 'app.changed': { type: 'boolean' } },
    limits: { eventsPerMinute: 2 },
  };
  const compiled = new CompiledCanvasAppManifest(input);
  input.limits.eventsPerMinute = 60;
  input.types['app.changed'].type = 'string';
  expect(compiled.manifest.limits?.eventsPerMinute).toBe(2);
  expect(compiled.validate('app.changed', true)).toBe('valid');
  expect(Object.isFrozen(compiled.manifest.types['app.changed'])).toBe(true);
});
