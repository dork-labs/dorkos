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
  NO_ASKS,
  type LaneScope,
  type LanePresenceAuthor,
  type LivePeekRow,
} from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';
import { authorsById, toMessageAuthor } from '../lib/room-timeline';
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
   * Jump the timeline to an entry and flash it.
   *
   * Interim in P2: the room's list exposes `scrollToRow(rowId, { flash })` and
   * `Conversation.Timeline`'s real handle replaces it in P4 (DOR-1331).
   */
  onScrollToRow?: (entryId: string) => void;
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
        // Rung 1's input lands in P3 (DOR-1330, task 3.8); see `LaneAsk`.
        asks: NO_ASKS,
        stalled,
        presence,
        // A room has no turn of its own and no composer queue: `turnStatus` is
        // off in its capability table, and the queue's source is the
        // `ConversationTarget` P4 introduces.
        turn: null,
        queueDepth: 0,
      }),
    [presence, stalled]
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

  const peekRows = useMemo<LivePeekRow[]>(
    () =>
      claims.map((claim) => {
        const excerpt = excerptOf(claim.entryId);
        return {
          authorId: claim.authorId,
          author: toMessageAuthor(claim.authorId, authors, agents.faces),
          state: claim.state,
          since: claim.since,
          replyingTo: excerpt === null ? null : { entryId: claim.entryId, excerpt },
          sessionId: sessionByAuthor.get(claim.authorId) ?? null,
        };
      }),
    [claims, authors, agents.faces, excerptOf, sessionByAuthor]
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
