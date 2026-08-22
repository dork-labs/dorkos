/**
 * An agent row's menu, built as data.
 *
 * The rendering half of this file moved to `shared/ui/sidebar-menu-node`, which
 * is the sidebar's ONLY ContextMenu + DropdownMenu implementation. What is left
 * is the model: what an agent row offers, and what each item does.
 *
 * @module features/dashboard-sidebar/ui/AgentRowMenuItems
 */
import {
  Pin,
  PinOff,
  PanelRight,
  Plus,
  FolderInput,
  FolderPlus,
  FolderMinus,
  BellOff,
  Bell,
  MessagesSquare,
  UserRound,
} from 'lucide-react';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { sameSidebarItem } from '@dorkos/shared/config-schema';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  pinItem,
  unpinItem,
  moveToGroup,
  muteItem,
  unmuteItem,
} from '@/layers/entities/config';

/**
 * Single source of truth for an agent row's menu, expressed as data so the
 * right-click ContextMenu and the "⋮" DropdownMenu render the exact same items
 * — no hand-copied second list to drift.
 */
export type RowMenuNode = SidebarMenuNode;

/** Inputs the pure item list is built from (fabricated directly in unit tests). */
export interface RowMenuModel {
  isPinned: boolean;
  /** Whether this agent path is individually muted (`ui.sidebar.muted`). */
  isMuted: boolean;
  currentGroupId: string | null;
  /**
   * The sections this agent can be moved into — MANUAL sections only.
   *
   * A smart section's membership is derived from its rules and its stored
   * `items` is only the convert-to-manual materialization target, so a row filed
   * into one is hidden from its home section and drawn by nobody: it disappears
   * from the sidebar entirely. The drag layer already refuses that drop
   * (`reject-smart-group`); the menu refuses it by not offering it.
   */
  groups: { id: string; name: string }[];
  onTogglePin: () => void;
  /** Toggle this agent's individual mute state. */
  onToggleMute: () => void;
  /**
   * Open the session switcher on this agent — BC-35's third door.
   *
   * BC-35 names three: the row's "N live" chip, ⌘K, and "a long-press on
   * mobile". This is that third one, and it is a menu item rather than a second
   * meaning for the gesture: one press already opens the menu, and a gesture
   * that does two things depending on what it is over is a gesture nobody
   * trusts. On a phone it is also the ONLY door of the three that is there — the
   * chip is a satellite the row stops drawing under a thumb, and ⌘K needs a
   * keyboard.
   */
  onOpenSessions: () => void;
  /**
   * View this agent's profile — the one the row's own face opens on desktop —
   * or `null` when the mesh cannot name it and there is no profile to open.
   *
   * The row used to carry a second, differently-worded item beside this one that
   * opened the right panel instead. There is one profile now and its address
   * decides which home it lands in (spec `profile-unification` §1.6), so a menu
   * offering two words for it was offering a choice that no longer exists.
   *
   * The face is an 18px overlay, which is half a touch target and cannot grow
   * without eating the row's own title, so the row does not draw it under a
   * thumb (`SidebarRow.glyphAction`). This is where the act goes instead, and it
   * is offered on every device rather than only on the one that needs it — a
   * menu that changes its contents with the viewport is a menu whose two
   * renderings cannot be compared.
   */
  onViewProfile: (() => void) | null;
  onNewSession: () => void;
  onMoveToGroup: (groupId: string | null) => void;
  onNewGroup: () => void;
}

/**
 * Build the ordered agent-row menu items from a model. Pure — exported so the
 * item definitions can be asserted directly and shared by every renderer.
 *
 * @param model - Pin/group state plus the action callbacks.
 * @internal Exported for testing and cross-variant rendering.
 */
