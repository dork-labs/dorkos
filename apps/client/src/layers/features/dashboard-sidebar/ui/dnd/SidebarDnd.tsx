import { useMemo, useState, type ReactNode } from 'react';
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
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarPrefs, SidebarItemRef } from '@dorkos/shared/config-schema';
import {
  buildSidebarAnnouncements,
  classifySidebarDrop,
  COMPUTED_ZONE_REJECTION,
  readSidebarDndData,
  resolveSidebarDrop,
  toDragDescriptor,
  toDropDescriptor,
  type SidebarDndData,
} from '../../model/use-sidebar-dnd';
import { DragLiftChip } from '../motion/DragLiftChip';
import { SidebarDndEnabledProvider } from './SidebarDndPrimitives';
import { useLatest } from '@/layers/shared/lib';

interface SidebarDndProps {
  children: ReactNode;
  /** Agent display names keyed by projectPath — used for the overlay and announcements. */
  displayNames: Record<string, string>;
  /**
   * Every room the sidebar can see, for the same two surfaces: room rows are
   * drag sources since DOR-581, and `ui.sidebar` is agent-writable besides, so
   * `config_patch` can also put a room reference in `pinned`.
   *
   * The LIST rather than a prepared title map, so the one caller that has this
   * state does not have to reshape it on the way in — `DashboardSidebar` is
   * held to transforming nothing, and naming a room is this layer's business
   * anyway, since this is where a name is read out loud.
   */
  rooms: readonly RoomSummary[];
}

/** The floating label shown under the cursor while dragging. */
function DragOverlayContent({
  data,
  itemName,
  groupName,
}: {
  data: SidebarDndData;
  itemName: (ref: SidebarItemRef) => string;
  groupName: (id: string) => string;
}) {
  const label =
    data.type === 'group'
      ? groupName(data.groupId)
      : data.type === 'item'
        ? itemName(data.ref)
        : '';
  // The lift itself is `DragLiftChip` — one component, so the Dev Playground
  // shows the real chip and a retune moves both (spec D5).
  return <DragLiftChip label={label} />;
}

/**
 * Drag-and-drop layer for the sidebar (DOR-329). Wraps the section list in a
 * dnd-kit `DndContext` with an 8px pointer activation (so a click still expands
 * a row), a keyboard sensor (WCAG 2.2 §2.5.7 — Space/arrows/Space/Esc), a drag
 * overlay, and per-operation ARIA announcements. Drop semantics are delegated to
 * the pure `resolveSidebarDrop` reducer.
 *
 * Below 768px there is no sidebar panel at all — `AppShell` does not render
 * `<Sidebar>`, so there is no sheet and no drawer, and the panel's rows reach a
 * phone through the mobile tabs instead. Touch drag is disabled there: the
 * children render without a `DndContext` and every drag operation stays reachable
 * through the row/header context menus.
 */
export function SidebarDnd({ children, displayNames, rooms }: SidebarDndProps) {
  const isMobile = useIsMobile();
  const prefs = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const [activeData, setActiveData] = useState<SidebarDndData | null>(null);

  // Keep the latest prefs/names for the event handlers + announcements without
  // re-creating sensors or the DndContext on every optimistic write.
  const latestPrefs = useLatest<SidebarPrefs>(prefs);
  const latestNames = useLatest(displayNames);
  const roomTitles = useMemo(
    () => Object.fromEntries(rooms.map((room) => [room.id, room.slug ?? room.title])),
    [rooms]
  );
  const latestRoomTitles = useLatest(roomTitles);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (isMobile) return <>{children}</>;

  const groupName = (id: string): string =>
    latestPrefs.read().groups.find((g) => g.id === id)?.name ?? 'group';
  const itemName = (ref: SidebarItemRef): string =>
    ref.kind === 'agent'
      ? (latestNames.read()[ref.path] ?? ref.path.split('/').pop() ?? 'Agent')
      : (latestRoomTitles.read()[ref.roomId] ?? 'room');

  const announcements = buildSidebarAnnouncements(() => ({
    prefs: latestPrefs.read(),
    itemName,
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
    const op = classifySidebarDrop(latestPrefs.read(), drag, drop);
    if (op.kind === 'reject-smart-group') {
      toast.info('Membership is rule-based. Edit rules instead.', {
        description: groupName(op.groupId),
      });
      return;
    }
    // Same mechanism, different reason: Heads up and Today are derived, so a row
    // dropped there has no place to be put (R3).
    if (op.kind === 'reject-computed-zone') {
      toast.info(COMPUTED_ZONE_REJECTION, { description: itemName(op.ref) });
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
        {/* **dnd-kit's own settle, restored.** The overlay used to vanish at
            the instant of the drop (`dropAnimation={null}`), so a row that had
            travelled the length of the panel simply ceased to exist and the
            eye had to find where it landed. The default drop animation returns
            it to the slot it took (D5, "settle with a short spring"). */}
        <DragOverlay>
          {activeData ? (
            <DragOverlayContent data={activeData} itemName={itemName} groupName={groupName} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </SidebarDndEnabledProvider>
  );
}
