/**
 * The context switcher's lifecycle actions, as data.
 *
 * Code calls a space a "community"; every word a person reads here says
 * "space" (spec D6, DOR-2631). The identifiers stay until DOR-2639.
 *
 * Every action goes to the one place that has the authority to do it, and none
 * of them is decided here (spec, "Lifecycle and action routing"):
 *
 * - **This installation's own connection** — connecting, and disconnecting —
 *   is local, so it stays in the DorkOS app.
 * - **Membership and the space's own settings** — inviting, leaving,
 *   changing settings — need the person's own sign-in there (leaving needs
 *   their password), so they open on the space's own site, which checks the
 *   person's role again before showing anything.
 * - **Joining** is one dialog: an address connects this installation, and an
 *   invitation link opens on the space's own site, then the dialog stays on
 *   Connect with the space's address filled in.
 * - **Starting a space, and "Your spaces"** (with moving one here) ask the
 *   person's DorkOS account, through this DorkOS's own server. Those rows exist
 *   only while this DorkOS is linked to an account; unlinked, they are not
 *   drawn at all (community-host-operator-api P5).
 * - **Advanced** keeps the self-run paths out of the way: creating a space on a
 *   server the person runs opens that server's own administration page, only
 *   for a server that just told this installation its person runs it; running
 *   your own server opens the guide.
 *
 * A hidden action is a courtesy, never the check: each destination rechecks.
 *
 * @module features/dashboard-sidebar/ui/context/community-context-actions
 */
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CirclePlus,
  Building2,
  LogIn,
  LogOut,
  Plus,
  Server,
  Settings,
  Sparkles,
  Unplug,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import type { SidebarMenuNode } from '@/layers/shared/ui';

/** Where "Run your own space server" leads: the CLI guide's space server section. */
export const COMMUNITY_DEPLOY_GUIDE_URL = 'https://dorkos.ai/docs/guides/cli-usage#space-server';

/**
 * The servers on which the person may be offered "Create a space": each
 * distinct origin, in the given order, that at least one connection's server
 * just confirmed they run (`hostOperator`, set only on a verified
 * connection). A server that is offline, too old to say, or says no is left out.
 *
 * @param connections - The owner's connections, in switcher order.
 * @returns The hosts' pinned origins, each once.
 */
export function communityCreationOrigins(
  connections: readonly CommunityConnectionDescriptor[]
): string[] {
  const origins: string[] = [];
  for (const connection of connections)
    if (connection.hostOperator === true && !origins.includes(connection.pinnedOrigin))
      origins.push(connection.pinnedOrigin);
  return origins;
}

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
  /** Ask for a space's address or invitation link: the one Join dialog. */
  onJoin: () => void;
  /** Hosts the person runs, from {@link communityCreationOrigins}; empty offers no creation. */
  creationOrigins: readonly string[];
  /** Open one host's administration page, where a community is created. */
  onCreate: (origin: string) => void;
  /** Open the guide to running a community server. */
  onDeploy: () => void;
  /**
   * The entry points for spaces that run on DorkOS, or `null` when this DorkOS
   * is not linked to a DorkOS account (then none of their rows is drawn).
   */
  hosting: {
    onStart: () => void;
    /** Open "Your spaces", which also offers moving one here. */
    onOpenYourSpaces: () => void;
  } | null;
}

function hostName(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Build the switcher's lifecycle rows: the selected space's own actions, then
 * "Add a space".
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
        label: 'Space settings',
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
        label: 'Leave space',
        icon: LogOut,
        // Not drawn as destructive: choosing it only opens the space's own
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
  // Start and Join first: the two things most people come here for. The
  // self-run paths sit behind Advanced, one step away (spec §4).
  const advanced: SidebarMenuNode[] = [
    // One row per server the person runs. With one there is nothing to tell
    // apart, so the row keeps the short name; the server is in its accessible
    // name and its external mark either way.
    ...model.creationOrigins.map((origin): SidebarMenuNode => ({
      kind: 'action',
      id:
        model.creationOrigins.length === 1
          ? 'add-community-create'
          : `add-community-create-${hostName(origin)}`,
      label:
        model.creationOrigins.length === 1
          ? 'Create a space on your server'
          : `Create a space on ${hostName(origin)}`,
      icon: CirclePlus,
      opensInput: true,
      external: { host: hostName(origin) },
      run: () => model.onCreate(origin),
    })),
    {
      kind: 'action',
      id: 'add-community-deploy',
      label: 'Run your own space server',
      icon: BookOpen,
      run: model.onDeploy,
    },
  ];
  const add: SidebarMenuNode[] = [];
  if (model.hosting)
    add.push({
      kind: 'action',
      id: 'add-community-start',
      label: 'Start a space',
      icon: Sparkles,
      opensInput: true,
      run: model.hosting.onStart,
    });
  add.push({
    kind: 'action',
    id: 'add-community-join',
    label: 'Join a space',
    icon: LogIn,
    opensInput: true,
    run: model.onJoin,
  });
  if (model.hosting)
    add.push({
      kind: 'action',
      id: 'add-community-yours',
      label: 'Your spaces',
      icon: Building2,
      guardsFocus: true,
      run: model.hosting.onOpenYourSpaces,
    });
  add.push(
    { kind: 'separator', id: 'add-community-sep-advanced' },
    {
      kind: 'submenu',
      id: 'add-community-advanced',
      label: 'Advanced',
      icon: Server,
      items: advanced,
    }
  );
  nodes.push({
    kind: 'submenu',
    id: 'add-community',
    label: 'Add a space',
    icon: Plus,
    items: add,
  });
  return nodes;
}
