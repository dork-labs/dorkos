/**
 * What the space's web page and the space server both need, in one place neither has to reach
 * into the other for (server-merge step 7): reading a short web address, the sentences a removed
 * message shows, and the owner-replacement wording. Free of server and browser imports.
 *
 * @module shared/space-page
 */
import { COMMUNITY_SHORT_NAME_PATTERN } from '../community-admin-wire.js';

/** A path that opens a community by its short address, `/<name>[/...]`. */
export interface ShortNamePath {
  /** The name as the grammar reads it: percent-decoded and lowercased. */
  name: string;
  /** Everything after the name, as it appeared in the path, or `''`. */
  rest: string;
  /** Whether the path already spells the name that way; if not, it should move to `/<name>`. */
  canonical: boolean;
}

/**
 * Read a raw (still percent-encoded) path as a short address. The server and the browser both
 * use this, so `/Acme` and `/%61cme` mean `/acme` to each of them. Returns `null` for any path
 * whose first segment is not a name the grammar allows, or is reserved.
 */
export function parseShortNamePath(
  pathname: string,
  reservedNames: ReadonlySet<string>
): ShortNamePath | null {
  const match = /^\/([^/]+)(\/.*)?$/u.exec(pathname);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const name = decoded.toLowerCase();
  if (!COMMUNITY_SHORT_NAME_PATTERN.test(name) || reservedNames.has(name)) return null;
  return { name, rest: match[2] ?? '', canonical: match[1] === name };
}

/**
 * The text a removed message shows in place of what it said, by who removed it. The kind of
 * remover is shown, never the person.
 */
export const REMOVED_ENTRY_TEXT = {
  author: 'This message was deleted.',
  moderator: 'This message was removed by a space admin.',
  host: 'This message was removed by the server admin.',
} as const;

/** Who removed a message or file: its author (or their agent), an owner or admin, or the host. */
export type RemovedBy = keyof typeof REMOVED_ENTRY_TEXT;

/** The text every erased message shows in place of what it said. */
export const ERASED_ENTRY_TEXT = 'This message was erased.';

/**
 * The removal sentences written before DOR-2653, which said "community admin" and "host"
 * instead of "space admin" and "server admin". Rows removed then still hold them in
 * `entries.text`, so they stay tombstones: shown as removed, offered no actions, and refused as
 * the text of a new post.
 */
const LEGACY_REMOVED_ENTRY_TEXTS = [
  'This message was removed by a community admin.',
  'This message was removed by the host.',
] as const;

const TOMBSTONE_TEXTS: ReadonlySet<string> = new Set([
  ...Object.values(REMOVED_ENTRY_TEXT),
  ...LEGACY_REMOVED_ENTRY_TEXTS,
  ERASED_ENTRY_TEXT,
]);

/**
 * Whether a message's text is one of the tombstone sentences, so it has nothing left to act on.
 * The wire carries no removal flag (a strict schema older installations parse), so the text is
 * the signal.
 */
export function isTombstoneText(text: string): boolean {
  return TOMBSTONE_TEXTS.has(text);
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * A date as owner-replacement copy says it: in UTC, with the day spelled out, such as
 * "Tuesday, 29 September 2026 (UTC)". The zone is named because owner and host may be anywhere.
 */
export function formatReplacementDate(date: Date): string {
  return `${DATE.format(date)} (UTC)`;
}

/** What the owner of a community with an open replacement can do about it now. */
export interface OwnerReplacementOptions {
  /** Keeping ownership needs only the email link or a signed-in session, in every open state. */
  keep: true;
  /** Hand the community to someone: `POST /owner/transfer`, only in `active`, with a password. */
  transfer: boolean;
  /** Delete the community: `POST /owner/deletion`, which needs a password. */
  delete: boolean;
  /** The owner has no password, so transfer and delete wait until they add one. */
  needsPassword: boolean;
}

/**
 * The owner's options, from the community's lifecycle and whether their account has a password.
 * An open replacement exists only in `active`, `archived`, or `held`, and the owner-deletion
 * route accepts all three, so deleting needs only the password; transfer is refused in
 * `archived` and `held`.
 */
export function ownerReplacementOptions(input: {
  lifecycle: string;
  hasPassword: boolean;
}): OwnerReplacementOptions {
  return {
    keep: true,
    transfer: input.lifecycle === 'active' && input.hasPassword,
    delete: input.hasPassword,
    needsPassword: !input.hasPassword,
  };
}

/**
 * What an owner without a password is told to do, in the email and the banner. Only an `active`
 * community can be handed to someone, so elsewhere a password opens deletion alone, and the
 * sentence promises nothing more.
 */
export function addPasswordSentence(lifecycle: string): string {
  return lifecycle === 'active'
    ? 'To hand it to someone or delete it, add a password to your account first.'
    : 'To delete it, add a password to your account first.';
}
