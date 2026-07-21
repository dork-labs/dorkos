import { useState, useRef, useEffect, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  ArrowUpDown,
  Trash2,
  BellOff,
  Bell,
  ListFilter,
  Wand2,
  Users,
} from 'lucide-react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import { describeRules } from '../model/evaluate-smart-group';
import type { RuntimeOption } from './SmartGroupRuleDialog';
import { SmartGroupRuleDialog } from './SmartGroupRuleDialog';
import { cn } from '@/layers/shared/lib';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/layers/shared/ui';
import {
  useUpdateSidebarPrefs,
  renameGroup,
  deleteGroup,
  setGroupSortMode,
  setGroupCollapsed,
  setGroupDisplayFilter,
  setGroupMuted,
  setGroupRules,
  convertSmartGroupToManual,
} from '@/layers/entities/config';
import { useMenuCloseFocusGuard } from '../model/use-menu-close-focus-guard';
import { renderDisplayFilterSubmenu } from './DisplayFilterMenu';

/** Maximum group-name length (matches `SidebarGroupSchema.name`). */
const MAX_NAME = 40;

/** Selectable per-group sort modes, in menu order. */
const SORT_OPTIONS: { value: SidebarGroup['sortMode']; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name' },
];

/** Slot primitives so the "…" dropdown and right-click menu render one item list. */
interface GroupMenuSlots {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
  RadioGroup: React.ElementType;
  RadioItem: React.ElementType;
}

const CONTEXT_SLOTS: GroupMenuSlots = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

const DROPDOWN_SLOTS: GroupMenuSlots = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};

interface GroupHeaderProps {
  /** The group this header belongs to. */
  group: SidebarGroup;
  /** Count of known member agents (drives the delete-dialog copy). */
  memberCount: number;
  /** Show the collapsed-group activity dot (orchestrated: collapsed && a member is working). */
  showActivityDot: boolean;
  /**
   * The group's currently-derived members (smart groups only) — what "Convert
   * to manual group" materializes into `agentPaths`. Ignored for manual
   * groups.
   */
  derivedMemberPaths?: string[];
  /** Runtimes present in the fleet, for the "Edit rules" form (smart groups only). */
  runtimeOptions?: RuntimeOption[];
  /** Distinct namespaces present in the fleet, for the "Edit rules" form (smart groups only). */
  namespaceOptions?: string[];
}

/**
 * A user group's header: collapse chevron, name (with inline rename), a
 * collapsed-activity dot, and the show / sort / mute / rename / delete menu —
 * rendered identically into the "…" dropdown and the right-click context
 * menu. Muting the group is a lens over its members (DOR-339): it never
 * writes member paths into `ui.sidebar.muted`, so unmuting restores whatever
 * individual mute state each member already had. Smart groups (DOR-338) add
 * a rule glyph + plain-language summary, an "Edit rules" action that reopens
 * the rule form, and "Convert to manual group" — the escape hatch that
 * freezes the currently-matching members into a hand-tunable manual group.
 */
