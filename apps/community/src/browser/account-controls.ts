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
 * Explain a refused password-confirmed action and whether anything changed.
 *
 * Only `REAUTH_FAILED` means the password was wrong, and a spent guess budget (`RATE_LIMITED`)
 * also changed nothing, so both say so. Every other refusal (an ended membership, an owner who
 * must transfer first) keeps the server's own plain reason, because that is what the person
 * needs to act on.
 */
export function describeReauthenticationError(cause: unknown, unchanged: string): string {
  if (cause instanceof RequestError && cause.code === 'REAUTH_FAILED')
    return `That password is not right. ${unchanged}`;
  if (cause instanceof RequestError && cause.code === 'RATE_LIMITED')
    return `${cause.message} ${unchanged}`;
  return describeError(cause);
}
