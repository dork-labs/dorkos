/**
 * The one way the client builds a link to a conversation (DOR-2077).
 *
 * A session is read at `/session`, named by `?session=<id>`, and both halves
 * are required. Before this module roughly forty call sites spelled that out by
 * hand, as a navigate target or as a string, and one of them — the tunnel's
 * "copy session link" — shipped the id without the path. Every link into a
 * conversation now goes through one of two builders here:
 *
 * - {@link toSession} — a typed `navigate()` / `redirect()` target.
 * - {@link sessionHref} — the same address as a string, for an `href`, a copy
 *   button or a new tab. It is built by `@dorkos/shared/session-link`, the
 *   same function the server and the desktop shell use for push and banner
 *   links, so the three cannot drift apart.
 *
 * `scripts/__tests__/session-link-boundary.test.ts` fails on a session URL
 * built anywhere else.
 *
 * @module shared/lib/session-link
 */
import { z } from 'zod';
import { SESSION_ROUTE, sessionPath } from '@dorkos/shared/session-link';
// The leaf rather than the `shared/model` barrel, so a link builder never pulls
// the model layer's React hooks in with it.
import { mergeDialogSearch } from '../model/dialog-search-schema';

export { SESSION_ROUTE };

/**
 * Search params for the `/session` route.
 *
 * `runtime` is the launch-time runtime selection (e.g. `?runtime=opencode`):
 * it is carried into the first message POST as the `runtime` hint that binds a
 * brand-new session to that runtime (first-write-wins server-side).
 *
 * `prompt` seeds the composer of a freshly-launched session — the "Run this
 * with…" re-run carries the original prompt into a new session bound to another
 * runtime (ADR-0255: a switch is always a fresh session, never a history
 * transplant), and any link (docs, CLI, a marketplace page) can open DorkOS with
 * the question already written. It applies to a conversation with no messages
 * and to nothing else: a prompt aimed at a session that already has history is
 * ignored, by the loader below AND by `useLaunchPrompt` (which is the guard that
 * still holds for a URL somebody typed with a `session` id already in it).
 *
 * `send=1` turns that seed into a turn: the composer is filled and then
 * submitted through the composer's own handler, exactly once. Spelled as the
 * single literal `'1'` and `.catch()`ed, so `?send=0` or `?send=please` is
 * ignored rather than throwing the route — and so nothing that is not an
 * explicit opt-in can ever start a turn on somebody's behalf. Both params are
 * dropped from the URL the moment they are consumed, so a refresh or a Back does
 * not re-issue them.
 *
 * `seed=dorkbot-help` is the sidebar's ✦ Ask DorkBot press (BC-48). It carries
 * no words: the composer stays empty and focused, and the chat model builds a
 * hidden preamble locally — the page you came from, your fleet, your version,
 * what is currently broken — which rides the first send as `seedContext` and
 * nothing after it. An ENUMERATED literal and `.catch()`ed like `send`, because
 * this param names a situation the client knows how to describe, not text an
 * address bar supplies: a URL cannot dictate what an agent is told. Spent the
 * moment it is taken, exactly as `prompt`/`send` are.
 *
 * `continuedFrom` is the `/clear` intent's "linked back" reference (DOR-109) —
 * the id of the session this fresh one continues from. A lightweight client-side
 * link recorded in the URL only; there is no DB column.
 *
 * `message` is the conversation's answer to `entry` on a room (DOR-1579): the
 * id of the one message the transcript should open on, which a message-search
 * hit puts there. It is the store's own id for that message — a JSONL record
 * `uuid`, an OpenCode message id — never a position, because the index and the
 * session view count messages differently and only an id survives that.
 * Unknown or stale, it lands nowhere and the conversation opens as it always
 * does, so it is a plain optional string with nothing to `.catch()`.
 *
 * Lives beside the link helpers rather than in `router.tsx` so a link and the
 * route it opens read the one list of params: the router validates with it, and
 * {@link toSession} is typed by it.
 */
export const sessionSearchSchema = mergeDialogSearch(
  z.object({
    session: z.string().optional(),
    dir: z.string().optional(),
    message: z.string().optional(),
    runtime: z.string().optional(),
    prompt: z.string().optional(),
    send: z.literal('1').optional().catch(undefined),
    seed: z.literal('dorkbot-help').optional().catch(undefined),
    continuedFrom: z.string().optional(),
  })
);

/** Search params available on the `/session` route. */
export type SessionSearch = z.infer<typeof sessionSearchSchema>;

/** A navigation target that opens a conversation. */
export interface SessionTarget<S = SessionSearch> {
  /** Always the session route. */
  to: typeof SESSION_ROUTE;
  /** Which conversation, and how to open it — or how to change the one open now. */
  search: S;
}

/** Rewrites the search of the conversation on screen into the next one. */
export type SessionSearchUpdate = (prev: SessionSearch) => SessionSearch;

/**
 * The `navigate()` target for a conversation.
 *
 * Pass it straight through — `navigate(toSession({ session: id }))` — or
 * spread it when a navigation needs more
 * (`{ ...toSession(search), replace: true }`).
 *
 * Takes the params themselves, or a function of the current ones for a
 * navigation that changes one param and keeps the rest
 * (`toSession((prev) => ({ ...prev, dir }))`). The object form keeps the
 * caller's own type, so a caller that knows `session` is a string still knows
 * it on the way out.
 *
 * @param search - Which conversation (`session`), where (`dir`), and any of the
 *   route's launch params — or a function from the current params to those.
 */
export function toSession(search: SessionSearchUpdate): SessionTarget<SessionSearchUpdate>;
export function toSession<S extends SessionSearch>(search: S): SessionTarget<S>;
export function toSession<S extends SessionSearch | SessionSearchUpdate>(
  search: S
): SessionTarget<S> {
  return { to: SESSION_ROUTE, search };
}

/**
 * The app-relative URL of a conversation, for an `href`, a copy button or a new
 * tab: `/session?session=abc`.
 *
 * Written the way the router writes its own URLs, so following the string opens
 * exactly what `navigate(toSession(search))` would.
 *
 * @param search - The same params {@link toSession} takes.
 */
export function sessionHref(search: SessionSearch): string {
  return sessionPath(search);
}
