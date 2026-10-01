import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronDown, HardDrive, UsersRound } from 'lucide-react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  COMMUNITY_HOST_ADMIN_PATH,
  communitySettingsPath,
  type CommunitySettingsSection,
} from '@dorkos/shared/community-wire';
import {
  communityRefFromRouteDestination,
  getCommunityRouteEpoch,
  useIsMobile,
} from '@/layers/shared/model';
import { cn, formatRelativeTime, openExternalLink } from '@/layers/shared/lib';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
  Input,
  SidebarMenuNodes,
  Skeleton,
  TOUCH_TARGET_MIN_H,
  useGuardedMenuNodes,
} from '@/layers/shared/ui';
import {
  openOwnerNotice,
  useCommunityConnections,
  useCommunityNavigation,
  useMoveCommunityNavigation,
} from '@/layers/entities/community';
import {
  CommunityHostingDialogs,
  useCommunityHostingEntry,
  type CommunityHostingDialog,
} from '@/layers/features/community-hosting';
import { useHeaderBlockMenu } from './use-header-block-menu';
import {
  buildCommunityContextNodes,
  communityActionAvailability,
  communityCreationOrigins,
  COMMUNITY_DEPLOY_GUIDE_URL,
} from './community-context-actions';
import { communityRowState, navigationDescriptor } from './community-row-state';
import { DisconnectCommunityDialog } from './CommunityActionDialogs';
import { ConnectCommunityDialog, type ConnectCommunityRequest } from './ConnectCommunityDialog';
import { SheetActionsMenu } from './SheetActionsMenu';
import { useContextSelection } from './use-context-selection';
import { useSwitchContextShortcut } from '../../model/use-switch-context-shortcut';

/** Props for the route-owned context trigger (this DorkOS, or a space). */
export interface CommunityContextSwitcherProps {
  /** Extra trigger classes supplied by its persistent chrome. */
  triggerClassName?: string;
  /**
   * Draw the trigger as the context's icon instead of its name. The name stays
   * in the trigger's accessible name and in the menu it opens.
   */
  compact?: boolean;
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

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Select the local installation or one owner-authorized space (a "community"
 * in code).
 *
 * The route stays on the old context until the target destination has been
 * reauthorized. A failed request therefore leaves both the old label and old
 * content intact rather than painting a target the app could not enter.
 *
 * The switcher builds and guards its own identity rows rather than taking them
 * as props, so no caller can mount it without them or without the DOR-329
 * close-focus guard (you, the DorkOS account and Settings each open a surface
 * that Radix's focus restore would otherwise blur).
 */
export function CommunityContextSwitcher({
  triggerClassName,
  compact = false,
}: CommunityContextSwitcherProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const selectedRef = useRouterState({
    select: (state) => (state.location.search as { community?: string }).community,
  });
  const navigation = useCommunityNavigation();
  const moveNavigation = useMoveCommunityNavigation();
  const connections = useCommunityConnections();
  const destinations = useMemo(
    () => orderedConnections(connections.data ?? [], navigation.data?.order ?? []),
    [connections.data, navigation.data?.order]
  );
  const selected = destinations.find((connection) => connection.ref === selectedRef) ?? null;
  const selectedItem = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const {
    pendingRef,
    isSelecting,
    holdCloseFocus,
    takeCloseFocusHold,
    selectCommunity,
    selectInstallation,
  } = useContextSelection({ trigger, selectedRef });
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [connectRequest, setConnectRequest] = useState<ConnectCommunityRequest | null>(null);
  const [disconnecting, setDisconnecting] = useState<CommunityConnectionDescriptor | null>(null);
  // Spaces on DorkOS: `null` while this DorkOS is not linked to an account,
  // and then no row is drawn and nothing is asked of the account.
  const hosting = useCommunityHostingEntry();
  const [hostingDialog, setHostingDialog] = useState<CommunityHostingDialog>(null);
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
    onJoin: () => setConnectRequest({ ref: null }),
    creationOrigins: communityCreationOrigins(destinations),
    // The pinned origin again: the only host these connections talked to.
    onCreate: (origin) => openExternalLink(new URL(COMMUNITY_HOST_ADMIN_PATH, origin).toString()),
    onDeploy: () => openExternalLink(COMMUNITY_DEPLOY_GUIDE_URL),
    hosting: hosting
      ? {
          onStart: () => setHostingDialog({ kind: 'start' }),
          onOpenYourSpaces: () => setHostingDialog({ kind: 'hosted' }),
        }
      : null,
  });
  const menu = useHeaderBlockMenu(contextNodes);
  // One guard over both runs of rows, so a row above the destinations and a
  // row below them spend the same one-shot hold.
  const guarded = useGuardedMenuNodes([...menu.identityNodes, ...menu.nodes]);
  const identityNodes = guarded.nodes.slice(0, menu.identityNodes.length);
  const actionNodes = guarded.nodes.slice(menu.identityNodes.length);
  const installationLabel = menu.teamName;
  const installationLabelPending = menu.nameUnknown;
  const targetPending = selectedRef !== undefined && connections.data === undefined;
  const labelPending = selectedRef === undefined ? installationLabelPending : targetPending;
  const label = selectedRef === undefined ? installationLabel : (selected?.label ?? 'Space');
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

