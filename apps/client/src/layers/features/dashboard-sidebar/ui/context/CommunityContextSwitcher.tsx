import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronDown, HardDrive, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  communitySettingsPath,
  type CommunitySettingsSection,
} from '@dorkos/shared/community-wire';
import { CommunityInstallationDestinationSchema } from '@dorkos/shared/config-schema';
import {
  communityRefFromRouteDestination,
  getCommunityRouteEpoch,
  useIsMobile,
  useOpenConnections,
  useTransport,
} from '@/layers/shared/model';
import {
  cn,
  getCommunityAuthority,
  isCommunityAuthorityCurrent,
  openExternalLink,
} from '@/layers/shared/lib';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
  focusPageHeading,
  Input,
  SidebarMenuNodes,
  Skeleton,
  TOUCH_TARGET_MIN_H,
  useGuardedMenuNodes,
} from '@/layers/shared/ui';
import {
  useCommunityConnections,
  useCommunityNavigation,
  useMoveCommunityNavigation,
} from '@/layers/entities/community';
import { useHeaderBlockMenu } from './use-header-block-menu';
import {
  buildCommunityContextNodes,
  communityActionAvailability,
  COMMUNITY_DEPLOY_GUIDE_URL,
} from './community-context-actions';
import { DisconnectCommunityDialog, JoinCommunityDialog } from './CommunityActionDialogs';
import { SheetActionsMenu } from './SheetActionsMenu';
import { useSwitchContextShortcut } from '../../model/use-switch-context-shortcut';

/** Props for the route-owned Community context trigger. */
export interface CommunityContextSwitcherProps {
  /** Extra trigger classes supplied by its persistent chrome. */
  triggerClassName?: string;
  /**
   * Draw the trigger as the context's icon instead of its name. The name stays
   * in the trigger's accessible name and in the menu it opens.
   */
  compact?: boolean;
}

/**
 * Notice whether the person presses or types anywhere until stopped.
 *
 * A phone switch to a remote Community can take seconds. Focus moving in that
 * time is not enough to say the person moved it — a composer takes focus on
 * mount by itself — so what counts is their own hand on a key or the screen.
 */
