import { Pin } from 'lucide-react';
import { SectionHeader, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import { useRovingFocus } from '@/layers/shared/model';
import { Droppable, SortableList, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import type { RenderSidebarItem, SidebarItem } from '../model/sidebar-item';

interface PinnedSectionProps {
  /** Pinned items — agents and rooms — already resolved and in stored order. */
  items: SidebarItem[];
  /** Render one row. `keyPrefix` disambiguates the pinned copy from its home copy (multi-presence). */
  renderItem: RenderSidebarItem;
}

/**
 * The "Pinned" section. Pins are multi-presence *references*: a pinned agent
 * still renders in its home group / the ungrouped list, and a pinned room still
 * renders in its own section or group, so rows here carry a `pinned` key prefix
 * to coexist with their home copy. The whole section is a drop zone (drag an
 * agent here to pin it) and a sortable list (reorder pins).
 *
 * Pins keep their stored order — this is the one hand-made sequence in the
 * sidebar that no sort mode overrides.
 */
export function PinnedSection({ items, renderItem }: PinnedSectionProps) {
  const roving = useRovingFocus();
  return (
    <SidebarGroup className="px-0">
      {/* No collapse and no menu: Pins is the one section that appears purely
          because you put something in it, and folding away the shortcuts you
          hand-made is a control nobody reaches for. */}
      <SectionHeader label="Pinned" icon={Pin} />
      <Droppable id="container::pinned" data={{ type: 'container', container: { kind: 'pinned' } }}>
        <SortableList items={items.map((item) => sidebarRowDndId('pinned', item.ref))}>
          <SidebarMenu {...roving}>
            {items.map((item) =>
              // A pinned ROOM stays undraggable: dragging it out would unpin
              // it, and the room menu offers no Pin to undo that (rooms sort by
              // recent activity; pinning one is an agent-written config act).
              // Agents keep the drag: their menu can re-pin.
              renderItem(
                item,
                'pinned',
                item.ref.kind === 'room' ? { draggable: false } : undefined
              )
            )}
          </SidebarMenu>
        </SortableList>
      </Droppable>
    </SidebarGroup>
  );
}
