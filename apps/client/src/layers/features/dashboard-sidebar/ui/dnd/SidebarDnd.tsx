import { useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import { useIsMobile } from '@/layers/shared/model';
import { useSidebarPrefs, useUpdateSidebarPrefs } from '@/layers/entities/config';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';
import {
  buildSidebarAnnouncements,
  classifySidebarDrop,
  readSidebarDndData,
  resolveSidebarDrop,
  toDragDescriptor,
  toDropDescriptor,
  type SidebarDndData,
} from '../../model/use-sidebar-dnd';
import { SidebarDndEnabledProvider } from './SidebarDndPrimitives';

interface SidebarDndProps {
  children: ReactNode;
  /** Display names keyed by projectPath — used for the overlay and announcements. */
  displayNames: Record<string, string>;
}

/** The floating label shown under the cursor while dragging. */
function DragOverlayContent({
  data,
  displayNames,
  groupName,
}: {
  data: SidebarDndData;
  displayNames: Record<string, string>;
  groupName: (id: string) => string;
}) {
  const label =
    data.type === 'group'
      ? groupName(data.groupId)
      : data.type === 'agent'
        ? (displayNames[data.path] ?? data.path.split('/').pop() ?? 'Agent')
        : '';
  return (
    <div className="bg-sidebar border-sidebar-border text-sidebar-foreground shadow-floating flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium">
      {label}
    </div>
  );
}

/**
 * Drag-and-drop layer for the sidebar (DOR-329). Wraps the section list in a
 * dnd-kit `DndContext` with an 8px pointer activation (so a click still expands
 * a row), a keyboard sensor (WCAG 2.2 §2.5.7 — Space/arrows/Space/Esc), a drag
 * overlay, and per-operation ARIA announcements. Drop semantics are delegated to
 * the pure `resolveSidebarDrop` reducer.
 *
 * On mobile the sidebar is a scrollable `Sheet`, so touch drag is disabled: the
 * children render without a `DndContext` and every drag operation stays reachable
 * through the row/header context menus.
 */
export function SidebarDnd({ children, displayNames }: SidebarDndProps) {
  const isMobile = useIsMobile();
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const [activeData, setActiveData] = useState<SidebarDndData | null>(null);

  // Keep the latest prefs/names for the event handlers + announcements without
  // re-creating sensors or the DndContext on every optimistic write.
  const prefsRef = useRef<SidebarPrefs>(prefs);
  prefsRef.current = prefs;
  const namesRef = useRef(displayNames);
  namesRef.current = displayNames;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (isMobile) return <>{children}</>;

  const groupName = (id: string): string =>
    prefsRef.current.groups.find((g) => g.id === id)?.name ?? 'group';
  const agentName = (path: string): string =>
    namesRef.current[path] ?? path.split('/').pop() ?? 'Agent';

  const announcements = buildSidebarAnnouncements(() => ({
    prefs: prefsRef.current,
    agentName,
    groupName,
  }));

  const handleDragStart = (event: DragStartEvent) => {
    setActiveData(readSidebarDndData(event.active.data.current));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveData(null);
    const drag = toDragDescriptor(readSidebarDndData(event.active.data.current));
    if (drag === null) return;
    const drop = toDropDescriptor(readSidebarDndData(event.over?.data.current));
    // Smart groups (DOR-338) are never a valid drop target — classify first
    // so a rejected drop surfaces a hint instead of silently doing nothing.
    const op = classifySidebarDrop(prefsRef.current, drag, drop);
    if (op.kind === 'reject-smart-group') {
      toast.info('Membership is rule-based — edit rules instead.', {
        description: groupName(op.groupId),
      });
      return;
    }
    update((prev) => resolveSidebarDrop(prev, drag, drop));
  };

  return (
    <SidebarDndEnabledProvider value={true}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveData(null)}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {activeData ? (
            <DragOverlayContent
              data={activeData}
              displayNames={displayNames}
              groupName={groupName}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </SidebarDndEnabledProvider>
  );
}
