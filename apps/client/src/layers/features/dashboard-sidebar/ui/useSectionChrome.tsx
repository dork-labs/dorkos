/**
 * The per-section chrome the model deliberately has no opinion about.
 *
 * `buildLibrarySections` decides which sections exist, what is in them and
 * whether they are folded. It says nothing about the inline field that renames
 * a group, the confirmation that deletes one, or the `+` in the header's
 * corner — those are acts, not membership.
 *
 * They used to live in five section components with five hover treatments and
 * five menu wirings. This is the one place they live now, keyed by section id,
 * so `SidebarSection` can stay a renderer and every section wears the same
 * header.
 *
 * **No section makes anything.** A `+` here is a deep link: it opens the one
 * New menu on the item that matches its section and runs no handler of its own
 * (BC-45). The surfaces those items open are mounted in `NewMenu`, once.
 *
 * @module features/dashboard-sidebar/ui/useSectionChrome
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ListFilter, Plus } from 'lucide-react';
import type { SidebarGroup, SmartGroupRules } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { useIsMobile, SIDEBAR_SECTION_ACTION_ATTRIBUTE } from '@/layers/shared/model';
import {
  SIDEBAR_HOVER_REVEAL,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  SidebarGroupAction,
  SidebarMenu,
  type SidebarMenuNode,
} from '@/layers/shared/ui';
import {
  convertSmartGroupToManual,
  deleteGroup,
  renameGroup,
  setGroupCollapsed,
  setGroupDisplayFilter,
  setGroupMuted,
  setGroupRules,
  setGroupSortMode,
  setSectionCollapsed,
  setSectionDisplayFilter,
  setSectionSortMode,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { hasUnread } from '@/layers/entities/room';
import { persistedSectionId, type SidebarSectionModel } from '../model/build-sidebar-model';
import { useCreateFlowStore, type NewMenuItemId } from '../model/create-flow-store';
import { useMarkRoomsRead } from '../model/use-mark-rooms-read';
import { GroupCreateInput } from './GroupCreateInput';
import {
  buildAgentsHeaderMenuNodes,
  buildChannelsHeaderMenuNodes,
  buildDirectMessagesHeaderMenuNodes,
  buildGroupHeaderMenuNodes,
} from './SectionHeaderMenuItems';
import { SmartGroupRuleDialog } from './SmartGroupRuleDialog';
import { useSidebarChrome } from './SidebarChrome';

/** Longest group name the schema accepts (`SidebarGroupSchema.name`). */
const MAX_GROUP_NAME = 40;

/** Everything a section's header and body need beyond the model. */
export interface SectionChrome {
  /** Its menu, as data, dual-rendered into the "⋮" and the context menu. */
  menuNodes: SidebarMenuNode[];
  /** Whether a `+` sits in the header's top-right corner. */
  hasSectionAction: boolean;
  /** That `+`, and anything it opens inline. */
  action?: ReactNode;
  /** Dialogs the section owns, mounted beside it. */
  dialogs?: ReactNode;
  /** What sits under the rows — an empty state, the inline group-create field. */
  footer?: ReactNode;
  /** A mark drawn right after the label — a smart group's rule glyph. */
  adornment?: ReactNode;
  /** An inline editor that replaces the label while a rename is in progress. */
  editor?: ReactNode;
  /** Fold or unfold this one section. */
  toggleCollapsed: () => void;
}

/**
 * The chrome for one section.
 *
 * Every branch runs every hook — the state for a rename, a delete confirmation
 * and a channel dialog is cheap and unconditional, and the alternative is five
 * components again.
 *
 * @param section - The section the model emitted.
 */
