import { appRoutes, cn } from '@/layers/shared/lib';
import { Link } from '@tanstack/react-router';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  communityAccessState,
  remoteDmTitle,
  useCommunityConnections,
  useRemoteCommunityDms,
  useRemoteCommunityRooms,
} from '@/layers/entities/community';

import type { ReactNode } from 'react';
import { CircleAlert, Hash } from 'lucide-react';
import {
  Button,
  CountPill,
  SIDEBAR_FACE,
  SIDEBAR_GLYPH_GAP,
  SIDEBAR_GLYPH_SLOT,
  SIDEBAR_ROW_INSET,
  sidebarRowVariants,
} from '@/layers/shared/ui';
import {
  SIDEBAR_ROW_ATTRIBUTE,
  useIsMobile,
  useRovingFocus,
  useSafeSearch,
} from '@/layers/shared/model';
import { RoomAvatar, RoomTitle } from '@/layers/entities/room';
import { ROW_GLYPH_CLASS } from './row-glyph';
import { directedCountLabel } from './rooms/directed-count-label';

/**
 * A space's group heading: as tall as a local section header (28, or 44 on a
 * phone), so the groups sit as far apart as local sections do.
 */
const SPACE_HEADING_CLASS =
  'text-muted-foreground flex min-h-7 items-center px-1 text-xs font-medium max-md:min-h-11';

/**
 * A space's channel or DM, drawn as a sidebar row.
 *
 * A link rather than `SidebarRow`'s button, so a remote room keeps its address:
 * it can be opened in a new tab or copied like any other. It wears the row's own
 * variants, so its height, tint, ink and focus ring are the local rows' exactly
 * (Phase 4 S13) — where it used to spell the app-wide accent hover and
 * `min-h-9` of its own and drew a bare number on every channel.
 */
function SpaceRowLink({
  link,
  active,
  emphasized,
  glyph,
  children,
  trailing,
}: {
  link: { community: string; id: string };
  active: boolean;
  emphasized: boolean;
  glyph?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  const pointer = useIsMobile() ? 'coarse' : 'fine';
  return (
    <Link
      {...appRoutes.channels()}
      search={link}
      aria-current={active ? 'page' : undefined}
      // The mark the section's roving focus finds its rows by, as `SidebarRow`
      // stamps it: one Tab stop for the space, arrows within it.
      {...{ [SIDEBAR_ROW_ATTRIBUTE]: '' }}
      data-row-state={active ? 'active' : emphasized ? 'emphasized' : 'quiet'}
      className={sidebarRowVariants({
        pointer,
        state: active ? 'active' : emphasized ? 'emphasized' : 'quiet',
      })}
    >
      <span className={cn('flex shrink-0 items-center', SIDEBAR_GLYPH_SLOT)}>{glyph}</span>
      <span className={cn('flex min-w-0 flex-1 items-center gap-1.5', SIDEBAR_GLYPH_GAP)}>
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing}
      </span>
    </Link>
  );
}

/**
 * One line of a space's state — loading, offline, failed, empty — drawn as one
 * static row of the list it stands in for (Card §7, Phase 4 S13).
 *
 * The row's own height, inset and ink, with the words on the label column, so
 * a space that cannot show its channels still reads as part of the panel
 * rather than as a caption under it. A failure carries the error glyph in the
 * glyph slot and a ghost "Try again" at the end. Nothing here is pressable but
 * that button, and nothing moves.
 */
function SpaceStatusRow({
  children,
  failed = false,
  onRetry,
  live = true,
}: {
  children: ReactNode;
  /** Draw the error glyph: something broke, rather than is on its way. */
  failed?: boolean;
  /** Offer "Try again" at the row's end. */
  onRetry?: () => void;
  /** Say it to a screen reader when it changes. A standing fact is not news. */
  live?: boolean;
}) {
  return (
    <div
      {...(live ? { role: 'status' } : {})}
      data-slot="space-status-row"
      className={cn(
        'text-sidebar-foreground/70 text-control flex min-h-7 items-center rounded-md py-1 max-md:min-h-11',
        SIDEBAR_ROW_INSET
      )}
    >
      <span className={cn('flex shrink-0 items-center', SIDEBAR_GLYPH_SLOT)}>
        {failed && (
          <CircleAlert aria-hidden className={cn(ROW_GLYPH_CLASS, 'text-status-error-fg')} />
        )}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', SIDEBAR_GLYPH_GAP)}>{children}</span>
      {onRetry && (
        <Button
          variant="ghost"
          size="xs"
          onClick={onRetry}
          className="text-sidebar-foreground hover:bg-sidebar-accent/70 ml-2 shrink-0"
        >
          Try again
        </Button>
      )}
    </div>
  );
}

