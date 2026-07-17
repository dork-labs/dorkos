import { useState, useRef, useEffect, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  ArrowUpDown,
  Trash2,
} from 'lucide-react';
import type { SidebarGroup } from '@dorkos/shared/config-schema';
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
} from '@/layers/entities/config';

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
}

/**
 * A user group's header: collapse chevron, name (with inline rename), a
 * collapsed-activity dot, and the sort / rename / delete menu — rendered
 * identically into the "…" dropdown and the right-click context menu.
 */
export function GroupHeader({ group, memberCount, showActivityDot }: GroupHeaderProps) {
  const { update } = useUpdateSidebarPrefs();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

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

  const setSort = (mode: string) =>
    update((prev) => setGroupSortMode(prev, group.id, mode as SidebarGroup['sortMode']));

  const renderMenu = (slots: GroupMenuSlots): ReactNode => {
    const { Item, Separator, Sub, SubTrigger, SubContent, RadioGroup, RadioItem } = slots;
    return (
      <>
        <Item onClick={startRename}>
          <Pencil className="mr-2 size-4" />
          Rename
        </Item>
        <Sub>
          <SubTrigger>
            <ArrowUpDown className="mr-2 size-4" />
            Sort by
          </SubTrigger>
          <SubContent className="w-44">
            <RadioGroup value={group.sortMode} onValueChange={setSort}>
              {SORT_OPTIONS.map((opt) => (
                <RadioItem key={opt.value} value={opt.value}>
                  {opt.label}
                </RadioItem>
              ))}
            </RadioGroup>
          </SubContent>
        </Sub>
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
              <DropdownMenuContent side="right" align="start" className="w-44">
                {renderMenu(DROPDOWN_SLOTS)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">{renderMenu(CONTEXT_SLOTS)}</ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group &ldquo;{group.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {memberCount} {memberCount === 1 ? 'agent' : 'agents'} move back to Agents.
              Nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete group</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
