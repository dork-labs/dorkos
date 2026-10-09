import { isOwnedCaptureCancellation } from '@dorkos/browser/server-owner';

const originals = new WeakSet<object>();
/** Private local work outcome only; this never authorizes a producer or proves native return. */
export function originalCaptureCancellation<T extends object>(error: T): T {
  originals.add(error);
  return error;
}
/** Identify only a captured original cancellation, preserving independent operational failures. */
export function isOriginalCaptureCancellation(error: unknown): boolean {
  return (
    (!!error && typeof error === 'object' && originals.has(error)) ||
    isOwnedCaptureCancellation(error)
  );
}
