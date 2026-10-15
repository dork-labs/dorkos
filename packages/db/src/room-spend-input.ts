import { createHash } from 'node:crypto';
/** Pure spend-input validation. This module owns no native handle or receipt authority. */
import { types } from 'node:util';

/** Reject unsupported time values without coercion or callbacks. */
export function validateSpendTime(value: number): void {
  if (!Number.isSafeInteger(value)) throw new RangeError('Spend time must be a safe integer');
}

/** Validate the strict window's primitive inputs; this does not authorize a spend. */
export function validateSpendWindow(roomId: string, floor: number, at: number): void {
  if (typeof roomId !== 'string') throw new TypeError('Room id must be a string');
  validateSpendTime(floor);
  validateSpendTime(at);
  if (floor > at) throw new RangeError('Invalid spend window');
}

/** Copy only bounded ordinary-array own data, without evaluating iterators or accessors. */
export function copyOrdinarySpendInputs<T>(input: readonly T[]): readonly T[] | undefined {
  if (
    types.isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    throw new TypeError('Spend receipts require an ordinary array');
  }
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 4096) {
    throw new RangeError('Spend fact window exceeds native bound');
  }
  const copied: T[] = [];
  const seen = new Set<T>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Spend receipts require own index data');
    }
    const value = descriptor.value as T;
    if (seen.has(value)) return undefined;
    seen.add(value);
    Object.defineProperty(copied, index, { value, enumerable: true });
  }
  return copied;
}

/** Compute the hexadecimal SHA-256 digest of a source string. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Parse an ISO timestamp and require its exact canonical round trip. */
export function canonicalTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== value)
    throw new Error('Noncanonical Room timestamp');
  return time;
}
