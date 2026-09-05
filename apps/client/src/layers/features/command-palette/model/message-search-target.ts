/**
 * Where a search hit opens, and what its row calls the place it was said in
 * (spec `message-search` §8).
 *
 * **A hit opens ON the message it matched, in a room and in a conversation
 * alike** (DOR-687, then DOR-1579) — but by two different coordinates, because
 * the two stores number their messages differently.
 *
 * A room hit rides `ordinal`, which IS the entry's `seq`: the number the room
 * addresses its own rows by, so the coordinate the index already returns is an
 * address. A conversation hit cannot: its `ordinal` is a running count of the
 * messages the projection KEPT, with tool calls, tool results, thinking and
 * command records all skipped, so `messages[ordinal]` in the session view is
 * reliably a DIFFERENT message. It rides {@link SearchHit.messageId} instead —
 * the id the store that owns the transcript gave that message — and when there
 * is none, or the runtime is not one whose ids have been verified against what
 * its session view renders, the hit opens the conversation and nothing more.
 * Landing on the wrong line is worse than landing in the right conversation.
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

/**
 * The sources whose indexed `messageId` has been proved to be the id their
 * session view renders the same message under.
 *
 * **An allowlist rather than "send it whenever we have one", because the two
 * ids agreeing is a per-runtime FACT and not a shape.** Carrying an id says
 * nothing about whether anything can be found by it:
 *
 * - **`claude-code`** — proved. The index stores the JSONL record `uuid`
 *   (`services/search/projections/claude-code.ts`) and the session view's
 *   transcript reader mints `ChatMessage.id` from the same field
 *   (`services/runtimes/claude-code/sessions/transcript-parser.ts:350,454,508,
 *   532,679,730` — `parsed.uuid || crypto.randomUUID()`), which reaches the
 *   client unchanged through `mapHistoryMessage` (`id: m.id`).
 * - **`opencode`** — proved. The index stores the store's own `message.id`
 *   (`services/search/opencode-store.ts` → `projections/opencode.ts`) and the
 *   session view builds its history from the SDK's message info under the same
 *   id (`services/runtimes/opencode/sessions/session-mapper.ts:282,285` — `id: info.id`,
 *   reached through `OpenCodeRuntime.getMessageHistory`).
 * - **`codex` is deliberately OFF.** Its rollout files carry a `response_item`
 *   `item.id` and the index stores it, but the session view does not read those
 *   files at all: a Codex conversation is rebuilt from DorkOS's own event log,
 *   which numbers messages `user-<seq>` / `assistant-<seq>`
 *   (`services/session/event-log-history.ts:290,450`). The two id spaces never
 *   intersect, so a `message` param would always miss. It joins this list the
 *   day the session view reads the rollout — or the day the event log records
 *   the item id it was built from.
 * - **`rooms` is not here and never will be**: a room lands by `seq`, above.
 */
const EXACT_LANDING_SOURCES: readonly string[] = ['claude-code', 'opencode'];

/** Where one hit opens, as a TanStack Router destination. */
export type MessageSearchTarget =
  | { kind: 'room'; to: '/channels'; search: { id: string; entry: number } }
  | {
      kind: 'session';
      to: '/session';
      search: { session: string; dir: string | undefined; message?: string };
    };

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
 * `entry` travels with a room because that is the whole of DOR-687: the room
 * route reads it as the `seq` to land on, and the team-room redirect carries it
 * across to Home. A room whose history no longer reaches that far says so
 * rather than pretending (`useEntryLanding`).
 *
 * `dir` travels with a session because the durable stream resolves a
 * conversation's history from it; a session id arriving under whatever
 * directory happened to be on screen reads another project's transcript
 * (DOR-928). A hit whose container never named one sends `undefined` rather
 * than a wrong guess.
 *
 * `message` travels with a session only when the hit carries an id AND its
 * source is in {@link EXACT_LANDING_SOURCES} — see there for what "verified"
 * means and why Codex is not in it. Omitted, the conversation opens where it
 * always did, which is the correct thing to degrade to.
 *
 * @param hit - The hit that was chosen.
 */
export function messageSearchTarget(hit: SearchHit): MessageSearchTarget {
  if (hit.source === ROOMS_SOURCE) {
    return { kind: 'room', to: '/channels', search: { id: hit.container, entry: hit.ordinal } };
  }
  const lands = hit.messageId !== undefined && EXACT_LANDING_SOURCES.includes(hit.source);
  return {
    kind: 'session',
    to: '/session',
    search: {
      session: hit.container,
      dir: hit.containerPath ?? undefined,
      ...(lands ? { message: hit.messageId } : {}),
    },
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