/** Remote channels are grouped by community on the shared desktop and mobile library surface. */
export function CommunityChannelGroups() {
  const connections = useCommunityConnections(true);
  const search = useSafeSearch() as { community?: string };
  if (!search.community) return null;
  if (connections.isPending) return <SpaceStatusRow>Loading space…</SpaceStatusRow>;
  if (connections.isError)
    return (
      <SpaceStatusRow failed onRetry={() => void connections.refetch()}>
        Spaces could not be loaded.
      </SpaceStatusRow>
    );
  const connection = connections.data?.find(({ ref }) => ref === search.community);
  if (!connection) return <SpaceStatusRow>This space is no longer connected.</SpaceStatusRow>;
  if (connection.status !== 'connected')
    return <SpaceStatusRow>Reconnect this space to open its channels.</SpaceStatusRow>;
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
  // One Tab stop for the whole space, channels and DMs alike, as every local
  // section has (Phase 4 S13). A 40-channel space was 40 presses.
  const { ref: rovingRef, onKeyDown: onRovingKeyDown } = useRovingFocus();
  const rovingProps = { ref: rovingRef, onKeyDown: onRovingKeyDown };
  return (
    // `max-md:py-3`: the same 24px a local section keeps on a phone (P2).
    <section aria-label={connection.label} className="py-2 max-md:py-3" {...rovingProps}>
      <h3 className={SPACE_HEADING_CLASS}>{connection.label}</h3>
      {/* At most one of these at a time, each one static row (Card §7). */}
      {!access.cacheReadable && (
        <SpaceStatusRow>
          {connection.status === 'reconnect-required'
            ? 'Reconnect to view channels.'
            : 'Channels aren’t available.'}
        </SpaceStatusRow>
      )}
      {access.cacheReadable && !access.verified && <SpaceStatusRow>Saved channels</SpaceStatusRow>}
      {access.verified && rooms.isPending && <SpaceStatusRow>Loading channels…</SpaceStatusRow>}
      {access.verified && rooms.isError && (
        <SpaceStatusRow failed onRetry={() => void rooms.refetch()}>
          Space unavailable.
        </SpaceStatusRow>
      )}
      {rooms.data?.stale && <SpaceStatusRow live={false}>Saved channels · offline</SpaceStatusRow>}
      {rooms.data?.rooms
        .filter((room) => !room.archived)
        .map((room) => {
          // A busy channel is bold with no number, as at home (D2). Its words
          // live in the row's name, so a screen reader hears it too (S11).
          const busy = room.unreadCount !== null && room.unreadCount > 0;
          return (
            <SpaceRowLink
              key={room.roomId}
              link={{ community: connection.ref, id: room.roomId }}
              active={search.community === connection.ref && search.id === room.roomId}
              emphasized={busy}
              glyph={<Hash aria-hidden className={ROW_GLYPH_CLASS} />}
            >
              {/* `RoomTitle`, as a local row: the name reads "#general" to a
                  screen reader while the glyph draws the `#` (S13). A space's
                  `slug` is nullable, and `RoomTitle` only says the `#` for a
                  channel with a slug, so the title stands in for a missing
                  one: a space channel is always spoken "#name". */}
              <RoomTitle
                room={{ kind: room.kind, title: room.title, slug: room.slug ?? room.title }}
              />
              {busy && <span className="sr-only">, new messages</span>}
            </SpaceRowLink>
          );
        })}
      {rooms.data?.rooms.length === 0 && (
        <SpaceStatusRow live={false}>No channels available.</SpaceStatusRow>
      )}
      {access.verified && <CommunityDms connection={connection} />}
    </section>
  );
}

/**
 * The person's direct messages with agents in this space, then the ones someone has with their
 * own agents, read-only (DOR-2955). Nothing at all from a space that holds none.
 */
function CommunityDms({ connection }: { connection: CommunityConnectionDescriptor }) {
  const access = communityAccessState(connection.access);
  const dms = useRemoteCommunityDms(connection.ref, access.capabilities.read, access.fingerprint);
  const search = useSafeSearch() as { community?: string; id?: string };
  if (!dms.data?.available || (dms.data.dms.length === 0 && !dms.data.incomplete)) return null;
  return (
    // The same 16px between groups as between local sections.
    <section className="mt-4" aria-label="Direct messages">
      <h4 className={SPACE_HEADING_CLASS}>Direct messages</h4>
      {dms.data.dms.map((dm) => {
        // A DM is written to you, so it keeps its count, as a pill (D2).
        const unread = !dm.readOnly && dm.unreadCount > 0;
        return (
          <SpaceRowLink
            key={dm.roomId}
            link={{ community: connection.ref, id: dm.roomId }}
            active={search.community === connection.ref && search.id === dm.roomId}
            emphasized={unread}
            // The agent's face, as a local DM row draws it. A space sends no
            // emoji or colour for its agents, so this is `RoomAvatar`'s own
            // fallback: the agent shape, a colour hashed from the member id and
            // the agent's initial.
            glyph={
              <RoomAvatar
                room={{ id: dm.roomId, kind: 'dm', title: dm.agent.displayName }}
                participants={[
                  {
                    id: dm.agent.memberId,
                    kind: 'agent',
                    displayName: dm.agent.displayName,
                    handle: null,
                  },
                ]}
                className={SIDEBAR_FACE}
              />
            }
            trailing={
              unread ? (
                <CountPill
                  count={dm.unreadCount}
                  label={directedCountLabel(dm.unreadCount, 'messages')}
                />
              ) : undefined
            }
          >
            {remoteDmTitle(dm)}
            {dm.readOnly && <span className="text-sidebar-foreground/70"> · read-only</span>}
          </SpaceRowLink>
        );
      })}
      {dms.data.incomplete && (
        <SpaceStatusRow failed>Some direct messages couldn’t load.</SpaceStatusRow>
      )}
    </section>
  );
}
