/**
 * The sidebar's only create surface.
 *
 * Making a thing used to be scattered across three menus and four `+` buttons,
 * each with its own handler, its own wording and its own dialog mount — so the
 * answer to "how do I start a conversation with somebody" depended on which
 * section happened to be on screen. There is one answer now: this menu (BC-45,
 * design-decisions §7).
 *
 * **Every create surface in the sidebar is mounted here**, and nowhere else:
 * the channel dialog, the direct-message picker, the agent-creation store, the
 * smart-group rule form. A Library section's hover `+` runs no handler of its
 * own — it calls `openMenu(id)` on the create-flow store, which opens *this*
 * menu on the matching item. `one-create-surface.test.ts` is the guard that
 * keeps it that way.
 *
 * @module features/dashboard-sidebar/ui/NewMenu
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AtSign, Bot, CornerDownLeft, Hash, MessageSquarePlus, Plus, Users } from 'lucide-react';
import type { SmartGroupRules } from '@dorkos/shared/config-schema';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { cn, formatShortcutKey, isDesktopShell, SHORTCUTS } from '@/layers/shared/lib';
import { useAgentCreationStore, useIsMobile } from '@/layers/shared/model';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  SidebarMenuNodes,
  TOUCH_TARGET_MIN_H,
  useGuardedMenuNodes,
  type SidebarMenuNode,
} from '@/layers/shared/ui';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { useResolvedAgents } from '@/layers/entities/agent';
import { createSmartGroup, useUpdateSidebarPrefs } from '@/layers/entities/config';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { directMessageTitle, useStartDirectMessage } from '@/layers/entities/room';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { useDirectoryState, useStartNewSession } from '@/layers/entities/session';
import {
  ChannelCreateDialog,
  NewDirectMessageMenu,
  opensAgentSession,
} from '@/layers/features/room-management';
import { useCreateFlowStore, type NewMenuItemId } from '../model/create-flow-store';
import { offersGroupAffordances } from '../model/rules/build-library-sections';
import {
  activeNowPreset,
  byRuntimePresets,
  type SmartGroupPreset,
} from '../model/smart-group-presets';
import { useLastUsedAgent } from '../model/use-last-used-agent';
import { useNewSessionShortcut } from '../model/use-new-session-shortcut';
import { SmartGroupRuleDialog } from './SmartGroupRuleDialog';

/** What {@link buildNewMenuNodes} needs to say what each item does. */
export interface NewMenuModel {
  /** Start a fresh conversation with the last-used agent. */
  onNewSession: () => void;
  /** The name the Session note line promises `↵` will start with, or `null`. */
  lastUsedAgentName: string | null;
  /** Open the channel-create dialog. */
  onNewChannel: () => void;
  /** Open the picker that starts a direct message. */
  onNewMessage: () => void;
  /** Open the create-agent dialog. */
  onNewAgent: () => void;
  /**
   * Start the inline section editor.
   *
   * **Offered to everybody** (D3). It used to be absent below eight agents or
   * two runtimes, on the reasoning that a small fleet has nothing to file — but
   * a section holds channels and conversations too, and somebody with three
   * agents still has a project's channel, its conversation and its agent to put
   * together. The threshold that remains gates the SMART presets below, which
   * really are about a fleet.
   */
  onNewGroup: () => void;
  /**
   * Smart-section presets, one click each (DOR-338).
   *
   * Empty for a small fleet, which is what withdraws the presets and the
   * `Custom rules` entry from the submenu — the one gate
   * `offersGroupAffordances` still keeps.
   */
  smartGroupPresets: SmartGroupPreset[];
  /** Make a smart group from one preset's rules. */
  onCreatePresetSmartGroup: (preset: SmartGroupPreset) => void;
  /** Open the rule form for a smart group built from scratch. */
  onOpenSmartGroupDialog: () => void;
  /** Whether `⌘N` is a key this surface can actually honour. */
  showSessionShortcut: boolean;
}

