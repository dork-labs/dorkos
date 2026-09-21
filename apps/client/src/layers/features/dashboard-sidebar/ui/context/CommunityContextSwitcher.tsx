import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronDown, HardDrive, Plus, UsersRound } from 'lucide-react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { CommunityInstallationDestinationSchema } from '@dorkos/shared/config-schema';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import {
  getCommunityRouteEpoch,
  useIsMobile,
  useOpenConnections,
  useTransport,
} from '@/layers/shared/model';
import { getCommunityAuthority, isCommunityAuthorityCurrent } from '@/layers/shared/lib';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
  Input,
  SidebarMenuNodes,
  Skeleton,
} from '@/layers/shared/ui';
import {
  useCommunityConnections,
  useCommunityNavigation,
  useMoveCommunityNavigation,
} from '@/layers/entities/community';
import { useTeamRoster } from '@/layers/entities/team';

/** Props for the route-owned Community context trigger. */
export interface CommunityContextSwitcherProps {
  /** The local installation label shown when no Community route is selected. */
  installationLabel: string;
  /** Whether the installation label is still resolving. */
  installationLabelPending: boolean;
  /** Existing account and installation actions shown below the destinations. */
  footerNodes: SidebarMenuNode[];
  /** Preserve focus when a footer action opens a dialog. */
  onCloseAutoFocus: (event: Event) => void;
  /** Extra trigger classes supplied by its persistent chrome. */
  triggerClassName?: string;
}

function installationNameFor(displayName: string | null): string {
  const trimmed = displayName?.trim() ?? '';
  if (trimmed.length === 0 || trimmed === OPERATOR_FALLBACK_DISPLAY_NAME) return 'Your team';
  return trimmed.endsWith('s') ? `${trimmed}’ team` : `${trimmed}’s team`;
}

function orderedConnections(
  connections: readonly CommunityConnectionDescriptor[],
  order: readonly string[]
): CommunityConnectionDescriptor[] {
  const rank = new Map(order.map((ref, index) => [ref, index]));
  return [...connections].sort((left, right) => {
    const leftRank = rank.get(left.ref) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.ref) ?? Number.MAX_SAFE_INTEGER;
    return (
      leftRank - rightRank ||
      left.label.localeCompare(right.label) ||
      left.ref.localeCompare(right.ref)
    );
  });
}

function navigationDescriptor(connection: CommunityConnectionDescriptor) {
  const lifecycle = connection.access?.lastKnown?.lifecycle;
  return {
    kind: 'community',
    key: `community:${connection.ref}`,
    ref: connection.ref,
    remoteCommunityId: connection.remoteCommunityId,
    label: connection.label,
    icon: { kind: 'community', ref: connection.ref },
    pinnedOrigin: connection.pinnedOrigin,
    membershipState:
      lifecycle === 'deletion_pending'
        ? 'deletion-pending'
        : (lifecycle ?? (connection.status === 'pending' ? 'pending' : 'active')),
    connectionState: connection.status,
    availability:
      connection.access?.state === 'verified'
        ? 'online'
        : connection.access?.state === 'unverified'
          ? 'offline'
          : 'unknown',
    unreadCount: connection.attention?.unreadCount ?? null,
    mentionCount: connection.attention?.mentionCount ?? null,
    attentionStale: connection.attention?.state === 'stale',
  };
}

