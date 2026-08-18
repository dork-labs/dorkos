/**
 * The room's live lane: `Conversation.LiveLane` wired to a room's own facts.
 *
 * One component rather than two copies, because the room draws two of these —
 * the room column's, and the thread panel's, which speaks for the claims
 * triggered inside the open thread. What differs between them is a scope and a
 * couple of props; what they share is everything else.
 *
 * **It reads presence WITHOUT the clock.** `useRoomPresenceClaims` says why at
 * length: the room's scroller and every row in it are siblings of this lane, and
 * a ticking read up here would redraw all of them once a second. The elapsed
 * time is drawn by the lane's own leaf.
 *
 * @module widgets/room-view/ui/RoomLiveLane
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  threadRootIdOf,
  useHaltRoom,
  useRoomPresenceClaims,
  useRoomSessions,
  type PresenceScope,
  type RoomEntry,
  type RoomWithRoster,
} from '@/layers/entities/room';
import {
  Conversation,
  MessageAuthorAvatar,
  deriveLaneState,
  type LaneScope,
  type LanePresenceAuthor,
  type LivePeekRow,
} from '@/layers/features/conversation';
import { usePendingInteractions } from '@/layers/entities/attention';
import { InteractionAsk } from '@/layers/features/ask';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';
import {
  authorsById,
  entryRowId,
  threadPanelRowId,
  threadRowId,
  toMessageAuthor,
} from '../lib/room-timeline';
import { useRoomAgentDirectory } from '../model/agent-info-context';

/**
 * What to call an agent the roster does not hold.
 *
 * Reachable only in the seconds between an agent joining a room and this
 * client's copy of the roster catching up. Counting it without naming it is the
 * honest answer: something IS working, and this client cannot yet say what.
 */
const UNKNOWN_AGENT = 'An agent';

/** How much of an entry the peek quotes back before cutting it short. */
const EXCERPT_MAX = 64;

/** How many faces stack in front of the sentence before they become a count. */
const FACE_LIMIT = 3;

/** What the room's lane needs to draw itself. */
export interface RoomLiveLaneProps {
  /** The room on screen, with the roster the names come from. */
  room: RoomWithRoster;
  /** The room's loaded history — where the "replying to" excerpts come from. */
  entries: readonly RoomEntry[];
  /**
   * Which half of the room's presence this lane speaks for while a thread panel
   * is open. Omit for all of it, which is the usual case.
   */
  scope?: PresenceScope;
  /** Which lane this is, for the announcer's name. */
  laneScope: LaneScope;
  /** True when the room's live stream has given up. */
  stalled: boolean;
  /** True when the server says this reader may no longer read this room. */
  unavailable?: boolean;
  /** Ask the stream to try now. Omitted where this lane does not own the retry. */
  onRetry?: () => void;
  /**
   * Take the reader to one row of the history this lane sits under.
   *
   * The host's, not this component's, because the row may not be in the
   * document at all: the timeline is virtualized, so only what is on screen
   * exists, and only the timeline can scroll something into being. It hands
   * `Conversation.Timeline`'s own handle down — see `RoomSurface`.
   *
   * Omitted where the peek has nowhere to take anybody; the "replying to …"
   * link is then not drawn at all.
   */
  onScrollToRow?: (domId: string) => void;
}

/**
 * The room's lane, and the peek behind it.
 *
 * The peek's one request — where each agent's work runs — is fetched when the
 * peek OPENS and never on room mount: it is wanted by that affordance alone, and
 * a room open is not a question about sessions.
 *
 * @param props - The room, its history, and which half of its presence to speak
 *   for.
 */
