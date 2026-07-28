import { SidebarGroup, SidebarGroupLabel, SidebarMenu } from '@/layers/shared/ui';
import { Droppable, SortableList, agentRowDndId } from './dnd/SidebarDndPrimitives';
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
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-sidebar-foreground/70 text-xs font-medium tracking-wider uppercase">
        Pinned
      </SidebarGroupLabel>
      <Droppable id="container::pinned" data={{ type: 'container', container: { kind: 'pinned' } }}>
        {/* Rooms are not a drag source until S3, so only agent rows join the
            sortable context — an id with no matching `Sortable` makes dnd-kit
            measure a node that is not there. */}
        <SortableList
          items={items.flatMap((item) =>
            item.ref.kind === 'agent' ? [agentRowDndId('pinned', item.ref.path)] : []
          )}
        >
          <SidebarMenu>{items.map((item) => renderItem(item, 'pinned'))}</SidebarMenu>
        </SortableList>
      </Droppable>
    </SidebarGroup>
  );
}
