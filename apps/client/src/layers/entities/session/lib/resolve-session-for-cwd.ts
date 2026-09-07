/**
 * Which session a working directory should open on.
 *
 * Every surface that points the cockpit at a project has to answer this, and
 * every one of them has to answer it the same way, because a `/session` URL
 * without `?session=` is a half-loaded page: the chat renders, but no stream
 * ever attaches and the composer cannot accept text.
 *
 * **The answer cannot come from this window's cache alone.** A cockpit
 * cold-loads the session list for the ONE directory it is pointed at; every
 * other agent in the roster has an empty cache entry until something happens to
 * it. So "nothing cached" is overwhelmingly the normal state, not evidence that
 * an agent has no conversations — and reading it as evidence is what made
 * clicking an agent abandon its work and open an empty chat (DOR-928). Only the
 * server can tell the two apart, so on a miss this asks it.
 *
 * The `/session` route loader answers this question too, through this same
 * function: it needs the extra `isNew` bit to decide whether a launch-time
 * `?prompt=` seed rides along, which is the only thing it does differently.
 * Callers that already know the directory answer here rather than navigating to
 * a session-less URL and letting the loader redirect — that costs a second
 * navigation and a history `REPLACE` for the tab reconciler to absorb, and
 * leaves a frame where a new tab is named after an href it is about to lose.
 *
 * @module entities/session/lib/resolve-session-for-cwd
 */
import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import { reportClientError } from '@/layers/shared/lib';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionKeys } from '../api/query-keys';
import { sessionListQueryOptions } from '../api/session-list-query';
import { partitionSessionsByOrigin } from './partition-sessions-by-origin';

/**
 * What every surface says when it could not find out which conversation an
 * agent is on. One message, in one place, because three surfaces show it and
 * they must not drift into describing the same event three ways.
 */
export const SESSION_LOOKUP_FAILED_MESSAGE =
  'Couldn’t reach the server to find this agent’s latest conversation.';

/**
 * Tell the operator the lookup failed, without moving them.
 *
 * The reassurance lives in the description rather than the headline because the
 * headline is shared with the `/session` loader, where "we left you where you
 * were" would be a lie — that path has already moved them.
 *
 * @param cwd - The directory that could not be resolved, named so the message
 *   is about something rather than about nothing.
 */
export function notifySessionLookupFailed(cwd: string | null): void {
  toast.error(SESSION_LOOKUP_FAILED_MESSAGE, {
    description: cwd
      ? `Still where you were. Try ${cwd} again in a moment.`
      : 'Still where you were. Try again in a moment.',
  });
}

/** What {@link resolveSessionForCwd} needs: somewhere to look, somewhere to ask. */
export interface ResolveSessionDeps {
  /** Query client holding (and caching) the per-directory session lists. */
  queryClient: QueryClient;
  /** Transport used to ask the server when nothing is cached yet. */
  transport: Transport;
}

/**
 * The session a directory opens on: which one, whether it had to be invented,
 * and the directory its own reads have to name.
 */
