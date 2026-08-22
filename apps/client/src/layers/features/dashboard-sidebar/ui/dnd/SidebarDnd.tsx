import { useMemo, useRef, useState, type ReactNode } from 'react';
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
import { motion } from 'motion/react';
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
import { DRAG_LIFT_SCALE, DRAG_LIFT_SECONDS } from '../motion/sidebar-motion';
import { SidebarDndEnabledProvider } from './SidebarDndPrimitives';

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
  return (
    // **Lift, ring, settle** (spec D5): the label picks itself up off the panel
    // by 2% with the floating shadow under it, so what is moving is obviously
    // the thing under the cursor rather than a copy of it. `MotionConfig
    // reducedMotion="user"` above drops the scale for a reader who asked for
    // less, and the shadow stays — it is depth, not movement.
    <motion.div
      initial={{ scale: 1 }}
      animate={{ scale: DRAG_LIFT_SCALE }}
      transition={{ duration: DRAG_LIFT_SECONDS }}
      className="bg-sidebar border-sidebar-border text-sidebar-foreground shadow-floating flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium"
    >
      {label}
    </motion.div>
  );
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
  const prefsRef = useRef<SidebarPrefs>(prefs);
  prefsRef.current = prefs;
  const namesRef = useRef(displayNames);
  namesRef.current = displayNames;
  const roomTitles = useMemo(
    () => Object.fromEntries(rooms.map((room) => [room.id, room.slug ?? room.title])),
    [rooms]
  );
  const roomTitlesRef = useRef(roomTitles);
  roomTitlesRef.current = roomTitles;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (isMobile) return <>{children}</>;

  const groupName = (id: string): string =>
    prefsRef.current.groups.find((g) => g.id === id)?.name ?? 'group';
  const itemName = (ref: SidebarItemRef): string =>
    ref.kind === 'agent'
      ? (namesRef.current[ref.path] ?? ref.path.split('/').pop() ?? 'Agent')
      : (roomTitlesRef.current[ref.roomId] ?? 'room');

  const announcements = buildSidebarAnnouncements(() => ({
    prefs: prefsRef.current,
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
    const op = classifySidebarDrop(prefsRef.current, drag, drop);
    if (op.kind === 'reject-smart-group') {
      toast.info('Membership is rule-based — edit rules instead.', {
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
