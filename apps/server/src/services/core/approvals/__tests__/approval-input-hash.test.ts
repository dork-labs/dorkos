/**
 * Tests for the approval binding hash (spec `agent-trust` §3.3).
 *
 * The reproduced defect: `stableStringify` canonicalizes by rebuilding objects from
 * `Object.keys()`, which destroys `toJSON` and sees nothing at all inside a `Set` or
 * `Map`. So `{ at: new Date(0) }` and `{ at: new Date(9e11) }` used to produce the
 * SAME digest, as did `{ s: new Set(['a']) }` and `{ s: new Set(['b']) }` — a field
 * that looks bound while being completely ignored. Nothing caught it: the
 * conformance suite's parse-idempotence check is stable over a `Date`.
 *
 * These cases pin the guard AND the pairs that used to collide, so a future
 * "normalize instead of reject" change has to keep them distinct or fail here.
 * (Note that `JSON.parse(JSON.stringify(x))` would fix the Date pair and NOT the
 * Set pair, which is why this rejects rather than normalizes.)
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  assertBindableInput,
  hashApprovalInput,
  ApprovalInputNotBindableError,
} from '../approval-input-hash.js';

describe('hashApprovalInput', () => {
  it('hashes plain JSON regardless of key order', () => {
    expect(hashApprovalInput({ a: 1, b: 2 })).toBe(hashApprovalInput({ b: 2, a: 1 }));
  });

  it('binds absence as absence, not as a substituted default', () => {
    expect(hashApprovalInput({ name: 'x' })).not.toBe(
      hashApprovalInput({ name: 'x', purge: false })
    );
  });

  it('normalizes a missing input to null so an argument-free capability still binds', () => {
    expect(hashApprovalInput(undefined)).toBe(hashApprovalInput(null));
  });

  it('accepts nested plain objects and arrays', () => {
    expect(() => hashApprovalInput({ a: [1, 'two', true, null, { b: {} }] })).not.toThrow();
  });

  describe('rejects anything that would lose information on the way into the digest', () => {
    it('a Date — two different instants used to hash identically', () => {
      expect(() => hashApprovalInput({ at: new Date(0) })).toThrow(ApprovalInputNotBindableError);
      expect(() => hashApprovalInput({ at: new Date(9e11) })).toThrow(
        ApprovalInputNotBindableError
      );
    });

    it('a Set — its contents were invisible to the hash', () => {
      expect(() => hashApprovalInput({ s: new Set(['a']) })).toThrow(ApprovalInputNotBindableError);
      expect(() => hashApprovalInput({ s: new Set(['b']) })).toThrow(ApprovalInputNotBindableError);
    });

    it('a Map', () => {
      expect(() => hashApprovalInput({ m: new Map([['k', 'v']]) })).toThrow(
        ApprovalInputNotBindableError
      );
    });

    it('a class instance', () => {
      class Target {
        constructor(readonly path: string) {}
      }
      expect(() => hashApprovalInput({ target: new Target('/etc') })).toThrow(
        ApprovalInputNotBindableError
      );
    });

    it('NaN and Infinity, which JSON flattens to null — the same digest as absent', () => {
      expect(() => hashApprovalInput({ n: NaN })).toThrow(ApprovalInputNotBindableError);
      expect(() => hashApprovalInput({ n: Infinity })).toThrow(ApprovalInputNotBindableError);
    });

    it('a function and a bigint', () => {
      expect(() => hashApprovalInput({ fn: () => 1 })).toThrow(ApprovalInputNotBindableError);
      expect(() => hashApprovalInput({ big: 1n })).toThrow(ApprovalInputNotBindableError);
    });

    it('something buried inside an array', () => {
      expect(() => hashApprovalInput({ items: [{ ok: true }, { at: new Date(0) }] })).toThrow(
        /input\.items\[1\]\.at/
      );
    });
  });

  it('names the offending path so the fix is obvious', () => {
    expect(() => assertBindableInput({ schedule: { runAt: new Date(0) } })).toThrow(
      /input\.schedule\.runAt is a Date instance/
    );
  });
});