export function buildRowMenuNodes(model: RowMenuModel): RowMenuNode[] {
  const groupTargets: RowMenuNode[] = model.groups.map((g) => ({
    kind: 'choice',
    id: `group-${g.id}`,
    label: g.name,
    checked: g.id === model.currentGroupId,
    run: () => model.onMoveToGroup(g.id),
  }));

  const moveItems: RowMenuNode[] = [
    ...groupTargets,
    ...(model.currentGroupId !== null
      ? [
          {
            kind: 'action' as const,
            id: 'remove-from-group',
            label: 'Remove from section',
            icon: FolderMinus,
            opensInput: false,
            run: () => model.onMoveToGroup(null),
          },
        ]
      : []),
    { kind: 'separator', id: 'move-sep' },
    {
      kind: 'action',
      id: 'new-group',
      label: 'New section',
      icon: FolderPlus,
      // Earns the ellipsis the renderer appends: it mounts the inline name
      // editor rather than creating anything on the spot — and that is also what
      // arms the menu's close-focus guard (DOR-329).
      opensInput: true,
      run: model.onNewGroup,
    },
  ];

  return [
    {
      kind: 'action',
      id: 'pin',
      label: model.isPinned ? 'Unpin agent' : 'Pin agent',
      icon: model.isPinned ? PinOff : Pin,
      opensInput: false,
      run: model.onTogglePin,
    },
    {
      kind: 'action',
      id: 'mute',
      label: model.isMuted ? 'Unmute agent' : 'Mute agent',
      icon: model.isMuted ? Bell : BellOff,
      opensInput: false,
      run: model.onToggleMute,
    },
    {
      kind: 'submenu',
      id: 'move-to-group',
      label: 'Move to section',
      icon: FolderInput,
      items: moveItems,
    },
    { kind: 'separator', id: 'sep-1' },
    {
      kind: 'action',
      id: 'sessions',
      label: 'Switch session',
      icon: MessagesSquare,
      // Opens the switcher dialog, which is what earns the ellipsis and what
      // arms the close-focus guard: Radix restores focus one commit after the
      // menu closes, and would pull it back out of the dialog (DOR-329).
      opensInput: true,
      run: model.onOpenSessions,
    },
    ...(model.onViewProfile === null
      ? []
      : [
          {
            kind: 'action' as const,
            id: 'view-profile',
            label: 'View profile',
            icon: UserRound,
            // The identity drawer takes focus, so the menu's close-time restore
            // would blur its way out of it — but it asks for nothing, so it
            // earns no `…`. That is the whole difference between these flags.
            guardsFocus: true,
            run: model.onViewProfile,
          },
        ]),
    { kind: 'separator', id: 'sep-2' },
    {
      kind: 'action',
      id: 'new-session',
      label: 'New session',
      icon: Plus,
      opensInput: false,
      run: model.onNewSession,
    },
  ];
}

/** What an agent row's menu needs from its caller — everything the sidebar does not own itself. */
export interface AgentRowMenuParams {
  /** Agent projectPath the menu acts on. */
  path: string;
  /** Open the session switcher on this agent (BC-35's third door). */
  onOpenSessions: () => void;
  /** View the agent's profile, or `null` when the mesh cannot name it. */
  onViewProfile: (() => void) | null;
  /** Start a new session for this agent. */
  onNewSession: () => void;
  /** Open the inline section-create flow, moving this agent into it on commit. */
  onRequestNewGroup: (ref: SidebarItemRef) => void;
}

/**
 * The agent row's menu, wired to `ui.sidebar`.
 *
 * Pin/Unpin, Mute/Unmute and Move-to-section read and mutate the stored sidebar
 * prefs directly (optimistically), so callers only supply the row actions the
 * sidebar does not own.
 *
 * A hook rather than a component: the row primitive takes its menu as a node
 * list, and reading prefs is the only reason this needed a React tree at all.
 *
 * @param params - The agent and the actions its row cannot perform itself.
 */
export function useAgentRowMenuNodes({
  path,
  onOpenSessions,
  onViewProfile,
  onNewSession,
  onRequestNewGroup,
}: AgentRowMenuParams): RowMenuNode[] {
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();

  const ref: SidebarItemRef = { kind: 'agent', path };
  const isPinned = prefs.pinned.some((p) => sameSidebarItem(p, ref));
  const isMuted = prefs.muted.some((m) => sameSidebarItem(m, ref));
  const currentGroupId =
    prefs.groups.find((g) => g.items.some((m) => sameSidebarItem(m, ref)))?.id ?? null;

  return buildRowMenuNodes({
    isPinned,
    isMuted,
    currentGroupId,
    groups: prefs.groups.filter((g) => g.kind !== 'smart').map((g) => ({ id: g.id, name: g.name })),
    onTogglePin: () => update((prev) => (isPinned ? unpinItem(prev, ref) : pinItem(prev, ref))),
    onToggleMute: () => update((prev) => (isMuted ? unmuteItem(prev, ref) : muteItem(prev, ref))),
    onOpenSessions,
    onViewProfile,
    onNewSession,
    onMoveToGroup: (groupId) => update((prev) => moveToGroup(prev, ref, groupId)),
    onNewGroup: () => onRequestNewGroup(ref),
  });
}