export interface ResolvedSession {
  /** A session id that is always safe to put in a `/session` URL. */
  sessionId: string;
  /**
   * True when the directory has no conversations and this id was minted for a
   * brand-new one. The loader reads it to decide whether a launch-time
   * `?prompt=` seed may ride along — a seed must never land in an existing
   * conversation.
   */
  isNew: boolean;
  /**
   * **The directory this session's own reads have to name**, which is the
   * session's own working directory rather than the one that was asked for.
   *
   * The two are not always the same. A project's session list covers the
   * project's whole SUBTREE (DOR-1550): a conversation started in
   * `<project>/apps/desktop` is filed under its own directory and appears in
   * `<project>`'s list, carrying that directory in its row. Every per-session
   * read on the server is addressed by id AND directory, so asking about such a
   * session under `<project>` answers 404 for the detail row and an EMPTY
   * transcript for the messages — a conversation that looks erased rather than
   * misaddressed (measured 2026-09-07, DOR-1836).
   *
   * `null` when the answer was invented (there is no session yet, so no
   * directory belongs to it) and the caller named no directory either.
   *
   * **Every caller that asked about a directory of its own keeps it, and none
   * of them reads this** — switching agents means going to the agent you picked,
   * not to wherever its newest conversation happens to live, and the row that
   * names the agent would then be pointing somewhere the window is not. So
   * `SidebarChrome`, `use-palette-actions`, `use-directory-state` and
   * `switchAgentCwd` all navigate with the directory they were given and discard
   * this one.
   *
   * That is a DELIBERATE trade, not an oversight, and it is worth stating what
   * it costs: the empty-transcript symptom above is reachable from every one of
   * those four surfaces, not only from `/session?dir=`. Picking an agent whose
   * newest conversation was held one level down still reads under the agent's
   * own directory and still comes back empty. The alternative — skipping any row
   * whose directory is spelled differently from the one asked for — trades a
   * recoverable empty transcript for DOR-928's own symptom, a spurious mint
   * abandoning real work, on any path-spelling mismatch. Fixing it properly
   * means addressing a session by id alone, which is a server-side change.
   *
   * The `/session` loader is the one caller with no directory to keep, so it is
   * the one that adopts this.
   */
  cwd: string | null;
}

/**
 * The most recent CONVERSATION for `cwd`, or a freshly minted id when that
 * directory has never held one (see {@link mostRecentConversation} — sessions
 * that started without a person are not conversations, BC-34).
 *
 * Answers from cache when the list is there and still believable, and asks the
 * server otherwise — the server's answer is then cached under the same key
 * `useSessions` reads, so switching back to that agent is free.
 *
 * A minted id is speculative by design: it becomes real on the first message,
 * and navigation alone never creates a session.
 *
 * **`null` means "could not find out", and is not a licence to mint.** If the
 * lookup fails, the only honest answers are to say so and stay put. Minting
 * there would open a blank chat for an agent that has work — DOR-928's own
 * symptom, wearing the fix as a disguise — and typing into it makes it real.
 * Callers must surface it rather than navigate.
 *
 * @param deps - Query client to read and fill, transport to ask over.
 * @param cwd - The target working directory, or `null` for the default one.
 * @returns The resolved session, whether it is brand-new, and the directory its
 *   reads must name (see {@link ResolvedSession.cwd}), or `null` when the lookup
 *   failed.
 */
export async function resolveSessionForCwd(
  deps: ResolveSessionDeps,
  cwd: string | null
): Promise<ResolvedSession | null> {
  const sessions = trustedSessionsForCwd(deps.queryClient, cwd) ?? (await askServer(deps, cwd));
  if (sessions === null) return null;
  const mostRecent = mostRecentConversation(sessions);
  return mostRecent
    ? // The row's OWN directory first, because that is the one the server can
      // place this session under; the asked-for one only as a fallback, for a
      // runtime whose listing does not report a directory at all.
      { sessionId: mostRecent.id, isNew: false, cwd: mostRecent.cwd ?? cwd }
    : // Nothing exists yet, so no directory belongs to this id — the caller's own
      // is the only honest answer, and `null` when it had none either.
      { sessionId: crypto.randomUUID(), isNew: true, cwd };
}

/**
 * The newest conversation a PERSON had here, or `undefined` when there has
 * never been one.
 *
 * **The most recent session and the most recent conversation are not the same
 * thing, and BC-34 asks for the second.** Clicking an agent opens "its most
 * recent human conversation" — but the raw list is every session that ran in
 * this directory, newest first, including the ones that started without you.
 * Taking `sessions[0]` therefore landed the operator inside a room-triggered
 * run the moment they `@`-mentioned an agent in a channel: reproduced by posting
 * `@tangerines …` in `#team` and clicking the `tangerines` row.
 *
 * That failure compounds rather than merely surprising. BC-19 keeps automated
 * sessions out of Today, so the conversation the operator was just dropped into
 * is one the sidebar then refuses to name — no anchor row, no way back except
 * the switcher.
 *
 * The definition of "human" is `partitionSessionsByOrigin`'s, shared with the
 * session switcher's "Live now" group and the agent row's "N live" chip, so all
 * three agree about what a conversation is. That an ABSENT origin means `user`
 * comes from the field itself — `SessionSchema.origin` in
 * `packages/shared/src/schemas.ts`, whose contract is "ABSENT means
 * user-initiated, the unmarked default" — and not from any design decision.
 *
 * **No conversation means a FRESH one, not the newest automated run** — BC-34's
 * own else-branch. An agent that has only ever run scheduled tasks opens on an
 * empty composer, which is the honest answer to "take me to where we were
 * talking": we never were.
 *
 * @param sessions - The directory's sessions, newest first.
 */
