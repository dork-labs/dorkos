/**
 * The canonical spelling the audit chain hashes over (spec `audit-trail` §3.1).
 * Fixed vectors, so a change to the rules shows up as a changed string rather
 * than as every stored hash silently failing to verify.
 */
import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../canonical-json.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth, so construction order does not matter', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}'
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('drops undefined keys and keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('spells scalars as JSON.stringify does, with no whitespace', () => {
    expect(canonicalJson(['x"y', 1.5, true, null])).toBe('["x\\"y",1.5,true,null]');
  });

  it('refuses values JSON cannot carry faithfully', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    // A Date would otherwise hash as `{}`, so two different dates would collide.
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalJson(new Map())).toThrow(/plain objects/);
    expect(canonicalJson(Object.create(null) as object)).toBe('{}');
  });
});
