import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SidebarMenuItem, SidebarMenuButton } from '@/layers/shared/ui';
import type { RenderSidebarItem, SidebarItem } from '../model/sidebar-item';

interface RevealRowProps {
  /** Which honest count this ghost row reports. */
  kind: 'hidden' | 'inactive';
  /**
   * The hidden items — revealed inline on click.
   *
   * The `inactive` row can only ever hold agents: a room is never in the
   * `inactive` attention state (see `SidebarItem.attention`), which is what
   * keeps its "N inactive agents" wording true.
   */
  items: SidebarItem[];
  /** Render one row (the same renderer the section uses for its visible rows). */
  renderItem: RenderSidebarItem;
  /** Dnd key prefix for revealed rows (the section's own container key). */
  keyPrefix: string;
}

/**
 * The "N hidden" / "N inactive agents" ghost row (spec agent-list-settings
 * §3): whenever a filter or the inactive threshold hides members, this is the
 * honest trail back to them — never silent hiding. Click expands the hidden
 * members inline; the expanded state is local component state, not
 * persisted, because a reveal is a peek, not a mode. Renders nothing when
 * there is nothing to reveal.
 *
 * Revealed rows render outside the section's drag-and-drop `SortableList` (a
 * peek is not a reorder surface), so they use the same row renderer for a
 * consistent look and full click/context-menu/mute behavior, but are not
 * currently draggable while in the revealed state.
 */
export function RevealRow({ kind, items, renderItem, keyPrefix }: RevealRowProps) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) return null;

  const label =
    kind === 'inactive'
      ? `${items.length} inactive ${items.length === 1 ? 'agent' : 'agents'}`
      : `${items.length} hidden`;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground gap-1.5 text-xs font-medium italic"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          {label}
        </SidebarMenuButton>
      </SidebarMenuItem>
      {expanded && items.map((item) => renderItem(item, keyPrefix))}
    </>
  );
}
