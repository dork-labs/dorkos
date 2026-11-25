/**
 * The one address of a conversation in the DorkOS app.
 *
 * Every link that opens a session — a phone push, a desktop banner, an activity
 * row, a room notice, a copied tunnel URL — is `/session?session=<id>`, and both
 * halves are required. Before this module each surface spelled the string out
 * itself, and one of them dropped the path and shipped `?session=<id>` on its
 * own (DOR-2077). The server, the desktop shell and the client all build it
 * here now, so there is one place where the address can be wrong. The
 * markdown link an agent pastes is the `/r/dork:chat:<id>` form instead
 * ({@link chatRefMarkdownLink}), which the `/r/` route turns into this one.
 *
 * Pure, with no router dependency: the server and the desktop main process
 * build these strings without the client's router, so the encoding the router
 * expects is reproduced below rather than imported.
 *
 * @module shared/session-link
 */
import { DORK_LINK_PREFIX, dorkReferenceOrNull } from './dork-ref.js';

/** The client route a conversation is read at. */
export const SESSION_ROUTE = '/session';

/**
 * The search params a session link carries, by the names the `/session` route
 * reads (`session`, `dir`, `runtime`, ...). An `undefined` value is left out.
 */
export type SessionLinkParams = Readonly<Record<string, string | undefined>>;

/**
 * What the client router reads as JSON rather than as a plain string — the same
 * test `@tanstack/router-core` applies before it tries `JSON.parse` on a value.
 */
const JSON_START = /^(?:\s|["[{\d-]|fa|nu|tr)/;

/**
 * One search value, written the way the client router writes it.
 *
 * The router parses every value that looks like JSON, so an unquoted `123`
 * comes back as the number 123 and `true` as a boolean — and the route's
 * `z.string()` refuses both. The router quotes such a string when it builds a
 * URL itself; a link built here has to do the same or it opens a different
 * conversation than the one it names.
 */
function routerValue(value: string): string {
  if (!JSON_START.test(value)) return value;
  try {
    JSON.parse(value);
    return JSON.stringify(value);
  } catch {
    return value;
  }
}

/**
 * The app-relative URL of a conversation: `/session` plus its search params.
 *
 * @param params - The params to carry, in the order they should appear.
 *   `session` names the conversation; the rest are the route's own.
 * @returns A path like `/session?session=abc`, or bare `/session` when no
 *   param has a value.
 */
export function sessionPath(params: SessionLinkParams): string {
  if ((params.dir || params.agentPath) && !params.session) {
    throw new Error('Use an opaque launchRef or agentId for a new session link.');
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'dir' && key !== 'agentPath' && value !== undefined)
      query.set(key, routerValue(value));
  }
  const search = query.toString();
  return search ? `${SESSION_ROUTE}?${search}` : SESSION_ROUTE;
}

/** What a chat with no title yet is called, the same words the app shows. */
export const UNTITLED_CHAT_TITLE = 'New chat';

/**
 * A chat's title as markdown link text: a blank title reads as
 * {@link UNTITLED_CHAT_TITLE}, line breaks become spaces, and square brackets
 * and backslashes are escaped, so a title can never end the link text early or
 * start a new block.
 */
function chatLinkText(title: string | null | undefined): string {
  const words = (title ?? '').replace(/\s+/g, ' ').trim() || UNTITLED_CHAT_TITLE;
  return words.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * A markdown link that opens a chat in the DorkOS app, ready for an agent to
 * paste into what it writes: `[Chat title](/r/dork:chat:<id>)` (DOR-2824,
 * DOR-5202).
 *
 * Agents are told to name a chat by its title and link it, never to show its
 * id, so the tools that hand an agent a chat hand it this too and nobody has to
 * build one. The `/r/` form opens on any DorkOS origin, and its route follows
 * the chat to the id it answers under now, so a link written before a re-key
 * still opens it. The app draws it as the same live chip as a
 * `/session?session=` link.
 *
 * An id that cannot be a `dork:` reference (see `dorkReferenceOrNull`) gets
 * the `/session?session=<id>` link instead, so every chat still links.
 *
 * @param sessionId - The chat's full id.
 * @param title - Its title, or null when it has none.
 * @returns The markdown link.
 */
export function chatRefMarkdownLink(sessionId: string, title: string | null | undefined): string {
  const ref = dorkReferenceOrNull('chat', sessionId);
  const path = ref === null ? sessionPath({ session: sessionId }) : `${DORK_LINK_PREFIX}${ref}`;
  return `[${chatLinkText(title)}](${path})`;
}