function watchPersonInput(): { acted: () => boolean; stop: () => void } {
  let acted = false;
  const mark = () => {
    acted = true;
  };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('keydown', mark, true);
  return {
    acted: () => acted,
    stop: () => {
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('keydown', mark, true);
    },
  };
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

/**
 * Select the local installation or one owner-authorized Community.
 *
 * The route stays on the old context until the target destination has been
 * reauthorized. A failed request therefore leaves both the old label and old
 * content intact rather than painting a target the app could not enter.
 *
 * The switcher builds and guards its own account rows rather than taking them
 * as props, so no caller can mount it without them or without the DOR-329
 * close-focus guard (Workspace settings and Account both open a dialog that
 * Radix's focus restore would otherwise blur).
 */
export function CommunityContextSwitcher({
  triggerClassName,
  compact = false,
}: CommunityContextSwitcherProps) {
  const transport = useTransport();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const openConnections = useOpenConnections();
  const location = useRouterState({ select: (state) => state.location }) as {
    pathname: string;
    community?: string;
    search: { community?: string; id?: string; thread?: string };
  };
  const search = location.search;
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
  const returnFocus = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /**
   * A phone choice is in flight, so the sheet must not hand focus back to the
   * trigger as it closes: where focus goes is decided when the switch settles
   * ({@link settlePhoneFocus}), and the sheet can close before or after that.
   */
  const holdCloseFocus = useRef(false);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState<CommunityConnectionDescriptor | null>(null);
  const selectedIndex = selectedRef
    ? destinations.findIndex((connection) => connection.ref === selectedRef)
    : -1;

  function openOnCommunity(
    connection: CommunityConnectionDescriptor,
    section?: CommunitySettingsSection
  ) {
    // The descriptor's pinned origin is the only host this connection ever
    // talked to; the page there checks the person's own sign-in and role.
    openExternalLink(
      new URL(
        communitySettingsPath(connection.remoteCommunityId, section),
        connection.pinnedOrigin
      ).toString()
    );
  }

  const contextNodes = buildCommunityContextNodes({
    selected: selected
      ? {
          connection: selected,
          availability: communityActionAvailability(selected),
          canMoveUp: selectedIndex > 0,
          canMoveDown: selectedIndex >= 0 && selectedIndex < destinations.length - 1,
        }
      : null,
    onMove: (direction) => {
      if (selected) moveNavigation.mutate({ ref: selected.ref, direction });
    },
    onInvite: () => selected && openOnCommunity(selected, 'community'),
    onOpenSettings: () => selected && openOnCommunity(selected),
    onLeave: () => selected && openOnCommunity(selected, 'account'),
    onDisconnect: () => setDisconnecting(selected),
    onConnect: () => openConnections('messaging'),
    onJoin: () => setJoinOpen(true),
    onDeploy: () => openExternalLink(COMMUNITY_DEPLOY_GUIDE_URL),
  });
  const menu = useHeaderBlockMenu(contextNodes);
  const guarded = useGuardedMenuNodes(menu.nodes);
  const installationLabel = menu.teamName;
  const installationLabelPending = menu.nameUnknown;
  const targetPending = selectedRef !== undefined && connections.data === undefined;
  const labelPending = selectedRef === undefined ? installationLabelPending : targetPending;
  const label = selectedRef === undefined ? installationLabel : (selected?.label ?? 'Community');
  const visibleDestinations =
    isMobile && destinations.length >= 8 && filter.trim().length > 0
      ? destinations.filter((connection) =>
          connection.label.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
        )
      : destinations;
  // ⌘⇧K from anywhere, a message box included. Where focus was is
  // remembered, so closing without choosing puts it back there ("predictable
  // restore") instead of on a trigger nobody pressed.
  useSwitchContextShortcut((focused) => {
    returnFocus.current = focused;
    setOpen(true);
  });

  /**
   * Put focus where a finished phone choice leaves the person.
   *
   * "Selecting closes the sheet, commits navigation, and moves focus to the
   * new page heading" (spec, Phone and narrow widths). Only a switch that
   * landed moves it there. One that failed or was overtaken lets go of the
   * close hold instead, and if focus has already dropped to the page body
   * with nowhere to be, it goes back to the trigger — what the sheet would
   * have done — but never away from anything the person has since focused.
   * Desktop keeps the popover's own focus return, so this is phone-only.
   *
   * A remote Community can take seconds to answer. If the person has
   * pressed or typed somewhere in that time — the message box, a link — their
   * focus stays where they put it. Focus the app moved by itself (a composer
   * taking it on mount) is not theirs, and the heading still wins over it.
   */
  function settlePhoneFocus(landed: boolean, personActed: boolean) {
    if (!isMobile) return;
    if (!landed) holdCloseFocus.current = false;
    if (personActed) return;
    if (landed) {
      focusPageHeading();
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) trigger.current?.focus();
  }

  async function selectCommunity(connection: CommunityConnectionDescriptor) {
    if (connection.ref === selectedRef || pendingSelection.current) return;
    if (connection.status !== 'connected') {
      openConnections('messaging');
      return;
    }
    const owner = getCommunityAuthority();
    if (owner.ownerKey === null) return;
    const capturedOwner = { epoch: owner.epoch, ownerKey: owner.ownerKey };
    const previousLocation = { pathname: location.pathname, search: location.search };
    // Set before the first await, so it is in place by the time the sheet,
    // closing on this same press, asks where focus should go.
    holdCloseFocus.current = isMobile;
    const person = watchPersonInput();
    pendingSelection.current = true;
    setPendingRef(connection.ref);
    let targetCommitted = false;
    let capturedRoute: ReturnType<typeof getCommunityRouteEpoch> | null = null;
    try {
      await navigate({ to: '/channels', search: { community: connection.ref } });
      targetCommitted = true;
      capturedRoute = getCommunityRouteEpoch();
      const remembered = await transport.resolveCommunityNavigation(connection.ref);
      const fallback = remembered
        ? null
        : ((await transport.listRemoteCommunityRooms(connection.ref)).rooms.find(
            (room) => room.readable && !room.archived
          ) ?? null);
      const roomId = remembered?.roomId ?? fallback?.roomId;
      if (!isCommunityAuthorityCurrent(capturedOwner) || !capturedRoute.isCurrent()) {
        settlePhoneFocus(false, person.acted());
        return;
      }
      if (roomId)
        await navigate({
          to: '/channels',
          search: {
            community: connection.ref,
            ...(roomId ? { id: roomId } : {}),
            ...(remembered?.threadId ? { thread: remembered.threadId } : {}),
          },
        });
      settlePhoneFocus(true, person.acted());
    } catch {
      settlePhoneFocus(false, person.acted());
      // A target may render its labelled skeleton before its remote destination
      // resolves, but a failed read cannot leave it selected. Restore only while
      // this exact route and owner remain current; a newer choice always wins.
      const restore =
        targetCommitted &&
        capturedRoute?.isCurrent() === true &&
        isCommunityAuthorityCurrent(capturedOwner);
      if (restore) {
        const restored = await navigate({
          to: previousLocation.pathname,
          search: previousLocation.search,
          replace: true,
        } as never).then(
          () => true,
          () => false
        );
        // Say so (spec: "announce the failure"): the label snapping back is
        // easy to miss, and a screen reader hears nothing at all. Only once
        // the way back has actually landed, because the message promises it;
        // silent when the person has already chosen somewhere else.
        if (restored)
          toast.error(`Couldn’t open ${connection.label}.`, {
            description: 'You’re still where you were. Try again in a moment.',
          });
      }
    } finally {
      person.stop();
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
    holdCloseFocus.current = isMobile;
    const person = watchPersonInput();
    pendingSelection.current = true;
    try {
      const state = await transport.getCommunityNavigation();
      if (
        state.ownerKey !== capturedOwner.ownerKey ||
        !isCommunityAuthorityCurrent(capturedOwner) ||
        !capturedRoute.isCurrent()
      ) {
        settlePhoneFocus(false, person.acted());
        return;
      }
      const destination = CommunityInstallationDestinationSchema.safeParse(
        state.installationDestination
      );
      await navigate(
        destination.success
          ? ({ to: destination.data.path, search: destination.data.search } as never)
          : { to: '/' }
      );
      settlePhoneFocus(true, person.acted());
    } catch {
      const fallback = isCommunityAuthorityCurrent(capturedOwner) && capturedRoute.isCurrent();
      if (fallback) await navigate({ to: '/' });
      settlePhoneFocus(fallback, person.acted());
    } finally {
      person.stop();
      pendingSelection.current = false;
    }
  }

  function selectDestination(value: string) {
    if (pendingSelection.current) return;
    // A choice moves you somewhere new; the old focus has nothing to return to.
    returnFocus.current = null;
    if (value === 'installation') {
      void selectInstallation();
      return;
    }
    const connection = destinations.find((item) => `community:${item.ref}` === value);
    if (connection) void selectCommunity(connection);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setFilter('');
  }

  function handleCloseAutoFocus(event: Event) {
    guarded.onCloseAutoFocus(event);
    if (holdCloseFocus.current) {
      holdCloseFocus.current = false;
      event.preventDefault();
      return;
    }
    const previous = returnFocus.current;
    returnFocus.current = null;
    if (event.defaultPrevented || !previous?.isConnected) return;
    event.preventDefault();
    previous.focus();
  }

  // "Opening focuses the selected row" (spec, Shell surfaces → Desktop),
  // however it opened. Keyed on `open` rather than done in the change handler,
  // because the ⌘⇧K shortcut opens the menu without going through it, and
  // Radix then leaves focus on the first row. The frame lets Radix finish its
  // own open-focus first.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => selectedItem.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function routeAwayFrom(connection: CommunityConnectionDescriptor) {
    // The connection's content is already erased; leave only if it was the
    // one on screen. Another Community or this DorkOS stays where it was.
    if (communityRefFromRouteDestination(getCommunityRouteEpoch().destination) === connection.ref)
      void navigate({ to: '/', replace: true });
  }

  return (
    <>
      <ResponsiveDropdownMenu open={open} onOpenChange={handleOpenChange}>
        <ResponsiveDropdownMenuTrigger asChild>
          <button
            ref={trigger}
            type="button"
            data-testid="sidebar-header-block"
            aria-label={labelPending ? 'Context menu' : `${label} menu`}
            aria-busy={pendingRef !== null || undefined}
            className={triggerClassName}
          >
            {compact ? (
              selectedRef === undefined ? (
                <HardDrive className="size-4 shrink-0" aria-hidden />
              ) : (
                <UsersRound className="size-4 shrink-0" aria-hidden />
              )
            ) : labelPending ? (
              <Skeleton
                className="my-[3px] h-3.5 w-24 rounded-sm"
                data-testid="sidebar-team-name-skeleton"
              />
            ) : (
              <span className="truncate">{label}</span>
            )}
            <ChevronDown
              className={compact ? 'size-3 shrink-0 opacity-50' : 'size-3.5 shrink-0 opacity-50'}
              aria-hidden
            />
            <span className="sr-only">Choose context</span>
          </button>
        </ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent
          align="start"
          // Fifty communities are taller than any window: the popover stops at
          // the space Radix says is left below the trigger and scrolls, so the
          // last rows stay reachable by pointer and keyboard alike.
          className="max-h-(--radix-dropdown-menu-content-available-height) w-64 overflow-y-auto"
          onCloseAutoFocus={handleCloseAutoFocus}
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
                descriptor.attentionStale && descriptor.unreadCount !== null
                  ? 'last checked'
                  : null,
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
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{connection.label}</span>
                    {mentions > 0 && (
                      <span
                        className="bg-primary text-primary-foreground shrink-0 rounded-full px-1.5 text-xs"
                        aria-label={`${mentions} ${mentions === 1 ? 'mention' : 'mentions'}`}
                      >
                        @{mentions}
                      </span>
                    )}
                    {otherUnread > 0 && (
                      <span
                        className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 text-xs"
                        aria-label={`${otherUnread} other unread`}
                      >
                        {otherUnread}
                      </span>
                    )}
                  </span>
                </ResponsiveDropdownMenuRadioItem>
              );
            })}
          </ResponsiveDropdownMenuRadioGroup>
          {guarded.nodes.length > 0 && (
            <>
              <ResponsiveDropdownMenuSeparator />
              {/* The sheet's action rows are menu items, and a menu item needs a
                  menu around it to be one; the dropdown gets both the role and
                  its arrow keys from Radix, so the sheet supplies its own. */}
              <SheetActionsMenu sheet={isMobile}>
                <SidebarMenuNodes
                  variant={isMobile ? 'sheet' : 'dropdown'}
                  nodes={guarded.nodes}
                  onSheetClose={() => handleOpenChange(false)}
                />
              </SheetActionsMenu>
            </>
          )}
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>
      <JoinCommunityDialog open={joinOpen} onOpenChange={setJoinOpen} />
      <DisconnectCommunityDialog
        connection={disconnecting}
        onOpenChange={(next) => {
          if (!next) setDisconnecting(null);
        }}
        onDisconnected={routeAwayFrom}
      />
    </>
  );
}

/**
 * Persistent phone trigger for the same route-owned context model.
 *
 * **An icon, not a name.** It shares a 390px top bar with the route's own
 * bar, whose tabs and chips have no room to give: at its natural width ("Your
 * team", ~122px) it pushed those chips past the bar's edge on Home, Tasks and
 * Team, and truncated to fit Team it read "Y…", which names nothing. The icon
 * says which kind of place you are in (this DorkOS or a community); the full
 * name is the trigger's accessible name and is checked in the sheet it opens.
 */
export function MobileCommunityContextSwitcher() {
  return (
    <CommunityContextSwitcher
      compact
      triggerClassName={cn(
        'hover:bg-accent focus-visible:ring-ring text-foreground flex shrink-0 items-center rounded-md px-1 py-1.5 outline-hidden focus-visible:ring-2',
        TOUCH_TARGET_MIN_H
      )}
    />
  );
}
