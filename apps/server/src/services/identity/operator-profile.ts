/**
 * Who the person at the keyboard is, for a surface that has no "you" framing.
 *
 * **The room path and the roster path diverge on purpose, and this module is
 * the divergence.** `author-registry.ts` mints the operator's author row with
 * `displayName = 'You'` and `bindOwner` deliberately never rewrites it: the
 * column is a render cache with one value per author, so writing the account
 * name there would relabel every message that person had ever written,
 * retroactively. `'You'` is the right word from the operator's own seat in a
 * room. A roster is not that seat — it lists everyone, so the operator's row
 * has to carry their real name and let a small "you" chip do the job the
 * literal used to.
 *
 * So the precedence below **never starts from `authors.display_name`**. It asks
 * the account first, the profile the user filled in second, and only then falls
 * back to the stored render cache — which on most installs is the literal
 * itself, which is why reaching it is the last resort rather than the first
 * answer.
 *
 * Nothing here writes. `LOCAL_HUMAN_DISPLAY_NAME` and `bindOwner` are untouched
 * (spec `identity-consistency` §W2.2, ADR 260806-222535).
 *
 * @module server/services/identity/operator-profile
 */
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';

/**
 * The name a roster falls back to when this install knows nothing else about
 * the person reading it.
 *
 * Deliberately the same word `author-registry.ts` stores, and deliberately NOT
 * imported from it: these are two independent decisions that happen to agree,
 * and coupling them would mean changing one changes the other silently.
 *
 * It IS shared with the client, which is a different relationship: Settings ›
 * Profile has to recognise this value to avoid offering it as though the person
 * had chosen it (DOR-979), and that is a dependency rather than a coincidence.
 * Re-exported here so this module still reads as the owner of the ladder.
 */
export { OPERATOR_FALLBACK_DISPLAY_NAME };

/** The operator, as a roster row renders them. */
export interface OperatorProfile {
  /** Their real name where this install knows one, the fallback where it does not. */
  displayName: string;
  /** Their address — carried on the self row and nowhere else. */
  email?: string;
}

/** The local account that owns this install, reduced to what a roster reads. */
export interface OperatorAccount {
  /**
   * The Better Auth user id. Carried because it is also what decides WHICH
   * author row is the operator (`isOwnerRecord`), so a roster that reads the
   * account once has everything it needs and never asks twice.
   */
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * The two sources every surface that has to NAME this person shares.
 *
 * Narrower than {@link OperatorProfileSources} on the account rung — a name is
 * all either rung is read for — so a caller that holds an account record with no
 * address can still ask for a name without inventing one.
 */
export interface AnswererNameSources {
  /** The account that owns this install, or `null` when nobody has registered. */
  account: () => { name: string | null } | null;
  /** `config.profile.displayName` — "what the user likes to be called". */
  configDisplayName: () => string | null;
}

/** Where an operator's name can come from, in no particular order. */
export interface OperatorProfileSources extends AnswererNameSources {
  /** `findOwnerAccount()` plus its address, or `null` when nobody has registered. */
  account: () => OperatorAccount | null;
}

/** The first source with something in it, ignoring blanks. */
function firstNamed(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Resolve the operator's roster identity.
 *
 * Precedence, highest first: the owner account's name, then
 * `config.profile.displayName`, then the stored author record's display name,
 * then {@link OPERATOR_FALLBACK_DISPLAY_NAME}.
 *
 * The first two rungs are {@link resolveAnswererName}, shared with the Ask
 * receipt so the two surfaces cannot call one person two different things. This
 * function adds only the fallbacks a roster row needs and a receipt must not
 * have.
 *
 * @param sources - Where the name may come from.
 * @param authorDisplayName - The operator's stored author `displayName`, or
 *   `null` when the roster could not read the `authors` table. Third in
 *   precedence, never first.
 */
export function resolveOperatorProfile(
  sources: OperatorProfileSources,
  authorDisplayName: string | null
): OperatorProfile {
  const account = sources.account();
  const displayName =
    resolveAnswererName(sources) ?? firstNamed(authorDisplayName) ?? OPERATOR_FALLBACK_DISPLAY_NAME;

  const email = account?.email?.trim();
  return { displayName, ...(email ? { email } : {}) };
}

/**
 * What to call the person who just answered an agent's prompt, for the receipt
 * every OTHER window draws — "Already answered by Dorian at 2:01".
 *
 * The two real sources, highest first: the owner account's name, then
 * `config.profile.displayName`. {@link resolveOperatorProfile} asks the same two
 * in the same order, so a receipt and the roster can never call one person two
 * different things.
 *
 * The config value is passed through `sanitizeIdentity` and the account name is
 * not, which is not an oversight: `config.profile.displayName` is
 * agent-writable (a `config_patch` can set it mid-conversation), so it gets the
 * same label treatment every other agent-writable profile value gets before it
 * reaches a line DorkOS drew. The account name is operator-authored at signup
 * through Better Auth and is already what a room roster renders.
 *
 * **It stops where that ladder's fallbacks begin, and that is the whole
 * difference.** A roster row must render something, so it falls back to the
 * stored author name and finally to the literal `'You'`. A receipt must not:
 * `'You'` is the word the window that actually answered already uses, so
 * printing "Already answered by You" somewhere else would be flatly wrong, and
 * the stored author name is that same literal on most installs. Returning
 * nothing lets the card say "Already answered at 2:01", which stays true no
 * matter who acted.
 *
 * @param sources - Where the name may come from.
 * @returns The name to print, or `undefined` when this install knows none.
 */
export function resolveAnswererName(sources: AnswererNameSources): string | undefined {
  const configured = sources.configDisplayName();
  return (
    firstNamed(sources.account()?.name, configured ? sanitizeIdentity(configured) : null) ??
    undefined
  );
}
