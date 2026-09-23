import {
  communityAccessState,
  useCommunityConnections,
  useRemoteCommunityRoom,
} from '@/layers/entities/community';
import { PageHeading } from '@/layers/shared/ui';

/** Props for {@link CommunityPageHeading}. */
export interface CommunityPageHeadingProps {
  /** The Community the route names. */
  community: string;
  /** The channel the route names, if it names one yet. */
  roomId?: string;
}

/**
 * A Community page's heading: which Community, then which channel.
 *
 * "Alpha · General", so a person who just switched hears both halves of where
 * they are — two Communities can each have a General. It reads the same two
 * queries the channel bar reads (`RemoteChannelsBar`), so it costs no request
 * and can never name a different room than the bar does. Until the channel's
 * name arrives, and when the route names no channel, it is the Community alone
 * — marked `pending` while a name is still being fetched, so focus waits for
 * the whole of it (`focusPageHeading`).
 */
export function CommunityPageHeading({ community, roomId }: CommunityPageHeadingProps) {
  const connections = useCommunityConnections();
  const connection = connections.data?.find((item) => item.ref === community);
  const access = communityAccessState(connection?.access);
  const room = useRemoteCommunityRoom(
    community,
    roomId ?? '',
    Boolean(roomId) && access.capabilities.read,
    access.fingerprint
  );
  const label = connection?.label ?? 'Community';
  const title = roomId ? room.data?.title : undefined;
  // Still on its way: a half-name read aloud is the half a person remembers.
  const pending =
    (connection === undefined && connections.fetchStatus === 'fetching') ||
    (roomId !== undefined && title === undefined && room.fetchStatus === 'fetching');
  return <PageHeading pending={pending}>{title ? `${label} · ${title}` : label}</PageHeading>;
}
