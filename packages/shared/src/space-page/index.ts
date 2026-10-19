/**
 * What the space's web page and the space server both need, in one place neither has to reach
 * into the other for (server-merge step 7): reading a short web address, the sentences a removed
 * message shows and who may remove one, the owner-replacement wording, the page's one inline
 * script, and the owner-claim route. Free of server and browser imports.
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

/** The acting principal, as the rank rule sees it. */
export interface RemovalActor {
  kind: 'human' | 'agent';
  /** The member id, or the agent id for an agent credential. */
  id: string;
  /** The member's current role; for an agent, its owner's (unused by the rule). */
  role: 'owner' | 'admin' | 'member';
}

/** The content being removed, ranked by its human. */
export interface RemovalTarget {
  /** The authoring or uploading agent, when an agent made it. */
  agentId: string | null;
  /** The member the content counts as: its author, or its author agent's owner. */
  humanId: string;
  /** That member's role now. */
  humanRole: 'owner' | 'admin' | 'member';
  /** Whether that member is still an active member. */
  humanActive: boolean;
}

/**
 * Decide whether an actor may remove a message or file, and as whom.
 *
 * Content is ranked by its human: an agent's content counts as its owner's. An agent credential
 * may remove only what it made; a member what they or their agents made; an admin also anything
 * whose human is neither the owner nor an active admin; the owner anything.
 *
 * @returns `author` when the actor removes their own (or their agent's) content, `moderator`
 *   when an owner or admin removes someone else's, or `null` when refused.
 */
export function removalAuthority(actor: RemovalActor, target: RemovalTarget): RemovedBy | null {
  if (actor.kind === 'agent') return target.agentId === actor.id ? 'author' : null;
  if (target.humanId === actor.id) return 'author';
  if (actor.role === 'owner') return 'moderator';
  const protectedHuman =
    target.humanRole === 'owner' || (target.humanRole === 'admin' && target.humanActive);
  if (actor.role === 'admin' && !protectedHuman) return 'moderator';
  return null;
}

/**
 * The page's one inline script (DOR-2957): it takes a link's secret out of the address bar while
 * the page is still parsing, before the bundle has even started to load. A mailed link, an
 * invitation and an owner's claim carry their secret after `#`; this keeps the fragment in page
 * memory only (`window.__dorkosLinkFragment`, read once by `apps/client/src/space/page-start/read-link-secret.ts`)
 * and replaces the address with the same one without it.
 *
 * the page's `index.html` carries exactly this text, which `page-start.test.ts` checks, and the page
 * policy allows exactly this script by its hash (`PAGE_CSP`). Changing a character here changes
 * the hash with it; a copy in `index.html` that drifts is refused by the browser.
 */
export const LINK_SECRET_SCRIPT =
  "(function(){var h=location.hash;if(h.length<2)return;Object.defineProperty(window,'__dorkosLinkFragment',{value:h.slice(1),configurable:true});history.replaceState(null,'',location.pathname+location.search)})()";

/** The host-level browser route where an intended owner redeems an owner claim. */
export const OWNER_CLAIM_PATH = '/claim';
