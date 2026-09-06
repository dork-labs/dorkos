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
  type KeyboardCodes,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { toast } from 'sonner';
import { useIsMobile } from '@/layers/shared/model';
import { useSidebarPrefs, useUpdateSidebarPrefs } from '@/layers/entities/config';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import {
  sameSidebarItem,
  type SidebarPrefs,
  type SidebarItemRef,
} from '@dorkos/shared/config-schema';
import {
  buildSidebarAnnouncements,
  classifySidebarDrop,
  COMPUTED_ZONE_REJECTION,
  readSidebarDndData,
  resolveSidebarDrop,
  toDragDescriptor,
  toDropDescriptor,
  type SidebarDndData,
  type SidebarDropOp,
} from '../../model/use-sidebar-dnd';
import { DragLiftChip } from '../motion/DragLiftChip';
import { SidebarDndEnabledProvider, sidebarRowDndId } from './SidebarDndPrimitives';
import { focusRowOnArrival } from './restore-drop-focus';
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

/**
 * Which keys pick a row up, put it down, and abandon it.
 *
 * **Space lifts; Enter opens.** dnd-kit's default is that both start a drag,
 * which was harmless while the activator was a wrapper nothing could focus and
 * is not harmless now that it is the row's own button (DOR-1746): Enter on a row
 * opens the conversation, and a keyboard reader would have found it picking the
 * row up instead. Space is the ARIA drag-and-drop pattern's pick-up key and the
 * one dnd-kit's own instructions name, so Space is the one that lifts — and
 * since a lifted row's Space puts it down again, Enter and Tab stay on `end`
 * where dnd-kit had them, as two more ways to commit a drop.
 */
const DRAG_KEYS: KeyboardCodes = {
  start: ['Space'],
  cancel: ['Escape'],
  end: ['Space', 'Enter', 'Tab'],
};

/**
 * The dnd id the moved row will be drawn under once a drop has been applied, or
 * `null` when the drop leaves the row where it already was.
 *
 * The three operations named here are the ones that take the row out of the
 * container it was lifted from, so the node dnd-kit was carrying is unmounted
 * and its `RestoreFocus` finds nothing (see `restore-drop-focus.ts`). Everything
 * else — the reorders, and `pin`, which COPIES a row into Pins and leaves the
 * original where it is — keeps that node, so dnd-kit restores focus itself and
 * this must not fight it.
 *
 * `unpin` reads its destination from the prefs rather than naming one: it takes
 * the row out of Pins, and where the row then lives is wherever it already
 * belonged — a section, or the ungrouped list it came from.
 *
 * @param prefs - The prefs the drop was classified against.
 * @param op - The classified drop.
 */
function movedRowDndId(prefs: SidebarPrefs, op: SidebarDropOp): string | null {
  switch (op.kind) {
    case 'move-to-group':
      return sidebarRowDndId(op.groupId, op.ref);
    case 'remove-from-group':
      return sidebarRowDndId('ungrouped', op.ref);
    case 'unpin': {
      const home = prefs.groups.find((group) =>
        group.items.some((item) => sameSidebarItem(item, op.ref))
      );
      return sidebarRowDndId(home?.id ?? 'ungrouped', op.ref);
    }
    default:
      return null;
  }
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
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: DRAG_KEYS,
    })
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
    // **A drop that changes nothing writes nothing** (DOR-1746). `none` is what
    // classify returns for a drop on empty space, a drop back where the drag
    // started, and every reorder whose `from === to`, and `resolveSidebarDrop`
    // faithfully hands back the prefs it was given — but `update` does not
    // compare, so it PATCHed the whole `ui.sidebar` section anyway. Cheap enough
    // to have gone unnoticed with a mouse, where a no-op drop takes deliberate
    // effort; from the keyboard it is one Space away, and the reflex of lifting
    // a row and putting it straight back down should cost the server nothing.
    if (op.kind === 'none') return;
    update((prev) => resolveSidebarDrop(prev, drag, drop));

    // **A keyboard drop that relocates the row has to hand the keyboard back**
    // (DOR-1790). The row is about to be unmounted and drawn again under a new
    // dnd id, which is the one case dnd-kit's own `RestoreFocus` cannot answer —
    // it looks the old id up and finds nothing, leaving a reader on `<body>`.
    //
    // **Keyboard only, deliberately.** A drop made with the mouse leaves focus
    // where the reader put it, and moving it because a drag happened would be
    // the pointer stealing the keyboard's place. dnd-kit draws the same line
    // (`isKeyboardEvent(previousActivatorEvent)`), and this is the same rule
    // applied to the rows it cannot reach.
    if (!(event.activatorEvent instanceof KeyboardEvent)) return;
    const landing = movedRowDndId(latestPrefs.read(), op);
    if (landing !== null) focusRowOnArrival(landing);
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
