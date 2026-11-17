/**
 * Arguments that take an X action past the owner's own account (DOR-4332).
 * The media upload steps are writes, so a level covers them, but an upload
 * that lets other accounts use the media, or a promoted-only post that stays
 * off the owner's timeline, is something a person picks for one agent on
 * purpose (a brand account, an ad). Those need the agent's own exact grant.
 *
 * The check reads the arguments before schema cleaning, which only drops
 * nulls, and a null here already counts as off; the broker runs it again
 * right before the request is sent. A value it can't read counts as on.
 *
 * @module services/connectors/execution/account-reach-arguments
 */

/** Toolkits whose arguments this check reads, spelled as {@link looseKey} spells them. */
const X_TOOLKITS = new Set(['twitter']);

/** Why an upload that shares the media with other accounts needs its own grant. */
export const X_SHARED_UPLOAD_NEEDS_OWN_GRANT =
  'This X upload would let other accounts use your media, so it needs to be given to this agent on its own.';

/** Why a promoted-only post needs its own grant. */
export const X_HIDDEN_POST_NEEDS_OWN_GRANT =
  'This X post would be promoted-only and stay off your timeline, so it needs to be given to this agent on its own.';

/** Name or key spelled without case or separators, so `additional_owners` and `additionalOwners` match. */
function looseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Values that plainly leave a flag off. Anything else fails closed. */
function flagIsOff(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === 0 ||
    (typeof value === 'string' && ['', 'false', '0', 'no'].includes(value.trim().toLowerCase()))
  );
}

/** Whether an owners argument names anyone: any entry that isn't plainly empty. */
function namesSomeone(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => !flagIsOff(entry));
  return !flagIsOff(value);
}

/** Whether any nested argument with one of these loose keys is set. */
function anyKeySet(
  value: unknown,
  keys: ReadonlySet<string>,
  isSet: (v: unknown) => boolean
): boolean {
  if (Array.isArray(value)) return value.some((entry) => anyKeySet(entry, keys, isSet));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, entry]) => (keys.has(looseKey(key)) && isSet(entry)) || anyKeySet(entry, keys, isSet)
  );
}

const OWNERS = new Set(['additionalowners']);
const SHARED = new Set(['shared']);
const NULLCAST = new Set(['nullcast']);

/**
 * Why this X action needs the agent's own exact grant, in plain words, or
 * `null` when its arguments stay inside the owner's account.
 *
 * @param operation - The service (toolkit) the action belongs to.
 * @param args - Arguments as the agent sent them.
 */
export function accountReachArguments(
  operation: { toolkit: string },
  args: Record<string, unknown>
): string | null {
  if (!X_TOOLKITS.has(looseKey(operation.toolkit))) return null;
  if (anyKeySet(args, OWNERS, namesSomeone) || anyKeySet(args, SHARED, (v) => !flagIsOff(v))) {
    return X_SHARED_UPLOAD_NEEDS_OWN_GRANT;
  }
  return anyKeySet(args, NULLCAST, (v) => !flagIsOff(v)) ? X_HIDDEN_POST_NEEDS_OWN_GRANT : null;
}
