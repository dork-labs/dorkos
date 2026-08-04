import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  SidebarGroupLabel,
} from '@/layers/shared/ui';
import { useMenuCloseFocusGuard } from '../model/use-menu-close-focus-guard';
import { SectionHeaderMenuItems, type SectionHeaderMenuNode } from './SectionHeaderMenuItems';

interface SidebarSectionHeaderProps {
  /** Section name, e.g. "Channels". Rendered uppercase. */
  label: string;
  /**
   * The section's actions, from one of the builders in
   * {@link SectionHeaderMenuItems}. The same list feeds the right-click menu
   * and the "…" menu, so the two can never offer different things.
   */
  nodes: SectionHeaderMenuNode[];
  /**
   * Current collapse state (persisted in `ui.sidebar`). Omit — along with
   * `onToggle` — for a section that cannot collapse; the header then renders as
   * a plain label with the same menus on it.
   */
  collapsed?: boolean;
  /** Flip the collapse state. */
  onToggle?: () => void;
  /**
   * True when the section also draws a "+" (`SidebarGroupAction`), which sits
   * in the header row's top-right corner. The "…" then moves left of it instead
   * of underneath it.
   */
  hasSectionAction?: boolean;
}

/**
 * The header every sidebar section shares: its name, its collapse control, and
 * everything you can do to the section — by right-clicking the header, or from
 * the "…" that appears on hover and on focus (spec `rooms` §14.1).
 *
 * **Both menus render the same node list**, the constraint that made §14.1
 * tractable and the one `AgentRowMenuItems` established: the items are data,
 * the two Radix families are two sets of slots, and there is no second
 * hand-written list to drift.
 *
 * The chevron is decorative; `aria-expanded` on the name button carries the
 * collapse state. The "…" is a real focusable button — `focus-visible` reveals
 * it, so a keyboard reaches every section action without a pointer, which is
 * also the only way the menu exists at all on a device with no right-click.
 *
 * An item that opens something (`opensInput`) arms the close-focus guard: Radix
 * closes the menu one commit after the item runs, and its focus restore would
 * otherwise pull focus out of whatever just opened (DOR-329).
 */
export function SidebarSectionHeader({
  label,
  nodes,
  collapsed,
  onToggle,
  hasSectionAction = false,
}: SidebarSectionHeaderProps) {
  const { arm, onCloseAutoFocus } = useMenuCloseFocusGuard();

  // Arming belongs here rather than in each builder: whether focus has to be
  // protected is a fact about how this menu closes, not about what the action
  // means, and every builder would otherwise repeat it.
  //
  // Deliberately not memoized. Every caller builds its `nodes` inline from a
  // builder, so the array is a new identity on every render and a `useMemo`
  // keyed on it would never hit — it would cost a dependency check to return a
  // fresh array anyway. The map is over a handful of items and its output feeds
  // no memoized child.
  const guarded = nodes.map((node) =>
    node.kind === 'action' && node.opensInput
      ? {
          ...node,
          run: () => {
            arm();
            node.run();
          },
        }
      : node
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group/sh relative flex h-8 items-center',
            hasSectionAction ? 'pr-14' : 'pr-7'
          )}
        >
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={!collapsed}
              className={cn(
                'text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring',
                'flex h-full min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium outline-hidden focus-visible:ring-2'
              )}
            >
              {collapsed ? (
                <ChevronRight className="size-3.5 shrink-0" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0" />
              )}
              <span className="truncate tracking-wider uppercase">{label}</span>
            </button>
          ) : (
            <SidebarGroupLabel className="text-sidebar-foreground/70 text-xs font-medium tracking-wider uppercase">
              {label}
            </SidebarGroupLabel>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`${label} section actions`}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'text-muted-foreground hover:text-foreground focus-visible:ring-ring',
                  'absolute top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md opacity-0 outline-hidden transition-opacity',
                  'group-hover/sh:opacity-100 focus-visible:opacity-100 focus-visible:ring-2',
                  hasSectionAction ? 'right-9' : 'right-1'
                )}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="right"
              align="start"
              className="w-48"
              onCloseAutoFocus={onCloseAutoFocus}
            >
              <SectionHeaderMenuItems variant="dropdown" nodes={guarded} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48" onCloseAutoFocus={onCloseAutoFocus}>
        <SectionHeaderMenuItems variant="context" nodes={guarded} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
