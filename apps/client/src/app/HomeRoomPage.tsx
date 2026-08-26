/**
 * The home tab: your team's room (team-room-home spec D3.2, D3.5).
 *
 * **Why this page sits at the app layer.** It is a composition of two widgets —
 * the room (`widgets/room-view`) and the pinned triage header
 * (`widgets/home`) — and a widget may not import another widget (the FSD layer
 * rule). Composing widgets is the app shell's job, so the composition lives
 * beside it, exactly as `AppShell` composes the banner, dialog and pulse
 * widgets around the router's outlet.
 *
 * @module app/HomeRoomPage
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useSearch } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { Button, Skeleton } from '@/layers/shared/ui';
import {
  useLoadedRoomEntries,
  usePendingPosts,
  useTeamRoom,
  useUnarchiveRoom,
  roomDisplayTitle,
} from '@/layers/entities/room';
import { isComposerField } from '@/layers/features/jump-back-in';
import { usePresenceStrip } from '@/layers/features/presence-strip';
import { RoomSurface } from '@/layers/widgets/room-view';
import {
  FirstOpenSettle,
  HomeQuietState,
  PinnedTriageHeader,
  RoomStarterChips,
} from '@/layers/widgets/home';
import type { HomeSearch } from '@/router';

/** The frame every not-yet-a-room state is drawn in, so they all sit alike. */
function HomeNotice({
  title,
  children,
  action,
}: {
  title: string;
  children: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm">
      <MessagesSquare className="text-muted-foreground/50 size-10" aria-hidden />
      <p className="text-foreground font-medium">{title}</p>
      <p className="max-w-sm">{children}</p>
      {action}
    </div>
  );
}

/**
 * Home is a room, and the room is #team.
 *
 * Everything below the bar is the ordinary room surface — timeline, thread
 * panel, mention picker, the whole `Composer.*` family — reached through a
 * well-known key rather than a URL, so `/channels?id=<team>` still shows the
 * same room drawn by the same component.
 *
 * **Home wears the room's chips in the bar, like every other room.** No surface
 * draws a masthead any more (phase R1): what is running here, the room-wide
 * Stop, and who is in #team are chips beside the Home tab, and the composer's
 * "Message #team…" says which room you are typing into.
 *
 * Two pieces of home-only chrome ride above the feed. The pinned triage header
 * carries what needs answering, and it is mounted OUTSIDE the room's scroller
 * on purpose (`RoomSurfaceProps.aboveTimeline` explains what happens when it is
 * not). The presence strip inside it shows who is working ELSEWHERE: #team is
 * excluded because the room already narrates its own work under the composer,
 * and one agent announced twice, three lines apart, in two different sentences
 * is worse than not announcing it at all.
 *
 * **Two states the room itself has to handle, and one arrival.** A room with
 * nothing in it is day one, and day one is a conversation waiting to start, so
 * the openers sit on the composer (`RoomStarterChips`). A room with a history
 * and nothing needing an answer is a quiet morning, and it says so rather than
 * inventing a recap (`HomeQuietState`). And the day's first look at Home settles
 * in instead of snapping on (`FirstOpenSettle`).
 *
 * **Four honest states before the room.** A cockpit that has not finished
 * loading, a server that has not opened the room yet, a list that could not be
 * read, and a room the owner put away. None of them draws a half-built room,
 * and the archived one does not quietly undo the owner's decision — it offers
 * to, which is a press.
 */
