import type { ReactNode } from 'react';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu } from '@/layers/shared/ui';
import { Droppable, SortableList, agentRowDndId } from './SidebarDndPrimitives';

interface PinnedSectionProps {
  /** Pinned agent project paths, already filtered to the known roster and ordered. */
  paths: string[];
  /** Render one agent row. `keyPrefix` disambiguates the pinned copy from its home copy (multi-presence). */
  renderRow: (path: string, keyPrefix: string) => ReactNode;
}

/**
 * The "Pinned" section. Pins are multi-presence *references*: a pinned agent
 * still renders in its home group / the ungrouped list, so rows here carry a
 * `pinned` key prefix to coexist with their home copy. The whole section is a
 * drop zone (drag an agent here to pin it) and a sortable list (reorder pins).
 */
export function PinnedSection({ paths, renderRow }: PinnedSectionProps) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-sidebar-foreground/70 text-xs font-medium tracking-wider uppercase">
        Pinned
      </SidebarGroupLabel>
      <Droppable id="container::pinned" data={{ type: 'container', container: { kind: 'pinned' } }}>
        <SortableList items={paths.map((p) => agentRowDndId('pinned', p))}>
          <SidebarMenu>{paths.map((path) => renderRow(path, 'pinned'))}</SidebarMenu>
        </SortableList>
      </Droppable>
    </SidebarGroup>
  );
}