function mostRecentConversation(sessions: Session[]): Session | undefined {
  return partitionSessionsByOrigin(sessions).conversations[0];
}

/**
 * The session `cwd` is already known to be on, for the one caller that cannot
 * wait: a link's `href` has to be a string at render time, and rendering it for
 * a roster of agents must not cost a request each.
 *
 * `null` means "not known here", NOT "no sessions" — the distinction this
 * module exists to keep. A caller that gets `null` must leave `?session=` off
 * its URL and let the `/session` loader resolve it properly on arrival, never
 * mint an id of its own.
 *
 * **The same human-conversation rule as {@link resolveSessionForCwd}**, and it
 * has to be: this builds the `href` a row is rendered with while that resolves
 * the click. Filtering in one and not the other would give a link that points
 * somewhere its own click does not go — and "no cached CONVERSATION" answers
 * `null` here, which is already the honest "let the loader work it out".
 *
 * @param queryClient - Query client holding the cached session lists.
 * @param cwd - The target working directory, or `null` for the default one.
 * @returns The most recent known conversation id, or `null` when none is cached.
 */
export function cachedSessionForCwd(queryClient: QueryClient, cwd: string | null): string | null {
  const sessions = trustedSessionsForCwd(queryClient, cwd);
  return sessions === null ? null : (mostRecentConversation(sessions)?.id ?? null);
}

/**
 * Ask the server for `cwd`'s sessions, through the shared query options so the
 * answer lands in the cache exactly as `useSessions` would have left it.
 *
 * **`staleTime: 0` is the whole point of this call.** Reaching here means the
 * cached entry was already judged unbelievable, and every "give me the data"
 * helper — `ensureQueryData`, and `fetchQuery` on its own — will hand that same
 * entry straight back while it is still fresh. The app runs a 30-second
 * `staleTime` (`createQueryClientConfig`), and the global-stream bridge writes
 * an EMPTY list whenever it removes a directory's last session, so without this
 * argument clicking that agent reproduces DOR-928 for the next 30 seconds.
 *
 * The failure is REPORTED, not swallowed, and answers `null` rather than an
 * empty list — the two want opposite reactions. An unreachable server means
 * "unknown", which callers must surface. An empty list means "no conversations",
 * which is the one case where starting a new one is right.
 */
async function askServer(deps: ResolveSessionDeps, cwd: string | null): Promise<Session[] | null> {
  try {
    return await deps.queryClient.fetchQuery({
      ...sessionListQueryOptions(deps, cwd),
      staleTime: 0,
    });
  } catch (error) {
    reportClientError(deps.transport, error);
    return null;
  }
}

/**
 * The cached session list for `cwd` when it can still be believed, or `null`
 * when this window has to ask.
 *
 * A NON-EMPTY, non-invalidated entry is the only cache hit worth taking. Empty
 * is the state a never-displayed directory is in, which is the whole bug.
 * Invalidated is the state a Claude account switch leaves every list in
 * (`session_list_invalidated` marks them; it does not drop them), so trusting
 * one there resumes an id belonging to the account that is no longer signed in.
 */
function trustedSessionsForCwd(queryClient: QueryClient, cwd: string | null): Session[] | null {
  const state = queryClient.getQueryState<Session[]>(sessionKeys.list(cwd));
  if (state === undefined || state.isInvalidated) return null;
  return state.data && state.data.length > 0 ? state.data : null;
}