export function RoomLiveLane({
  room,
  entries,
  scope,
  laneScope,
  stalled,
  unavailable = false,
  onRetry,
  onScrollToRow,
}: RoomLiveLaneProps) {
  const navigate = useNavigate();
  const claims = useRoomPresenceClaims(room.id, scope);
  const [peekOpen, setPeekOpen] = useState(false);
  const sessions = useRoomSessions(room.id, { enabled: peekOpen });
  const halt = useHaltRoom();
  const agents = useRoomAgentDirectory();
  const authors = useMemo(() => authorsById(room.members), [room.members]);
  const nameOf = useCallback(
    (authorId: string): string => authors.get(authorId)?.displayName ?? UNKNOWN_AGENT,
    [authors]
  );

  const { interactions } = usePendingInteractions();

  // Filtered by ROOM, which is what the event's `roomId` is on it for: a prompt
  // raised by a session bound to this room belongs on this room's lane, whoever
  // happens to be looking at the session it came from.
  const asks = useMemo(
    () => interactions.filter((ask) => ask.roomId === room.id),
    [interactions, room.id]
  );

  // What to CALL the asking agent. The prompt carries ids only, so the roster is
  // joined here — by the author the ledger bound to that session, which is the
  // same join the presence line makes.
  const askAgentNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const ask of asks) {
      if (ask.roomAuthorId === undefined) continue;
      const name = authors.get(ask.roomAuthorId)?.displayName;
      if (name !== undefined) names[ask.sessionId] = name;
    }
    return names;
  }, [asks, authors]);

  const presence = useMemo<LanePresenceAuthor[]>(
    () =>
      claims.map((claim) => ({
        authorId: claim.authorId,
        name: nameOf(claim.authorId),
        state: claim.state,
        since: claim.since,
      })),
    [claims, nameOf]
  );

  const state = useMemo(
    () =>
      deriveLaneState({
        capabilities: ROOM_CAPABILITIES,
        asks,
        agentNames: askAgentNames,
        stalled,
        presence,
        // A room has no turn of its own: `turnStatus` is off in its capability
        // table.
        turn: null,
      }),
    [asks, askAgentNames, presence, stalled]
  );

  const sessionByAuthor = useMemo(() => {
    const map = new Map<string, string>();
    for (const binding of sessions.data?.bindings ?? [])
      map.set(binding.authorId, binding.sessionId);
    return map;
  }, [sessions.data]);

  const excerptOf = useCallback(
    (entryId: string): string | null => {
      const entry = entries.find((candidate) => candidate.id === entryId);
      if (entry === undefined) return null;
      const text = entry.body.text.replace(/\s+/gu, ' ').trim();
      if (text.length === 0) return null;
      return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX).trimEnd()}…` : text;
    },
    [entries]
  );

  /**
   * Which element on screen "replying to …" should take the reader to, or
   * `null` when there is none.
   *
   * **Quotable is not the same as rendered**, which is what made the first
   * version of this a dead control. A room's flow draws top-level entries only
   * (`groupByThread` keeps replies out of it), the panel draws the open thread's
   * rows under their own ids, and on a phone the room column is unmounted while
   * a thread is open — so an entry this host can quote from `entries` may have
   * no row anywhere. Three cases, each answered honestly:
   *
   * - **The thread panel's lane** aims inside the panel, where its own claims
   *   are by construction (its scope is the open thread's replies).
   * - **The room's lane** aims at the flow when the entry is top-level, and at
   *   the "↳ N replies" row of its thread when it is not — which is the truest
   *   place a room can take you for a reply it does not itself draw.
   * - **Anything else** gets no link, and the peek shows the row without one.
   */
  const rowIdFor = useCallback(
    (entryId: string): string | null => {
      if (laneScope === 'thread') return threadPanelRowId(entryId);
      const entry = entries.find((candidate) => candidate.id === entryId);
      if (entry === undefined) return null;
      // `?? null` because `threadRootIdOf` reads two OPTIONAL fields and can
      // answer `undefined` in spite of its `string | null` signature.
      const rootId = threadRootIdOf(entry) ?? null;
      if (rootId === null) return entryRowId(entryId);
      // A reply the room does not draw: offer its thread's own row instead, and
      // only when that root is itself in the flow.
      const root = entries.find((candidate) => candidate.id === rootId);
      if (root === undefined || (threadRootIdOf(root) ?? null) !== null) return null;
      return threadRowId(rootId);
    },
    [entries, laneScope]
  );

  const peekRows = useMemo<LivePeekRow[]>(
    () =>
      claims.map((claim) => {
        const excerpt = excerptOf(claim.entryId);
        const rowId = rowIdFor(claim.entryId);
        return {
          authorId: claim.authorId,
          author: toMessageAuthor(claim.authorId, authors, agents.faces),
          state: claim.state,
          since: claim.since,
          // Both halves or neither: a link with nothing to say and a link with
          // nowhere to go are the same broken promise.
          replyingTo:
            excerpt === null || rowId === null ? null : { entryId: claim.entryId, excerpt, rowId },
          sessionId: sessionByAuthor.get(claim.authorId) ?? null,
        };
      }),
    [claims, authors, agents.faces, excerptOf, rowIdFor, sessionByAuthor]
  );

  const faces = useMemo(() => {
    if (claims.length === 0) return null;
    const shown = claims.slice(0, FACE_LIMIT);
    return (
      <span aria-hidden="true" className="flex shrink-0 -space-x-1">
        {shown.map((claim) => (
          <MessageAuthorAvatar
            key={claim.authorId}
            author={toMessageAuthor(claim.authorId, authors, agents.faces)}
            className="ring-background size-4 ring-2"
          />
        ))}
        {claims.length > FACE_LIMIT && (
          <span className="bg-muted text-muted-foreground ring-background flex size-4 items-center justify-center rounded-full text-[9px] ring-2">
            {`+${claims.length - FACE_LIMIT}`}
          </span>
        )}
      </span>
    );
  }, [claims, authors, agents.faces]);

  return (
    <Conversation.LiveLane
      state={state}
      scope={laneScope}
      onRetry={onRetry}
      unavailable={unavailable}
      faces={faces}
      onPeekOpenChange={setPeekOpen}
      askCard={
        state.kind === 'ask' ? (
          <InteractionAsk
            ask={state.ask}
            {...(askAgentNames[state.ask.sessionId]
              ? { agentName: askAgentNames[state.ask.sessionId] }
              : {})}
            onOpenSession={(sessionId) => {
              void navigate({ to: '/session', search: { session: sessionId } });
            }}
            className="border-l-0"
          />
        ) : undefined
      }
      peek={
        <Conversation.LivePeek
          rows={peekRows}
          onScrollToRow={onScrollToRow}
          onOpenSession={(sessionId) => {
            void navigate({ to: '/session', search: { session: sessionId } });
          }}
          onStopAll={() => halt.mutate({ roomId: room.id })}
          stopping={halt.isPending}
        />
      }
    />
  );
}