  function selectDestination(value: string) {
    if (isSelecting()) return;
    // A choice moves you somewhere new; the old focus has nothing to return to.
    returnFocus.current = null;
    if (value === 'installation') {
      void selectInstallation();
      return;
    }
    const connection = destinations.find((item) => `community:${item.ref}` === value);
    if (!connection) return;
    if (connection.status === 'connected') {
      void selectCommunity(connection);
      return;
    }
    // Still waiting for approval, or needing to be connected again: both are
    // finished in the connect dialog, which takes focus as the menu closes,
    // so the menu must not hand it back to the trigger.
    holdCloseFocus();
    setConnectRequest({ ref: connection.ref });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setFilter('');
  }

  function handleCloseAutoFocus(event: Event) {
    guarded.onCloseAutoFocus(event);
    if (takeCloseFocusHold()) {
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

  // "Done: the new community is selected in the switcher" (spec P5): read the
  // connection list fresh, then select the new one the ordinary way.
  async function selectConnected(ref: string) {
    const fresh = await connections.refetch();
    const connection = fresh.data?.find((c) => c.ref === ref && c.status === 'connected');
    if (connection) await selectCommunity(connection);
  }

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
          {/* On a phone the label is the sheet's title, so it stays first;
              on desktop it heads the destinations, under the identity rows. */}
          {isMobile && <ResponsiveDropdownMenuLabel>Switch context</ResponsiveDropdownMenuLabel>}
          {/* You, your DorkOS account and Settings come first (DOR-2628):
              who you are before where you are. */}
          <SheetActionsMenu sheet={isMobile} label="You">
            <SidebarMenuNodes
              variant={isMobile ? 'sheet' : 'dropdown'}
              nodes={identityNodes}
              onSheetClose={() => handleOpenChange(false)}
            />
          </SheetActionsMenu>
          <ResponsiveDropdownMenuSeparator />
          {!isMobile && <ResponsiveDropdownMenuLabel>Switch context</ResponsiveDropdownMenuLabel>}
          {isMobile && destinations.length >= 8 && (
            <div className="px-4 pb-2">
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Find a space"
                aria-label="Find a space"
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
              const mentions = descriptor.mentionCount ?? 0;
              const otherUnread = Math.max(0, (descriptor.unreadCount ?? 0) - mentions);
              const attention = [
                mentions > 0 ? `${mentions} ${mentions === 1 ? 'mention' : 'mentions'}` : null,
                otherUnread > 0 ? `${otherUnread} other unread` : null,
                // The Community did not answer in time, so these are the last
                // counts it confirmed; say when, rather than pass them off as now.
                connection.attention?.state === 'stale'
                  ? `last checked ${lowerFirst(formatRelativeTime(connection.attention.verifiedAt))}`
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
                    [communityRowState(connection), attention].filter(Boolean).join(' · ') ||
                    undefined
                  }
                  className={pendingRef !== null ? 'opacity-50' : undefined}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{connection.label}</span>
                    {/* Only the owner's connection carries a notice (DOR-2543): the
                        community's page says what it is and what they can do. */}
                    {openOwnerNotice(connection) && (
                      <span
                        role="img"
                        className="bg-status-warning-dot size-2 shrink-0 rounded-full"
                        aria-label="Someone asked to take over this space"
                        title="Someone asked to take over this space"
                      />
                    )}
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
          {actionNodes.length > 0 && (
            <>
              <ResponsiveDropdownMenuSeparator />
              {/* The sheet's action rows are menu items, and a menu item needs a
                  menu around it to be one; the dropdown gets both the role and
                  its arrow keys from Radix, so the sheet supplies its own. */}
              <SheetActionsMenu sheet={isMobile}>
                <SidebarMenuNodes
                  variant={isMobile ? 'sheet' : 'dropdown'}
                  nodes={actionNodes}
                  onSheetClose={() => handleOpenChange(false)}
                />
              </SheetActionsMenu>
            </>
          )}
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>
      <ConnectCommunityDialog
        request={connectRequest}
        onOpenChange={(next) => {
          if (!next) setConnectRequest(null);
        }}
        installName={installationLabelPending ? 'My DorkOS' : installationLabel}
        onConnected={(ref) => void selectConnected(ref)}
      />
      <CommunityHostingDialogs
        entry={hosting}
        dialog={hostingDialog}
        onDialogChange={setHostingDialog}
        installName={installationLabelPending ? 'My DorkOS' : installationLabel}
        onConnected={(ref) => void selectConnected(ref)}
      />
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