/**
 * The New menu, as data.
 *
 * Pure and exported so the item vocabulary can be asserted directly — these ids
 * are the contract AC-7 checks the rest of the sidebar against.
 *
 * @param model - What each item does, and which of them exist here.
 */
export function buildNewMenuNodes(model: NewMenuModel): SidebarMenuNode[] {
  // The rule half — presets and the rule form — appears only for a fleet big
  // enough for rules to mean anything.
  const smartItems: SidebarMenuNode[] =
    model.smartGroupPresets.length === 0
      ? []
      : [
          { kind: 'separator', id: 'sep-smart' },
          ...model.smartGroupPresets.map(
            (preset): SidebarMenuNode => ({
              kind: 'action',
              id: `new-group-preset:${preset.label}`,
              label: preset.label,
              icon: Users,
              opensInput: false,
              run: () => model.onCreatePresetSmartGroup(preset),
            })
          ),
          {
            kind: 'action',
            id: 'new-group-custom',
            label: 'Custom rules',
            icon: Users,
            opensInput: true,
            run: model.onOpenSmartGroupDialog,
          },
        ];
  // **A submenu only when there is a choice to make.** A section is made two
  // ways — by hand, or from rules (DOR-338) — and a small fleet is offered only
  // the first, so wrapping it costs a keystroke and an arrow to reach a list of
  // one. Below the threshold the item IS "Section…", and it opens the name
  // field directly.
  //
  // **The id stays `new-group` either way**: it is the deep-link token a
  // section's `+` opens the menu on and the vocabulary
  // `one-create-surface.test.ts` asserts. Only the words changed (D3).
  const groupItem: SidebarMenuNode[] = [
    smartItems.length === 0
      ? {
          kind: 'action',
          id: 'new-group' satisfies NewMenuItemId,
          label: 'Section',
          icon: Users,
          opensInput: true,
          run: model.onNewGroup,
        }
      : {
          kind: 'submenu',
          id: 'new-group' satisfies NewMenuItemId,
          label: 'Section',
          icon: Users,
          items: [
            {
              kind: 'action',
              id: 'new-group-empty',
              label: 'Empty section',
              icon: Users,
              opensInput: true,
              run: model.onNewGroup,
            },
            ...smartItems,
          ],
        },
  ];

  return [
    {
      kind: 'action',
      id: 'new-session' satisfies NewMenuItemId,
      label: 'Session',
      icon: MessageSquarePlus,
      opensInput: false,
      ...(model.showSessionShortcut ? { hint: formatShortcutKey(SHORTCUTS.NEW_SESSION) } : {}),
      run: model.onNewSession,
    },
    // Not an item: the promise `↵` makes, spelled out under the thing that
    // makes it. Absent when no agent can be named, because "starts with
    // (unknown)" is worse than silence.
    ...(model.lastUsedAgentName === null
      ? []
      : [
          {
            kind: 'note' as const,
            id: 'new-session-note',
            icon: CornerDownLeft,
            text: `Starts with ${model.lastUsedAgentName} (last used)`,
          },
        ]),
    { kind: 'separator', id: 'sep-rooms' },
    {
      kind: 'action',
      id: 'new-channel' satisfies NewMenuItemId,
      label: 'Channel',
      icon: Hash,
      opensInput: true,
      run: model.onNewChannel,
    },
    {
      kind: 'action',
      id: 'new-message' satisfies NewMenuItemId,
      // "Group message", because that is what this item makes now: picking one
      // agent in the panel it opens goes to that agent's session instead
      // (`sidebar-simplification` D2). The id does not move with the label —
      // `NEW_MENU_ITEM_IDS` is what the Direct messages header's "+" deep-links
      // to, and renaming a thing is not renaming its address.
      label: 'Group message',
      icon: AtSign,
      opensInput: true,
      run: model.onNewMessage,
    },
    { kind: 'separator', id: 'sep-agents' },
    {
      kind: 'action',
      id: 'new-agent' satisfies NewMenuItemId,
      label: 'Agent',
      icon: Bot,
      opensInput: true,
      run: model.onNewAgent,
    },
    ...groupItem,
  ];
}