function focusPageHeading() {
  requestAnimationFrame(() => {
    const heading = document.querySelector<HTMLElement>('main h1, [role="main"] h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  });
}

/**
 * Select the local installation or one owner-authorized Community.
 *
 * The route stays on the old context until the target destination has been
 * reauthorized. A failed request therefore leaves both the old label and old
 * content intact rather than painting a target the app could not enter.
 */
export function CommunityContextSwitcher({
  installationLabel,
  installationLabelPending,
  footerNodes,
  onCloseAutoFocus,
  triggerClassName,
}: CommunityContextSwitcherProps) {
  const transport = useTransport();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const openConnections = useOpenConnections();
  const search = useRouterState({ select: (state) => state.location.search }) as {
    community?: string;
  };
  const selectedRef = search.community;
  const navigation = useCommunityNavigation();
  const moveNavigation = useMoveCommunityNavigation();
  const connections = useCommunityConnections();
  const destinations = useMemo(
    () => orderedConnections(connections.data ?? [], navigation.data?.order ?? []),
    [connections.data, navigation.data?.order]
  );
  const selected = destinations.find((connection) => connection.ref === selectedRef) ?? null;
  const selectedItem = useRef<HTMLDivElement>(null);
  const pendingSelection = useRef(false);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const targetPending = selectedRef !== undefined && connections.data === undefined;
  const labelPending = selectedRef === undefined ? installationLabelPending : targetPending;
  const label = selectedRef === undefined ? installationLabel : (selected?.label ?? 'Community');
  const visibleDestinations =
    isMobile && destinations.length >= 8 && filter.trim().length > 0
      ? destinations.filter((connection) =>
          connection.label.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
        )
      : destinations;
  const selectedIndex = selectedRef
    ? destinations.findIndex((connection) => connection.ref === selectedRef)
    : -1;

  useEffect(() => {
    const openSwitcher = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
        const target = event.target as HTMLElement | null;
        if (
          target?.isContentEditable ||
          target?.closest('input, textarea, select, [contenteditable="true"]')
        )
          return;
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', openSwitcher);
    return () => window.removeEventListener('keydown', openSwitcher);
  }, []);

  async function selectCommunity(connection: CommunityConnectionDescriptor) {
    if (connection.ref === selectedRef || pendingSelection.current) return;
    if (connection.status !== 'connected') {
      openConnections('accounts');
      return;
    }
    const owner = getCommunityAuthority();
    if (owner.ownerKey === null) return;
    const capturedOwner = { epoch: owner.epoch, ownerKey: owner.ownerKey };
    pendingSelection.current = true;
    setPendingRef(connection.ref);
    try {
      await navigate({ to: '/channels', search: { community: connection.ref } });
      const capturedRoute = getCommunityRouteEpoch();
      if (isMobile) focusPageHeading();
      const remembered = await transport.resolveCommunityNavigation(connection.ref);
      const fallback = remembered
        ? null
        : ((await transport.listRemoteCommunityRooms(connection.ref)).rooms.find(
            (room) => room.readable && !room.archived
          ) ?? null);
      const roomId = remembered?.roomId ?? fallback?.roomId;
      if (!isCommunityAuthorityCurrent(capturedOwner) || !capturedRoute.isCurrent()) return;
      if (roomId)
        await navigate({
          to: '/channels',
          search: {
            community: connection.ref,
            ...(roomId ? { id: roomId } : {}),
            ...(remembered?.threadId ? { thread: remembered.threadId } : {}),
          },
        });
    } catch {
      // The qualified skeleton and any owner-scoped cache remain usable offline.
    } finally {
      pendingSelection.current = false;
      setPendingRef(null);
    }
  }

  async function selectInstallation() {
    if (selectedRef === undefined || pendingSelection.current) return;
    const owner = getCommunityAuthority();
    if (owner.ownerKey === null) return;
    const capturedOwner = { epoch: owner.epoch, ownerKey: owner.ownerKey };
    const capturedRoute = getCommunityRouteEpoch();
    pendingSelection.current = true;
    try {
      const state = await transport.getCommunityNavigation();
      if (
        state.ownerKey !== capturedOwner.ownerKey ||
        !isCommunityAuthorityCurrent(capturedOwner) ||
        !capturedRoute.isCurrent()
      )
        return;
      const destination = CommunityInstallationDestinationSchema.safeParse(
        state.installationDestination
      );
      await navigate(
        destination.success
          ? ({ to: destination.data.path, search: destination.data.search } as never)
          : { to: '/' }
      );
    } catch {
      if (isCommunityAuthorityCurrent(capturedOwner) && capturedRoute.isCurrent())
        await navigate({ to: '/' });
    } finally {
      pendingSelection.current = false;
    }
  }

  function selectDestination(value: string) {
    if (pendingSelection.current) return;
    if (value === 'installation') {
      void selectInstallation();
      return;
    }
    const connection = destinations.find((item) => `community:${item.ref}` === value);
    if (connection) void selectCommunity(connection);
  }

  return (
    <ResponsiveDropdownMenu
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (open) requestAnimationFrame(() => selectedItem.current?.focus());
        else setFilter('');
      }}
    >
      <ResponsiveDropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="sidebar-header-block"
          aria-label={labelPending ? 'Context menu' : `${label} menu`}
          aria-busy={pendingRef !== null || undefined}
          className={triggerClassName}
        >
          {labelPending ? (
            <Skeleton
              className="my-[3px] h-3.5 w-24 rounded-sm"
              data-testid="sidebar-team-name-skeleton"
            />
          ) : (
            <span className="truncate">{label}</span>
          )}
          <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
          <span className="sr-only">Choose context</span>
        </button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent
        align="start"
        className="w-64"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ResponsiveDropdownMenuLabel>Switch context</ResponsiveDropdownMenuLabel>
        {isMobile && destinations.length >= 8 && (
          <div className="px-4 pb-2">
            <Input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a community"
              aria-label="Find a community"
            />
          </div>
        )}
        <ResponsiveDropdownMenuRadioGroup
          value={selectedRef ? `community:${selectedRef}` : 'installation'}
          onValueChange={selectDestination}
        >
          <ResponsiveDropdownMenuRadioItem
            value="installation"
            icon={HardDrive}
            disabled={pendingRef !== null}
            itemRef={selectedRef === undefined ? selectedItem : undefined}
            className={pendingRef !== null ? 'opacity-50' : undefined}
          >
            <span className="min-w-0 flex-1 truncate">{installationLabel}</span>
          </ResponsiveDropdownMenuRadioItem>
          {visibleDestinations.map((connection) => {
            const descriptor = navigationDescriptor(connection);
            const state =
              descriptor.membershipState !== 'active'
                ? descriptor.membershipState.replace('-', ' ')
                : descriptor.availability !== 'online'
                  ? descriptor.availability
                  : undefined;
            const mentions = descriptor.mentionCount ?? 0;
            const otherUnread = Math.max(0, (descriptor.unreadCount ?? 0) - mentions);
            const attention = [
              mentions > 0 ? `${mentions} ${mentions === 1 ? 'mention' : 'mentions'}` : null,
              otherUnread > 0 ? `${otherUnread} other unread` : null,
              descriptor.attentionStale && descriptor.unreadCount !== null ? 'last checked' : null,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <ResponsiveDropdownMenuRadioItem
                key={connection.ref}
                value={`community:${connection.ref}`}
                icon={UsersRound}
                disabled={pendingRef !== null}
                itemRef={connection.ref === selectedRef ? selectedItem : undefined}
                description={
                  [
                    connection.status === 'reconnect-required' ? 'Reconnect required' : state,
                    attention,
                  ]
                    .filter(Boolean)
                    .join(' · ') || undefined
                }
                className={pendingRef !== null ? 'opacity-50' : undefined}
              >
                <span className="min-w-0 flex-1 truncate">{connection.label}</span>
                {mentions > 0 && (
                  <span
                    className="bg-primary text-primary-foreground rounded-full px-1.5 text-xs"
                    aria-label={`${mentions} ${mentions === 1 ? 'mention' : 'mentions'}`}
                  >
                    @{mentions}
                  </span>
                )}
                {otherUnread > 0 && (
                  <span
                    className="bg-muted text-muted-foreground rounded-full px-1.5 text-xs"
                    aria-label={`${otherUnread} other unread`}
                  >
                    {otherUnread}
                  </span>
                )}
              </ResponsiveDropdownMenuRadioItem>
            );
          })}
        </ResponsiveDropdownMenuRadioGroup>
        {selected && selectedIndex > 0 && (
          <ResponsiveDropdownMenuItem
            icon={ArrowUp}
            onSelect={() => moveNavigation.mutate({ ref: selected.ref, direction: 'up' })}
          >
            Move {selected.label} up
          </ResponsiveDropdownMenuItem>
        )}
        {selected && selectedIndex >= 0 && selectedIndex < destinations.length - 1 && (
          <ResponsiveDropdownMenuItem
            icon={ArrowDown}
            onSelect={() => moveNavigation.mutate({ ref: selected.ref, direction: 'down' })}
          >
            Move {selected.label} down
          </ResponsiveDropdownMenuItem>
        )}
        <ResponsiveDropdownMenuItem icon={Plus} onSelect={() => openConnections('accounts')}>
          Add community…
        </ResponsiveDropdownMenuItem>
        {footerNodes.length > 0 && (
          <>
            <ResponsiveDropdownMenuSeparator />
            <SidebarMenuNodes variant="dropdown" nodes={footerNodes} />
          </>
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}

/** Persistent phone trigger for the same route-owned context model. */
export function MobileCommunityContextSwitcher() {
  const roster = useTeamRoster();
  const self = roster.data?.members.find((member) => member.isSelf) ?? null;
  return (
    <CommunityContextSwitcher
      installationLabel={installationNameFor(self?.displayName ?? null)}
      installationLabelPending={roster.isPending}
      footerNodes={[]}
      onCloseAutoFocus={() => {}}
      triggerClassName="hover:bg-accent focus-visible:ring-ring flex min-w-0 max-w-40 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-semibold outline-hidden focus-visible:ring-2"
    />
  );
}
