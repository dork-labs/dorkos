import { Link } from '@tanstack/react-router';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  communityAccessState,
  useCommunityConnections,
  useRemoteCommunityRooms,
} from '@/layers/entities/community';

import { Button } from '@/layers/shared/ui';
import { useSafeSearch } from '@/layers/shared/model';

/** Remote channels are grouped by community on the shared desktop and mobile library surface. */
export function CommunityChannelGroups() {
  const connections = useCommunityConnections(true);
  const search = useSafeSearch() as { community?: string };
  if (!search.community) return null;
  if (connections.isPending)
    return (
      <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
        Loading community…
      </p>
    );
  if (connections.isError)
    return (
      <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
        Communities could not be loaded.{' '}
        <Button variant="ghost" size="sm" onClick={() => void connections.refetch()}>
          Retry
        </Button>
      </p>
    );
  const connection = connections.data?.find(({ ref }) => ref === search.community);
  if (!connection)
    return (
      <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
        This community is no longer connected.
      </p>
    );
  if (connection.status !== 'connected')
    return (
      <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
        Reconnect this community to open its channels.
      </p>
    );
  return <CommunityChannels connection={connection} />;
}

function CommunityChannels({ connection }: { connection: CommunityConnectionDescriptor }) {
  const access = communityAccessState(connection.access);
  const rooms = useRemoteCommunityRooms(
    connection.ref,
    access.capabilities.read,
    access.fingerprint
  );
  const search = useSafeSearch() as { community?: string; id?: string };
  return (
    <section aria-label={connection.label} className="px-2 py-2">
      <h3 className="text-muted-foreground px-2 text-xs font-medium">{connection.label}</h3>
      {!access.cacheReadable && (
        <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
          {connection.status === 'reconnect-required'
            ? 'Reconnect to view channels.'
            : 'Channel access is unavailable.'}
        </p>
      )}
      {access.cacheReadable && !access.verified && (
        <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
          Saved channels
        </p>
      )}
      {access.verified && rooms.isPending && (
        <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
          Loading channels…
        </p>
      )}
      {access.verified && rooms.isError && (
        <p role="status" className="text-muted-foreground px-2 py-1 text-xs">
          Community unavailable.{' '}
          <Button variant="ghost" size="sm" onClick={() => void rooms.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {rooms.data?.stale && (
        <p className="text-muted-foreground px-2 text-xs">Saved channels · offline</p>
      )}
      {rooms.data?.rooms
        .filter((room) => !room.archived)
        .map((room) => (
          <Link
            key={room.roomId}
            to="/channels"
            search={{ community: connection.ref, id: room.roomId }}
            aria-current={
              search.community === connection.ref && search.id === room.roomId ? 'page' : undefined
            }
            className="hover:bg-accent aria-[current=page]:bg-accent flex min-h-9 items-center justify-between gap-2 rounded-md px-2 py-1 text-sm"
          >
            <span className="truncate">#{room.slug ?? room.title}</span>
            {room.unreadCount !== null && room.unreadCount > 0 && (
              <span
                className="text-muted-foreground text-xs"
                aria-label={`${room.unreadCount} unread messages`}
              >
                {room.unreadCount}
              </span>
            )}
          </Link>
        ))}
      {rooms.data?.rooms.length === 0 && (
        <p className="text-muted-foreground px-2 py-1 text-xs">No channels available.</p>
      )}
    </section>
  );
}