export function useSectionChrome(section: SidebarSectionModel): SectionChrome {
  const chrome = useSidebarChrome();
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const markRoomsRead = useMarkRoomsRead();
  const openNewMenu = useCreateFlowStore((s) => s.openMenu);
  // Touch has no hover, so the `+` is drawn at rest there instead — the same
  // two-other-paths rule the kebab follows (R2, design-system §Hover Pattern
  // Mobile Alternatives).
  const isMobile = useIsMobile();

  const [smartDialogOpen, setSmartDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const groupId = section.id.startsWith('group:') ? section.id.slice('group:'.length) : null;
  const group: SidebarGroup | null =
    groupId === null ? null : (prefs.groups.find((entry) => entry.id === groupId) ?? null);

  useEffect(() => {
    if (!isRenaming) return;
    committedRef.current = false;
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }, [isRenaming]);

  const toggleCollapsed = () => {
    if (groupId !== null) {
      update((prev) => setGroupCollapsed(prev, groupId, !section.collapsed));
      return;
    }
    const stored = persistedSectionId(section.id);
    if (stored === null) return;
    update((prev) => setSectionCollapsed(prev, stored, !section.collapsed));
  };

  // "Mark all … read" means every room of that kind, including the ones filed
  // into a group and drawn somewhere else entirely — so the list it works from
  // is the whole kind, never the section's own rows.
  const unreadIds = useMemo(() => {
    const rooms = [...chrome.roomsById.values()];
    return {
      channels: rooms.filter((room) => room.kind !== 'dm' && hasUnread(room)).map((r) => r.id),
      dms: rooms.filter((room) => room.kind === 'dm' && hasUnread(room)).map((r) => r.id),
    };
  }, [chrome.roomsById]);

  // Built from the ROSTER, with manifests looked up — never from the manifest
  // map's own keys. That map is a separate query and answers `{}` until it
  // lands, so keying off it reports an empty fleet on the first paint and
  // withdraws chrome that should be there (BC-32).
  const smartGroupCandidates = useMemo(
    () =>
      chrome.agentPaths.map((path) => {
        const manifest = chrome.manifests[path] ?? null;
        return {
          projectPath: path,
          runtime: manifest?.runtime ?? 'claude-code',
          namespace: manifest?.namespace ?? null,
          attention: 'inactive' as const,
          lastActivityAt: null,
        };
      }),
    [chrome.agentPaths, chrome.manifests]
  );
  const runtimeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const candidate of smartGroupCandidates) {
      if (!seen.has(candidate.runtime)) {
        seen.set(candidate.runtime, getRuntimeDescriptor(candidate.runtime).label);
      }
    }
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [smartGroupCandidates]);
  const namespaceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const candidate of smartGroupCandidates) {
      if (candidate.namespace) set.add(candidate.namespace);
    }
    return Array.from(set).sort();
  }, [smartGroupCandidates]);

  /**
   * A section's `+`: the deep link into the one New menu, on the item that
   * matches this section (BC-45).
   *
   * Hidden at rest, revealed by hover AND by focus anywhere in the section, and
   * drawn permanently on touch — hover-only chrome is unreachable from a
   * keyboard and does not exist at all on a phone (R2).
   *
   * **It is a roving-focus stop of its own** ({@link SIDEBAR_SECTION_ACTION_ATTRIBUTE}).
   * Before that it was stamped `tabIndex={-1}` with every other focusable in the
   * section and reachable by nothing: New channel, New group message, New agent
   * and New section had a pointer door and no keyboard one. `focus-within` on
   * the section is what makes it visible once arrowing lands on it.
   *
   * @param item - The New-menu item this section's `+` stands for.
   * @param label - What a screen reader hears.
   */
  const deepLinkAction = (item: NewMenuItemId, label: string): ReactNode => (
    <SidebarGroupAction
      {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}
      className={cn(
        SIDEBAR_HOVER_REVEAL,
        // A thumb's target on a 44px header, sitting at its outer edge, with
        // the "⋮" parked inboard of it — the pair the header's own `pr-22`
        // gutter is paying for (P4 AC-4). The primitive's `after:-inset-*`
        // reach is for a 20px control and would overlap this one's neighbour.
        // `h-11 w-11` rather than `size-11`: the primitive already declares
        // `w-5`, and tailwind-merge drops a `size-*` that a later `w-*`
        // conflicts with — leaving a control with a width and no height.
        isMobile ? 'top-0 right-0 h-11 w-11 opacity-100 after:hidden' : 'top-1.5 right-2'
      )}
      aria-label={label}
      onClick={() => openNewMenu(item)}
    >
      <Plus />
    </SidebarGroupAction>
  );

  const groupCreationField =
    chrome.groupCreation === null ? null : (
      <SidebarMenu>
        <GroupCreateInput onCommit={chrome.commitNewGroup} onCancel={chrome.cancelNewGroup} />
      </SidebarMenu>
    );

  const base: SectionChrome = {
    menuNodes: [],
    hasSectionAction: false,
    toggleCollapsed,
  };

  if (section.id === 'pins') {
    // No menu: Pins appears purely because you put something in it, and folding
    // away the shortcuts you hand-made is a control nobody reaches for.
    return base;
  }

  if (section.id === 'channels') {
    return {
      ...base,
      hasSectionAction: true,
      menuNodes: buildChannelsHeaderMenuNodes({
        collapsed: section.collapsed,
        hasUnread: unreadIds.channels.length > 0,
        onMarkAllRead: () => markRoomsRead(unreadIds.channels),
        onToggleCollapsed: toggleCollapsed,
      }),
      action: deepLinkAction('new-channel', 'New channel'),
    };
  }

  if (section.id === 'dms') {
    return {
      ...base,
      hasSectionAction: true,
      menuNodes: buildDirectMessagesHeaderMenuNodes({
        collapsed: section.collapsed,
        hasUnread: unreadIds.dms.length > 0,
        onMarkAllRead: () => markRoomsRead(unreadIds.dms),
        onToggleCollapsed: toggleCollapsed,
      }),
      action: deepLinkAction('new-message', 'New direct message'),
    };
  }

  if (section.id === 'agents') {
    return {
      ...base,
      hasSectionAction: true,
      menuNodes: buildAgentsHeaderMenuNodes({
        sortMode: section.options?.sortMode === 'recent' ? 'recent' : 'name',
        displayFilter: section.options?.displayFilter ?? 'all',
        onSortModeChange: (mode) => update((prev) => setSectionSortMode(prev, 'agents', mode)),
        onDisplayFilterChange: (next) =>
          update((prev) => setSectionDisplayFilter(prev, 'agents', next)),
      }),
      action: deepLinkAction('new-agent', 'New agent'),
      ...(groupCreationField === null ? {} : { footer: groupCreationField }),
    };
  }

  if (group !== null && groupId !== null) {
    const isSmart = group.kind === 'smart';
    const memberPaths = section.rows.flatMap((row) =>
      row.target.kind === 'agent' ? [row.target.path] : []
    );
    const commitRename = () => {
      if (committedRef.current) return;
      committedRef.current = true;
      setIsRenaming(false);
      const trimmed = renameValue.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_GROUP_NAME || trimmed === group.name) return;
      update((prev) => renameGroup(prev, groupId, trimmed));
    };
    const cancelRename = () => {
      committedRef.current = true;
      setIsRenaming(false);
    };
    const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    };
    return {
      ...base,
      ...(isSmart ? { icon: ListFilter } : {}),
      menuNodes: buildGroupHeaderMenuNodes({
        group,
        onRename: () => {
          setRenameValue(group.name);
          setIsRenaming(true);
        },
        onToggleCollapsed: toggleCollapsed,
        onDisplayFilterChange: (filter) =>
          update((prev) =>
            setGroupDisplayFilter(prev, groupId, filter as SidebarGroup['displayFilter'])
          ),
        onSortModeChange: (mode) =>
          update((prev) => setGroupSortMode(prev, groupId, mode as SidebarGroup['sortMode'])),
        onToggleMuted: () => update((prev) => setGroupMuted(prev, groupId, !group.muted)),
        onEditRules: () => setSmartDialogOpen(true),
        onConvertToManual: () =>
          update((prev) =>
            convertSmartGroupToManual(
              prev,
              groupId,
              memberPaths.map((path) => ({ kind: 'agent', path }))
            )
          ),
        onDelete: () => {
          if (section.rows.length === 0) {
            update((prev) => deleteGroup(prev, groupId));
            return;
          }
          setDeleteOpen(true);
        },
      }),
      adornment: isSmart ? (
        <ListFilter
          aria-label="Smart group — membership is rule-based"
          className="size-3 shrink-0"
        />
      ) : undefined,
      editor: isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          maxLength={MAX_GROUP_NAME}
          aria-label="Group name"
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={commitRename}
          // The header is a context-menu trigger and this field sits inside it.
          // Without the stop, right-clicking to paste opened the GROUP menu,
          // which blurred the editor and blur-committed a half-typed name.
          onContextMenu={(event) => event.stopPropagation()}
          className={cn(
            'bg-background text-foreground',
            'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
          )}
        />
      ) : undefined,
      // Information, not disappearance: a group you just made says what to put
      // in it, and a smart group whose rules match nobody says that instead of
      // looking broken.
      footer:
        section.rows.length === 0 ? (
          <p className="text-sidebar-foreground/50 px-3 py-1.5 text-xs italic">
            {isSmart
              ? 'No agents match these rules'
              : 'Drag agents, channels, or conversations here'}
          </p>
        ) : undefined,
      dialogs: (
        <>
          <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete group &ldquo;{group.name}&rdquo;?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its {section.rows.length}{' '}
                  {section.rows.length === 1 ? 'member moves' : 'members move'} back where they came
                  from. Nothing is deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    update((prev) => deleteGroup(prev, groupId));
                    setDeleteOpen(false);
                  }}
                >
                  Delete group
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {isSmart && (
            <SmartGroupRuleDialog
              open={smartDialogOpen}
              onOpenChange={setSmartDialogOpen}
              mode="edit"
              initialName={group.name}
              initialRules={group.rules}
              runtimeOptions={runtimeOptions}
              namespaceOptions={namespaceOptions}
              onSubmit={({ rules }: { rules: SmartGroupRules }) =>
                update((prev) => setGroupRules(prev, groupId, rules))
              }
            />
          )}
        </>
      ),
    };
  }

  // A headerless body — Heads up, Today, Getting started. No chrome at all: a zone
  // that cannot fold has nothing to toggle and nothing to create into.
  return base;
}
