import { useOneBarState } from '../model/one-bar-context';
import { BarTitle, OneBar } from './OneBar';

/**
 * `/channels` route bar — the room you're reading, or the route's own name
 * before the sidebar has put you into one.
 *
 * The room title is read once, in the app shell (`useRoomDocumentTitle`), and
 * reaches this through `useOneBarState` rather than being re-queried here — the
 * same room, resolved the same way (`roomDisplayTitle`) the browser tab already
 * uses, so the two can never disagree about what's open. Without a bar of its
 * own this route fell through to the shell's `default` branch and showed the
 * dashboard's, so every channel and every DM read "Dashboard" while you were
 * reading a room (DOR-587).
 */
export function ChannelsHeader() {
  const { roomTitle } = useOneBarState();
  return <OneBar identity={<BarTitle>{roomTitle ?? 'Channels'}</BarTitle>} />;
}