export function HomeRoomPage() {
  const team = useTeamRoom();
  /**
   * Whether the caret is in the room's composer.
   *
   * Lifted to here because the two components that have to agree about it are
   * siblings inside `RoomSurface` — the composer at the bottom, the pinned
   * header at the top — and neither can see the other. On a phone the header
   * uses it to get out of the keyboard's way (spec task 2.7's browser gate
   * measured the composer 129px behind the keyboard with one approval showing).
   */
  const [composerFocused, setComposerFocused] = useState(false);
  /**
   * Take the caret back, so the header can open again.
   *
   * Tapping the condensed line has to dismiss the keyboard, or the full header
   * comes back over a screen that is still short — and blurring is the only way
   * to dismiss a software keyboard from script. The composer's text field
   * publishes itself as a `combobox` (`isComposerField`, the same contract the
   * recents panel matches on), so this can find it without a ref threaded
   * through two widgets, and it refuses to blur anything else.
   *
   * Nothing else is needed: the blur is reported straight back through
   * `onComposerFocusChange`, so the header expands off the state it already
   * reads rather than off a second flag that could disagree with it.
   */
  const expandHeader = useCallback(() => {
    const active = document.activeElement;
    if (isComposerField(active)) (active as HTMLElement).blur();
  }, []);
  // `entry` reaches Home through the team-room redirect: a message-search hit
  // in #team is addressed at `/channels?id=<team>&entry=<seq>`, and this is
  // where that coordinate lands (DOR-687).
  const { thread, entry } = useSearch({ strict: false }) as Partial<HomeSearch>;
  const unarchive = useUnarchiveRoom();
  // The strip speaks for everywhere BUT this room. Nothing is excluded until
  // the room resolves — an id this page does not have yet cannot be named, and
  // the strip is not on screen before then anyway.
  const presence = usePresenceStrip(team.room === null ? [] : [team.room.id]);
  // A cache read of the history the room surface below is already fetching, so
  // this page can tell day one from a quiet morning without a second request.
  // `undefined` until it lands, which is neither — so nothing is claimed yet.
  const entries = useLoadedRoomEntries(team.room?.id ?? null);
  // The words already on their way, which the history does not know about yet.
  // Without this the openers survive the keystroke that sends the first message
  // and only vanish when the server's echo arrives over the stream — so pressing
  // a chip and pressing Enter left a row of "start a conversation" prompts sitting
  // above the conversation you just started, for as long as the round trip took.
  const inFlight = usePendingPosts(team.room?.id ?? null, null);
  const dayOne = entries !== undefined && entries.length === 0 && inFlight.length === 0;

  if (team.status === 'loading') {
    return (
      <div className="flex h-full flex-col" aria-busy>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1" />
      </div>
    );
  }

  if (team.status === 'error') {
    return (
      <HomeNotice
        title="Couldn't load your team room"
        action={
          <Button variant="outline" size="sm" className="mt-2" onClick={team.retry}>
            Try again
          </Button>
        }
      >
        Something went wrong reading your conversations. The room is still there.
      </HomeNotice>
    );
  }

  if (team.status === 'missing') {
    return (
      <HomeNotice title="Your team room isn't open yet">
        DorkOS opens #team when the server starts. If this stays here, restart the server and it
        will be waiting for you.
      </HomeNotice>
    );
  }

  if (team.status === 'archived') {
    const room = team.room;
    return (
      <HomeNotice
        title={`${roomDisplayTitle(room)} is archived`}
        action={
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={unarchive.isPending}
            onClick={() => unarchive.mutate({ roomId: room.id })}
          >
            {unarchive.isPending ? 'Bringing it back…' : 'Bring it back'}
          </Button>
        }
      >
        You put this room away, so Home has nothing to show. Everything said in it is still there.
      </HomeNotice>
    );
  }

  return (
    <FirstOpenSettle>
      <RoomSurface
        roomId={team.room.id}
        threadId={thread}
        entrySeq={entry}
        threadRoute="/"
        offerJumpBackIn
        onComposerFocusChange={setComposerFocused}
        aboveTimeline={
          <>
            <PinnedTriageHeader
              presence={presence}
              composerFocused={composerFocused}
              onExpand={expandHeader}
            />
            {/* Below the header and never beside it: the header speaks when
                something needs answering, and this speaks when nothing does. */}
            <HomeQuietState roomId={team.room.id} presenceOccupied={presence.occupied} />
          </>
        }
        // Day one only. The room's first real message takes them away, because
        // an opener offered under a conversation already underway is noise.
        aboveComposer={dayOne ? <RoomStarterChips roomId={team.room.id} /> : undefined}
      />
    </FirstOpenSettle>
  );
}
