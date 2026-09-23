/**
 * The context switcher's lifecycle actions, as data.
 *
 * Every action goes to the one place that has the authority to do it, and none
 * of them is decided here (spec, "Lifecycle and action routing"):
 *
 * - **This installation's own connection** — connecting, and disconnecting —
 *   is local, so it stays in the DorkOS app.
 * - **Membership and the Community's own settings** — inviting, leaving,
 *   changing settings — need the person's own Community sign-in (leaving needs
 *   their password), so they open on the Community's own site, which checks
 *   the person's role again before showing anything.
 * - **Joining** opens the invitation link the person was sent; **running your
 *   own server** opens the guide. Neither pairs this installation, and neither
 *   creates a Community on a host someone else runs.
 *
 * A hidden action is a courtesy, never the check: each destination rechecks.
 *
 * @module features/dashboard-sidebar/ui/context/community-context-actions
 */
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Link2,
  LogOut,
  Plus,
  Settings,
  Ticket,
  Unplug,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { SidebarMenuNode } from '@/layers/shared/ui';

/** Where "Run your own community" leads: the CLI guide's community server section. */
export const COMMUNITY_DEPLOY_GUIDE_URL =
  'https://dorkos.ai/docs/guides/cli-usage#community-server';

/** What one selected Community allows from this menu, derived from its descriptor. */
export interface CommunityActionAvailability {
  /** Its site answered the last check, so pages on it can open. */
  hostReachable: boolean;
  /** Invitations are possible: connected, active, and reachable. */
  canInvite: boolean;
  /** The Community's settings page can open. */
  canOpenSettings: boolean;
  /** The person can be sent to leave: they are connected through a live membership. */
  canLeave: boolean;
}

/**
 * Decide which host-side actions a Community's descriptor allows.
 *
 * Fail-closed on the descriptor alone: an offline Community (its last check
 * could not reach it) hides every action that needs its site, because those
 * would fail (spec, "Failure and resume behavior": disable network-only
 * actions). Disconnecting is local and is never hidden.
 *
 * @param connection - The selected Community's descriptor.
 */
export function communityActionAvailability(
  connection: CommunityConnectionDescriptor
): CommunityActionAvailability {
  const hostReachable =
    connection.status !== 'pending' && connection.access?.state !== 'unverified';
  const lifecycle = connection.access?.lastKnown?.lifecycle ?? null;
  const connected = connection.status === 'connected';
  return {
    hostReachable,
    canInvite: hostReachable && connected && lifecycle === 'active',
    canOpenSettings: hostReachable,
    canLeave: hostReachable && connected,
  };
}

/** What the builder needs to say what it says. */
export interface CommunityContextActionsModel {
  /** The selected Community and what it allows, or `null` when this DorkOS is selected. */
  selected: {
    connection: CommunityConnectionDescriptor;
    availability: CommunityActionAvailability;
    canMoveUp: boolean;
    canMoveDown: boolean;
  } | null;
  /** Move the selected Community one place in the owner's saved order. */
  onMove: (direction: 'up' | 'down') => void;
  /** Open the selected Community's invite section on its site. */
  onInvite: () => void;
  /** Open the selected Community's settings on its site. */
  onOpenSettings: () => void;
  /** Open the selected Community's leave section on its site. */
  onLeave: () => void;
  /** Ask to disconnect this installation from the selected Community. */
  onDisconnect: () => void;
  /** Go to Connections, where this installation pairs with a Community. */
  onConnect: () => void;
  /** Ask for an invitation link to open. */
  onJoin: () => void;
  /** Open the guide to running a community server. */
  onDeploy: () => void;
}

function hostName(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Build the switcher's lifecycle rows: the selected Community's own actions,
 * then "Add community".
 *
 * @param model - The selection and its handlers.
 */
export function buildCommunityContextNodes(model: CommunityContextActionsModel): SidebarMenuNode[] {
  const nodes: SidebarMenuNode[] = [];
  const selected = model.selected;
  if (selected) {
    const { connection, availability } = selected;
    const items: SidebarMenuNode[] = [];
    // Each row that leaves the app says so on the row itself: a trailing
    // external-link mark, and "opens on <host>" in its accessible name.
    const external = { host: hostName(connection.pinnedOrigin) };
    if (availability.canInvite)
      items.push({
        kind: 'action',
        id: 'community-invite',
        label: 'Invite people',
        icon: UserPlus,
        external,
        run: model.onInvite,
      });
    if (availability.canOpenSettings)
      items.push({
        kind: 'action',
        id: 'community-settings',
        label: 'Community settings',
        icon: Settings,
        external,
        run: model.onOpenSettings,
      });
    if (selected.canMoveUp)
      items.push({
        kind: 'action',
        id: 'community-move-up',
        label: 'Move up',
        icon: ArrowUp,
        run: () => model.onMove('up'),
      });
    if (selected.canMoveDown)
      items.push({
        kind: 'action',
        id: 'community-move-down',
        label: 'Move down',
        icon: ArrowDown,
        run: () => model.onMove('down'),
      });
    items.push({ kind: 'separator', id: 'community-sep-end' });
    items.push({
      kind: 'action',
      id: 'community-disconnect',
      label: 'Disconnect',
      icon: Unplug,
      opensInput: true,
      destructive: true,
      run: model.onDisconnect,
    });
    if (availability.canLeave)
      items.push({
        kind: 'action',
        id: 'community-leave',
        label: 'Leave community',
        icon: LogOut,
        // Not drawn as destructive: choosing it only opens the Community's own
        // page, which asks for the password and confirms before anything ends.
        // The ellipsis says more is asked for; the mark says where.
        opensInput: true,
        external,
        run: model.onLeave,
      });
    nodes.push({
      kind: 'submenu',
      id: 'community-actions',
      label: `Manage ${connection.label}`,
      icon: UsersRound,
      items,
    });
  }
  nodes.push({
    kind: 'submenu',
    id: 'add-community',
    label: 'Add community',
    icon: Plus,
    items: [
      {
        kind: 'action',
        id: 'add-community-connect',
        label: 'Connect a community',
        icon: Link2,
        run: model.onConnect,
      },
      {
        kind: 'action',
        id: 'add-community-join',
        label: 'Join with an invitation',
        icon: Ticket,
        opensInput: true,
        run: model.onJoin,
      },
      {
        kind: 'action',
        id: 'add-community-deploy',
        label: 'Run your own community',
        icon: BookOpen,
        run: model.onDeploy,
      },
    ],
  });
  return nodes;
}
