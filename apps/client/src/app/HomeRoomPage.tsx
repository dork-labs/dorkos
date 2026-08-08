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
import type { ReactNode } from 'react';
import { useSearch } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { Button, Skeleton } from '@/layers/shared/ui';
import { useTeamRoom, useUnarchiveRoom, roomDisplayTitle } from '@/layers/entities/room';
import { usePresenceStrip } from '@/layers/features/presence-strip';
import { RoomSurface } from '@/layers/widgets/room-view';
import { PinnedTriageHeader } from '@/layers/widgets/home';
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
 * Everything below the tab bar is the ordinary room surface — timeline, thread
 * panel, mention picker, halt, the whole `Composer.*` family — reached through
 * a well-known key rather than a URL, so `/channels?id=<team>` still shows the
 * same room drawn by the same component.
 *
 * Two pieces of home-only chrome ride above the feed. The pinned triage header
 * carries what needs answering, and it is mounted OUTSIDE the room's scroller
 * on purpose (`RoomSurfaceProps.aboveTimeline` explains what happens when it is
 * not). The presence strip inside it shows who is working ELSEWHERE: #team is
 * excluded because the room already narrates its own work under the composer,
 * and one agent announced twice, three lines apart, in two different sentences
 * is worse than not announcing it at all.
 *
 * **Four honest states before the room.** A cockpit that has not finished
 * loading, a server that has not opened the room yet, a list that could not be
 * read, and a room the owner put away. None of them draws a half-built room,
 * and the archived one does not quietly undo the owner's decision — it offers
 * to, which is a press.
 */
export function HomeRoomPage() {
  const team = useTeamRoom();
  const { thread } = useSearch({ strict: false }) as Partial<HomeSearch>;
  const unarchive = useUnarchiveRoom();
  // The strip speaks for everywhere BUT this room. Nothing is excluded until
  // the room resolves — an id this page does not have yet cannot be named, and
  // the strip is not on screen before then anyway.
  const presence = usePresenceStrip(team.room === null ? [] : [team.room.id]);

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
    <RoomSurface
      roomId={team.room.id}
      threadId={thread}
      threadRoute="/"
      offerJumpBackIn
      aboveTimeline={<PinnedTriageHeader presence={presence} />}
    />
  );
}