export function GroupHeader({
  group,
  memberCount,
  showActivityDot,
  derivedMemberPaths,
  runtimeOptions,
  namespaceOptions,
}: GroupHeaderProps) {
  const { update } = useUpdateSidebarPrefs();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editRulesOpen, setEditRulesOpen] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  // "Rename" mounts an inline editor; the launching menu's close-time focus
  // restore would steal its focus and blur-commit it immediately (DOR-329).
  // Armed by startRename, wired onto BOTH menu contents below.
  const { arm: armCloseFocusGuard, onCloseAutoFocus } = useMenuCloseFocusGuard();

  useEffect(() => {
    if (isRenaming) {
      committedRef.current = false;
      requestAnimationFrame(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      });
    }
  }, [isRenaming]);

  const toggleCollapse = () =>
    update((prev) => setGroupCollapsed(prev, group.id, !group.collapsed));

  const startRename = () => {
    armCloseFocusGuard();
    setRenameValue(group.name);
    setIsRenaming(true);
  };

  const commitRename = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setIsRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME || trimmed === group.name) return;
    update((prev) => renameGroup(prev, group.id, trimmed));
  };

  const cancelRename = () => {
    committedRef.current = true;
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  const requestDelete = () => {
    if (memberCount === 0) {
      update((prev) => deleteGroup(prev, group.id));
    } else {
      setDeleteOpen(true);
    }
  };

  const confirmDelete = () => {
    update((prev) => deleteGroup(prev, group.id));
    setDeleteOpen(false);
  };

  const isSmart = group.kind === 'smart';
  // Smart groups reject 'manual' sort at the schema level — derived
  // membership has no hand-orderable sequence, so the option never appears.
  const sortOptions = isSmart ? SORT_OPTIONS.filter((o) => o.value !== 'manual') : SORT_OPTIONS;

  const setSort = (mode: string) =>
    update((prev) => setGroupSortMode(prev, group.id, mode as SidebarGroup['sortMode']));
  const setFilter = (filter: string) =>
    update((prev) =>
      setGroupDisplayFilter(prev, group.id, filter as SidebarGroup['displayFilter'])
    );
  const toggleMuted = () => update((prev) => setGroupMuted(prev, group.id, !group.muted));
  const openEditRules = () => setEditRulesOpen(true);
  const convertToManual = () =>
    update((prev) => convertSmartGroupToManual(prev, group.id, derivedMemberPaths ?? []));
  const handleSaveRules = ({
    rules,
  }: {
    name: string;
    rules: NonNullable<SidebarGroup['rules']>;
  }) => update((prev) => setGroupRules(prev, group.id, rules));

  const renderMenu = (slots: GroupMenuSlots): ReactNode => {
    const { Item, Separator, Sub, SubTrigger, SubContent, RadioGroup, RadioItem } = slots;
    return (
      <>
        {isSmart && (
          <div className="text-muted-foreground flex items-start gap-1.5 px-2 py-1.5 text-xs">
            <ListFilter className="mt-0.5 size-3.5 shrink-0" />
            <span>{describeRules(group.rules ?? {})}</span>
          </div>
        )}
        <Item onClick={startRename}>
          <Pencil className="mr-2 size-4" />
          Rename
        </Item>
        {renderDisplayFilterSubmenu(slots, group.displayFilter, setFilter)}
        <Sub>
          <SubTrigger>
            <ArrowUpDown className="mr-2 size-4" />
            Sort by
          </SubTrigger>
          <SubContent className="w-44">
            <RadioGroup value={group.sortMode} onValueChange={setSort}>
              {sortOptions.map((opt) => (
                <RadioItem key={opt.value} value={opt.value}>
                  {opt.label}
                </RadioItem>
              ))}
            </RadioGroup>
          </SubContent>
        </Sub>
        <Item onClick={toggleMuted}>
          {group.muted ? <Bell className="mr-2 size-4" /> : <BellOff className="mr-2 size-4" />}
          {group.muted ? 'Unmute group' : 'Mute group'}
        </Item>
        {isSmart && (
          <>
            <Item onClick={openEditRules}>
              <Wand2 className="mr-2 size-4" />
              Edit rules
            </Item>
            <Item onClick={convertToManual}>
              <Users className="mr-2 size-4" />
              Convert to manual group
            </Item>
          </>
        )}
        <Separator />
        <Item variant="destructive" onClick={requestDelete}>
          <Trash2 className="mr-2 size-4" />
          Delete group
        </Item>
      </>
    );
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/gh relative flex h-8 items-center rounded-md pr-7">
            {isRenaming ? (
              <input
                ref={renameRef}
                value={renameValue}
                maxLength={MAX_NAME}
                aria-label="Group name"
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={commitRename}
                className={cn(
                  'bg-background text-foreground',
                  'focus-visible:ring-ring ml-4 min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
                )}
              />
            ) : (
              <button
                type="button"
                onClick={toggleCollapse}
                aria-expanded={!group.collapsed}
                className={cn(
                  'text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring',
                  'flex h-full min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium outline-hidden focus-visible:ring-2'
                )}
              >
                {group.collapsed ? (
                  <ChevronRight className="size-3.5 shrink-0" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0" />
                )}
                {isSmart && (
                  <ListFilter
                    aria-label="Smart group — membership is rule-based"
                    className="size-3 shrink-0"
                  />
                )}
                <span className="truncate tracking-wider uppercase">{group.name}</span>
                {showActivityDot && (
                  <span
                    aria-label="Active work in this group"
                    className="bg-primary ml-1 size-1.5 shrink-0 rounded-full"
                  />
                )}
              </button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`${group.name} group actions`}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'text-muted-foreground hover:text-foreground focus-visible:ring-ring',
                    'absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-md opacity-0 outline-hidden transition-opacity',
                    'group-hover/gh:opacity-100 focus-visible:opacity-100 focus-visible:ring-2'
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                className="w-44"
                onCloseAutoFocus={onCloseAutoFocus}
              >
                {renderMenu(DROPDOWN_SLOTS)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44" onCloseAutoFocus={onCloseAutoFocus}>
          {renderMenu(CONTEXT_SLOTS)}
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group &ldquo;{group.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {memberCount} {memberCount === 1 ? 'agent moves' : 'agents move'} back to Agents.
              Nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete group</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isSmart && (
        <SmartGroupRuleDialog
          open={editRulesOpen}
          onOpenChange={setEditRulesOpen}
          mode="edit"
          initialName={group.name}
          initialRules={group.rules}
          runtimeOptions={runtimeOptions ?? []}
          namespaceOptions={namespaceOptions ?? []}
          onSubmit={handleSaveRules}
        />
      )}
    </>
  );
}
