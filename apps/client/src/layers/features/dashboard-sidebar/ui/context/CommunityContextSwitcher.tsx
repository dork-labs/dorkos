import { useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { ChevronDown, HardDrive, Plus, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useOpenConnections, useTransport } from '@/layers/shared/model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SidebarMenuNodes,
  Skeleton,
} from '@/layers/shared/ui';
import { useCommunityConnections, useCommunityNavigation } from '@/layers/entities/community';

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
  const navigate = useNavigate();
  const openConnections = useOpenConnections();
  const search = useRouterState({ select: (state) => state.location.search }) as {
    community?: string;
  };
  const selectedRef = search.community;
  const navigation = useCommunityNavigation();
  const connections = useCommunityConnections();
  const destinations = useMemo(
    () => orderedConnections(connections.data ?? [], navigation.data?.order ?? []),
    [connections.data, navigation.data?.order]
  );
  const selected = destinations.find((connection) => connection.ref === selectedRef) ?? null;
  const selectedItem = useRef<HTMLDivElement>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const targetPending = selectedRef !== undefined && connections.data === undefined;
  const labelPending = selectedRef === undefined ? installationLabelPending : targetPending;
  const label = selectedRef === undefined ? installationLabel : (selected?.label ?? 'Community');

  async function selectCommunity(connection: CommunityConnectionDescriptor) {
    if (connection.ref === selectedRef || pendingRef !== null) return;
    if (connection.status !== 'connected') {
      openConnections('accounts');
      return;
    }
    setPendingRef(connection.ref);
    try {
      const remembered = await transport.resolveCommunityNavigation(connection.ref);
      const fallback = remembered
        ? null
        : ((await transport.listRemoteCommunityRooms(connection.ref)).rooms.find(
            (room) => room.readable && !room.archived
          ) ?? null);
      const roomId = remembered?.roomId ?? fallback?.roomId;
      await navigate({
        to: '/channels',
        search: {
          community: connection.ref,
          ...(roomId ? { id: roomId } : {}),
          ...(remembered?.threadId ? { thread: remembered.threadId } : {}),
        },
      });
    } catch {
      toast.error(`Couldn’t open ${connection.label}`);
    } finally {
      setPendingRef(null);
    }
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) requestAnimationFrame(() => selectedItem.current?.focus());
      }}
    >
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuLabel>Switch context</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selectedRef ? `community:${selectedRef}` : 'installation'}>
          <DropdownMenuRadioItem
            ref={selectedRef === undefined ? selectedItem : undefined}
            value="installation"
            disabled={pendingRef !== null}
            onSelect={() => {
              if (selectedRef !== undefined) void navigate({ to: '/' });
            }}
          >
            <HardDrive className="mr-2 size-3.5" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{installationLabel}</span>
          </DropdownMenuRadioItem>
          {destinations.map((connection) => (
            <DropdownMenuRadioItem
              key={connection.ref}
              ref={connection.ref === selectedRef ? selectedItem : undefined}
              value={`community:${connection.ref}`}
              disabled={pendingRef !== null}
              onSelect={() => void selectCommunity(connection)}
            >
              <UsersRound className="mr-2 size-3.5" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{connection.label}</span>
              {connection.status !== 'connected' && (
                <span className="text-muted-foreground ml-auto text-[11px]">
                  {connection.status === 'pending' ? 'Pending' : 'Reconnect'}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuItem onSelect={() => openConnections('accounts')}>
          <Plus className="size-3.5" aria-hidden />
          Add community…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SidebarMenuNodes variant="dropdown" nodes={footerNodes} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
