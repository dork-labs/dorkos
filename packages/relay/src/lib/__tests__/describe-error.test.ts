import { describe, it, expect } from 'vitest';
import { describeError } from '../describe-error.js';

describe('describeError', () => {
  it('extracts the message from an Error', () => {
    expect(describeError(new Error('boom'))).toEqual({ message: 'boom' });
  });

  it('stringifies a non-Error thrown value', () => {
    expect(describeError('just a string')).toEqual({ message: 'just a string' });
    expect(describeError(42)).toEqual({ message: '42' });
    expect(describeError(null)).toEqual({ message: 'null' });
  });

  it('falls back to a plain string `.code` field when no extractor is given', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(describeError(err)).toEqual({ message: 'connect failed', code: 'ECONNREFUSED' });
  });

  it('ignores a non-string `.code` field in the generic fallback', () => {
    const err = Object.assign(new Error('bad request'), { code: 404 });
    expect(describeError(err)).toEqual({ message: 'bad request' });
  });

  it('prefers a supplied extractCode over the generic `.code` fallback', () => {
    const err = Object.assign(new Error('An API error occurred'), {
      code: 'generic_sdk_constant',
      data: { error: 'invalid_auth' },
    });
    const extractCode = (e: unknown) => (e as { data?: { error?: string } })?.data?.error;
    expect(describeError(err, extractCode)).toEqual({
      message: 'An API error occurred',
      code: 'invalid_auth',
    });
  });

  it('omits `code` when the extractor returns undefined', () => {
    const err = new Error('no code here');
    expect(describeError(err, () => undefined)).toEqual({ message: 'no code here' });
  });

  /**
   * DOR-1509. This is the invariant the helper exists to enforce, proven at
   * the generic layer rather than against one specific SDK's error shape:
   * whatever secret a nested property carries, it never survives into the
   * returned object. `JSON.stringify` on the *input* would call a nested
   * `toJSON()` and recover the secret (that's the exact mechanism axios
   * exploits) — the assertion is that the *output* of `describeError` never
   * contains it, regardless of what the input carries.
   */
  it('never surfaces a secret that lives only on a nested property', () => {
    const secret = 'super-secret-token-value';
    class PoisonedError extends Error {
      readonly config = { headers: { Authorization: `Bearer ${secret}` } };
      toJSON() {
        return { message: this.message, config: this.config };
      }
    }
    const result = describeError(new PoisonedError('request failed'));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual({ message: 'request failed' });
  });

  /**
   * DOR-1509 adversarial review. `describeError` must never itself become
   * the thing that throws — it runs inside `catch` blocks whose whole job is
   * to report a DIFFERENT failure without crashing the caller. Each of these
   * reproduces one way a hostile or merely malformed error can make a naive
   * `.message`/`.code` read throw, and pins the same fixed sentinel for all
   * of them rather than a mix of partial results.
   */
  describe('total even against a hostile error (never throws)', () => {
    it('falls back to the sentinel when `.message` access throws', () => {
      const hostile = new Error('irrelevant');
      Object.defineProperty(hostile, 'message', {
        get(): string {
          throw new Error('boom from message getter');
        },
      });
      expect(() => describeError(hostile)).not.toThrow();
      expect(describeError(hostile)).toEqual({ message: 'unserializable error' });
    });

    it('falls back to the sentinel when the generic `.code` getter throws', () => {
      const hostile = new Error('safe message');
      Object.defineProperty(hostile, 'code', {
        get(): string {
          throw new Error('boom from code getter');
        },
      });
      expect(() => describeError(hostile)).not.toThrow();
      expect(describeError(hostile)).toEqual({ message: 'unserializable error' });
    });

    it('falls back to the sentinel for a null-prototype object (String() throws)', () => {
      const hostile: unknown = Object.create(null);
      expect(() => describeError(hostile)).not.toThrow();
      expect(describeError(hostile)).toEqual({ message: 'unserializable error' });
    });

    it('falls back to the sentinel when `toString()` throws and there is no valid message', () => {
      const hostile = {
        toString(): string {
          throw new Error('boom from toString');
        },
      };
      expect(() => describeError(hostile)).not.toThrow();
      expect(describeError(hostile)).toEqual({ message: 'unserializable error' });
    });

    it('falls back to the sentinel when a supplied extractCode throws', () => {
      const err = new Error('safe message');
      const throwingExtractor = (): string | undefined => {
        throw new Error('extractor boom');
      };
      expect(() => describeError(err, throwingExtractor)).not.toThrow();
      expect(describeError(err, throwingExtractor)).toEqual({ message: 'unserializable error' });
    });
  });

  /**
   * DOR-1509 adversarial review. A buggy or malicious `extractCode` — or a
   * plain `.code` field that happens to be object-shaped — must not
   * reintroduce the exact nested-object leak this function exists to close:
   * an object handed back as `code` would otherwise be logged whole.
   */
  describe('drops a non-string code instead of logging it whole', () => {
    it('drops an object-valued code returned by a custom extractCode', () => {
      const secret = 'nested-secret-should-not-leak';
      const err = new Error('safe message');
      const extractCode = () => ({ leaked: secret }) as unknown as string; // mistyped at the boundary
      const result = describeError(err, extractCode);
      expect(result).toEqual({ message: 'safe message' });
      expect(JSON.stringify(result)).not.toContain(secret);
    });

    it('drops an object-valued `.code` field from the generic fallback the same way', () => {
      const secret = 'object-code-should-not-leak';
      const err = Object.assign(new Error('safe message'), { code: { leaked: secret } });
      const result = describeError(err);
      expect(result).toEqual({ message: 'safe message' });
      expect(JSON.stringify(result)).not.toContain(secret);
    });
  });
});
