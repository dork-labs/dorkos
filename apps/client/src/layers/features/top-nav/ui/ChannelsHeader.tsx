import { PageHeader } from './PageHeader';

interface ChannelsHeaderProps {
  /** The open room's spoken name (`#general`, or a DM's title), or `null` when none is open. */
  roomTitle: string | null;
}

/**
 * `/channels` route header — the room you're reading, or the route's own name
 * before the sidebar has put you into one.
 *
 * `roomTitle` is read once, in the app shell (`useRoomDocumentTitle`), and
 * handed down rather than re-queried here — the same room, resolved the same
 * way (`roomDisplayTitle`) the browser tab already uses, so the two can never
 * disagree about what's open. Without this case the shell fell through to its
 * `default` branch and showed `DashboardHeader` here, so every channel and
 * every DM read "Dashboard" while you were reading a room (DOR-587).
 */
export function ChannelsHeader({ roomTitle }: ChannelsHeaderProps) {
  return <PageHeader title={roomTitle ?? 'Channels'} />;
}
