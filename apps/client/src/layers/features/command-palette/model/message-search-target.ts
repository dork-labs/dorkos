/**
 * Where a search hit opens, and what its row calls the place it was said in
 * (spec `message-search` §8).
 *
 * **A hit opens its CONTAINER, not the message.** Landing on the exact line is
 * a separate task with its own problems (a room scrolls to a `seq`, a
 * transcript scrolls to an index, and neither surface has an anchor today), and
 * a half-built version of it would be a link that sometimes lands in the right
 * place. The container is a promise this cockpit can keep every time.
 *
 * @module features/command-palette/model/message-search-target
 */
import type { SearchHit } from '@dorkos/shared/search-schemas';
// A deep import into `shared/lib`, deliberately, and matching the four callers
// that already do it. `basename` is kept OFF that barrel on purpose: the
// sidebar model's purity contract bans the barrel outright (it is a door onto
// the transport), so putting `basename` on it would break the thing the deep
// import exists for. Left as-is rather than "fixed".
import { basename } from '@/layers/shared/lib/basename';

/** The source id the room log is registered under, server-side. */
const ROOMS_SOURCE = 'rooms';

/** Where one hit opens, as a TanStack Router destination. */
export type MessageSearchTarget =
  | { kind: 'room'; to: '/channels'; search: { id: string } }
  | { kind: 'session'; to: '/session'; search: { session: string; dir: string | undefined } };

/**
 * Resolve where a hit opens.
 *
 * **Two branches, and the default is the transcript one on purpose.** `rooms`
 * is the only source whose container is a room; every other source in the
 * registry is a conversation with a runtime, and `/session` already resolves a
 * session across runtimes (ADR-0310). So Codex and OpenCode need no change here
 * when they are indexed — which is the difference between a switch that ages
 * well and one that starts answering `null` the week after it ships.
 *
 * `dir` travels with a session because the durable stream resolves a
 * conversation's history from it; a session id arriving under whatever
 * directory happened to be on screen reads another project's transcript
 * (DOR-928). A hit whose container never named one sends `undefined` rather
 * than a wrong guess.
 *
 * @param hit - The hit that was chosen.
 */
export function messageSearchTarget(hit: SearchHit): MessageSearchTarget {
  if (hit.source === ROOMS_SOURCE) {
    return { kind: 'room', to: '/channels', search: { id: hit.container } };
  }
  return {
    kind: 'session',
    to: '/session',
    search: { session: hit.container, dir: hit.containerPath ?? undefined },
  };
}

/**
 * What to call the place a hit was said in, given whatever the cockpit already
 * knows about it.
 *
 * A container id is opaque and composed per source, so this never parses one —
 * it looks the room up in a list the cockpit is already holding, and falls back
 * to the working directory's last segment for a conversation. When neither is
 * available it says what KIND of place it was rather than showing an id, which
 * nobody can read and nothing can be done with.
 *
 * @param hit - The hit to label.
 * @param roomTitles - Room id → title, for the rooms this cockpit can see.
 *   Rooms the caller cannot see are not in it, and cannot be in a hit either.
 */
export function messageSearchContainerLabel(
  hit: SearchHit,
  roomTitles: ReadonlyMap<string, string>
): string {
  if (hit.source === ROOMS_SOURCE) {
    return roomTitles.get(hit.container) ?? 'Channel';
  }
  return hit.containerPath === null ? 'Conversation' : basename(hit.containerPath);
}

/**
 * Who said it, in the one word that is true in both places a hit can come from.
 *
 * In a room, `user` is the person and `assistant` is an agent; in a transcript,
 * the same two roles mean the same two speakers. Naming the agent itself would
 * take a second lookup per row and would be wrong for a room, where several
 * agents share the `assistant` role.
 *
 * @param role - The hit's role.
 */
export function messageSearchSpeaker(role: SearchHit['role']): string {
  return role === 'user' ? 'You' : 'Agent';
}