/**
 * The "New" button, its menu, and every surface behind it.
 *
 * Mounted by the header block, which is persistent chrome — so the way to make
 * something survives a marketplace `sidebar.body` takeover, exactly as the
 * panel's navigation always has.
 */
export function NewMenu() {
  const isMobile = useIsMobile();
  const open = useCreateFlowStore((s) => s.menuOpen);
  const preselect = useCreateFlowStore((s) => s.preselect);
  const setMenuOpen = useCreateFlowStore((s) => s.setMenuOpen);
  const requestNewGroup = useCreateFlowStore((s) => s.requestNewGroup);

  const navigate = useNavigate();
  const startNewSession = useStartNewSession();
  const [, setDirectory] = useDirectoryState();
  const startDirectMessage = useStartDirectMessage();
  const lastUsedAgent = useLastUsedAgent();
  const { update } = useUpdateSidebarPrefs();

  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [smartDialogOpen, setSmartDialogOpen] = useState(false);

  const { data: meshData } = useMeshAgentPaths();
  const agentPaths = useMemo(
    () => (meshData?.agents ?? []).map((entry) => entry.projectPath),
    [meshData]
  );
  const { data: manifests } = useResolvedAgents(agentPaths);
  // Built from the ROSTER with manifests looked up, never from the manifest
  // map's keys: that map is a separate query and answers `{}` until it lands,
  // so keying off it reports an empty fleet on the first paint and withdraws
  // chrome that should be there (BC-32 — the trap `useSectionChrome` names).
  const candidates = useMemo(
    () =>
      agentPaths.map((path) => ({
        projectPath: path,
        runtime: manifests?.[path]?.runtime ?? 'claude-code',
        namespace: manifests?.[path]?.namespace ?? null,
        attention: 'inactive' as const,
        lastActivityAt: null,
      })),
    [agentPaths, manifests]
  );
  const offersGroups = offersGroupAffordances(candidates);

  const smartGroupPresets = useMemo<SmartGroupPreset[]>(
    () => (offersGroups ? [activeNowPreset(), ...byRuntimePresets(candidates)] : []),
    [candidates, offersGroups]
  );

  const runtimeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const candidate of candidates) {
      if (!seen.has(candidate.runtime)) {
        seen.set(candidate.runtime, getRuntimeDescriptor(candidate.runtime).label);
      }
    }
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [candidates]);
  const namespaceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.namespace) set.add(candidate.namespace);
    }
    return Array.from(set).sort();
  }, [candidates]);

  const createSmartGroupFrom = useCallback(
    (name: string, rules: SmartGroupRules) =>
      update((prev) => createSmartGroup(prev, name, rules).next),
    [update]
  );

  const openRoom = useCallback(
    (room: RoomWithRoster) => {
      useInteractionStore.getState().recordOpened('room', room.id);
      void navigate({ to: '/channels', search: { id: room.id } });
    },
    [navigate]
  );

  const newSession = useCallback(
    () => startNewSession(lastUsedAgent?.path),
    [lastUsedAgent, startNewSession]
  );

  useNewSessionShortcut(newSession);

  const startConversationWith = useCallback(
    (chosen: AgentPickerCandidate[]) => {
      // **One door to an agent** (`sidebar-simplification` D2). One agent opens
      // its session — the same conversation its sidebar row opens, resolved by
      // the same resolve-or-mint lookup — because a 1:1 direct message was that
      // session in disguise. The rule is read from `lib/one-door`, which is also
      // what the button says, so the words and the destination cannot drift.
      const [only] = chosen;
      if (only !== undefined && opensAgentSession(chosen)) {
        setDirectory(only.agentPath, {
          onOpened: () => useInteractionStore.getState().recordOpened('agent', only.agentPath),
        });
        return;
      }
      const title = directMessageTitle(chosen.map((candidate) => candidate.displayName));
      // **No `onError` here, and that is the fix rather than an omission**
      // (DOR-1391). A per-call callback is dispatched only while this component
      // still has listeners, so closing the sidebar sheet on a phone while the
      // request was in flight meant nobody was ever told it failed. The
      // mutation reports its own failures now (`useStartDirectMessage`'s
      // `meta.errorLabel`), which runs on the mutation itself and always
      // arrives. `onSuccess` stays: opening the room is this surface's job and
      // there is nothing to open if the caller has gone.
      startDirectMessage.mutate(
        { agentPaths: chosen.map((candidate) => candidate.agentPath), title },
        { onSuccess: openRoom }
      );
    },
    [openRoom, setDirectory, startDirectMessage]
  );

  const nodes = buildNewMenuNodes({
    onNewSession: newSession,
    lastUsedAgentName: lastUsedAgent?.displayName ?? null,
    onNewChannel: () => setChannelDialogOpen(true),
    onNewMessage: () => setPickerOpen(true),
    onNewAgent: () => useAgentCreationStore.getState().open(),
    onNewGroup: () => requestNewGroup(),
    smartGroupPresets,
    onCreatePresetSmartGroup: (preset) => createSmartGroupFrom(preset.label, preset.rules),
    onOpenSmartGroupDialog: () => setSmartDialogOpen(true),
    showSessionShortcut: isDesktopShell(),
  });

  // Every item here that opens a dialog, a picker or the inline group editor
  // needs the close-focus guard: Radix's focus restore lands after the item has
  // run and would blur what it just opened (DOR-329). The browser suite caught
  // this — "Agent group ▸ Empty group" mounted the name field and lost it to
  // the restore one commit later, with nothing logged.
  const guarded = useGuardedMenuNodes(nodes);

  const contentRef = useRef<HTMLDivElement>(null);

  // The deep link, landed. A section's `+` asked for this menu ON an item, so
  // once the content is up that item takes focus instead of the first row and
  // `↵` runs the thing the `+` sat next to. It happens after the frame Radix
  // mounts the content in, because its own roving-focus group claims focus
  // first and would otherwise win.
  useEffect(() => {
    if (!open || preselect === null) return;
    const frame = requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLElement>(`[data-menu-item-id="${preselect}"]`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, preselect]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="sidebar-new-button"
            className={cn(
              'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent/70 focus-visible:ring-sidebar-ring flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium outline-hidden transition-colors duration-150 focus-visible:ring-2',
              // 27px measured at 390×844 — the smallest control in the phone's
              // Home tab, and the one it exists to be pressed (P4 AC-4).
              isMobile && cn(TOUCH_TARGET_MIN_H, 'px-3')
            )}
          >
            <Plus className="size-3.5" />
            New
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          ref={contentRef}
          align="end"
          className="w-56"
          onCloseAutoFocus={guarded.onCloseAutoFocus}
        >
          <SidebarMenuNodes variant="dropdown" nodes={guarded.nodes} />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Mounted only while open, so a half-typed name and a half-picked roster
          are forgotten between attempts rather than waiting there next time. */}
      {channelDialogOpen && (
        <ChannelCreateDialog
          open
          onOpenChange={(next) => !next && setChannelDialogOpen(false)}
          onCreated={openRoom}
        />
      )}
      <NewDirectMessageMenu
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onStart={startConversationWith}
        hideTrigger
      />
      <SmartGroupRuleDialog
        open={smartDialogOpen}
        onOpenChange={setSmartDialogOpen}
        mode="create"
        runtimeOptions={runtimeOptions}
        namespaceOptions={namespaceOptions}
        onSubmit={({ name, rules }: { name: string; rules: SmartGroupRules }) =>
          createSmartGroupFrom(name, rules)
        }
      />
    </>
  );
}
