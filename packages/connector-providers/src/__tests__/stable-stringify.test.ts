import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../stable-stringify.js';

describe('stableStringify', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: [3, { z: 1, y: 2 }], a: null })).toBe(
      '{"a":null,"b":[3,{"y":2,"z":1}]}'
    );
  });

  it('keeps the canonical form of a catalog-shaped value unchanged', () => {
    const fixture = {
      surfaces: { mcp: { servers: ['external'], toolName: 't' } },
      outputSchema: { type: 'object' },
      inputSchema: {
        properties: { b: { type: 'number' }, a: { type: 'string' } },
        type: 'object',
      },
      tier: 'observe',
      area: null,
      description: 'D',
      title: 'T',
      id: 'x.y',
    };
    const text = stableStringify([fixture]);
    expect(text).toBe(
      '[{"area":null,"description":"D","id":"x.y","inputSchema":{"properties":{"a":{"type":"string"},' +
        '"b":{"type":"number"}},"type":"object"},"outputSchema":{"type":"object"},' +
        '"surfaces":{"mcp":{"servers":["external"],"toolName":"t"}},"tier":"observe","title":"T"}]'
    );
    expect(createHash('sha256').update(text).digest('hex').slice(0, 12)).toBe('10c105deb46e');
  });

  it('keeps every own key in the canonical copy', () => {
    const withKey = JSON.parse('{"__proto__":{"x":1},"a":1}');
    expect(stableStringify(withKey)).toBe('{"__proto__":{"x":1},"a":1}');
    expect(stableStringify(withKey)).not.toBe(stableStringify({ a: 1 }));

    const nested = JSON.parse('{"outer":[{"__proto__":{"x":1}}]}');
    expect(stableStringify(nested)).toBe('{"outer":[{"__proto__":{"x":1}}]}');
  });

  it('changes nothing outside the value it canonicalizes', () => {
    const input = JSON.parse('{"__proto__":{"extra":true},"a":1}');
    stableStringify(input);
    expect(({} as Record<string, unknown>).extra).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).extra).toBeUndefined();
  });
});
