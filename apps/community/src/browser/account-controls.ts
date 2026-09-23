import { describeError, RequestError } from './api.js';

const ABILITIES: Record<string, string> = {
  read: 'read',
  post: 'post',
  'enroll-agent': 'add agents',
};

/** Say what one connected installation may do here, in words rather than scope names. */
export function describeInstallAccess(scopes: readonly string[]): string {
  const abilities = scopes.map((scope) => ABILITIES[scope]).filter(Boolean);
  if (abilities.length === 0) return 'No access';
  const last = abilities.at(-1)!;
  const list = abilities.length === 1 ? last : `${abilities.slice(0, -1).join(', ')} and ${last}`;
  return `Can ${list}`;
}

/**
 * Explain a refused password confirmation and that nothing changed.
 *
 * The server answers every failed reauthentication with one terse 403; the person needs to
 * know it was the password and that the action did not happen.
 */
export function describeReauthenticationError(cause: unknown, unchanged: string): string {
  if (cause instanceof RequestError && cause.status === 403 && cause.code === 'FORBIDDEN')
    return `That password is not right. ${unchanged}`;
  return describeError(cause);
}
