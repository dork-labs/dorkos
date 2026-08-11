/**
 * Today, with the two behaviours that are about the operator's hands rather
 * than about the model: the order holds still while they are in the zone
 * (BC-17), and the open conversation comes to them when they switch (BC-36).
 *
 * Everything else Today does — who is in it, what order, what is capped, what
 * is archived, which row is the anchor — was decided by `buildSidebarModel`
 * and is drawn by the ordinary {@link SidebarZone}. This component adds a
 * wrapper, four handlers and a ref, and holds no rules.
 *
 * It also carries the one ACT that belongs to the whole zone rather than to
 * any row in it: {@link CatchUpAction}, the phone's "clear everything" (P4
 * AC-4). It lives here because Today is the only thing that has one and this
 * is Today's component — a module of its own would be a file whose single
 * consumer is the file next to it.
 *
 * @module features/dashboard-sidebar/ui/TodayZone
 */
import { useMemo, useRef } from 'react';
import { CheckCheck } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { TOUCH_TARGET_MIN_H } from '@/layers/shared/ui';
import type { SidebarRowModel, SidebarZoneModel } from '../model/build-sidebar-model';
import type { SidebarZoneProps } from './SidebarZone';
import { useMarkRoomsRead } from '../model/use-mark-rooms-read';
import { useScrollToActive } from '../model/use-scroll-to-active';
import { useTodayOrderHold } from '../model/use-today-order-hold';
import { SidebarZone } from './SidebarZone';

/**
 * The reason the model stamps on Today's first row when it is the conversation
 * the operator has open.
 *
 * Read from the rows rather than threaded down from the state, so this
 * component takes exactly what `SidebarZones` already has. `pin-active-anchor`
 * writes it and nothing else does.
 */
const ANCHOR_REASON = 'anchor:active-session';

/** Props for {@link TodayZone}. */
export interface TodayZoneProps {
  /** The Today zone, as the model emitted it. */
  zone: SidebarZoneModel;
  /** Fold or unfold every Library section at once — Alt/Option-click (BC-30). */
  onToggleAll: () => void;
  /** See {@link SidebarZoneProps.silenceLiveRegion} — passed straight through. */
  silenceLiveRegion?: boolean;
}

/**
 * Draw Today.
 *
 * @param props - The zone and the all-sections toggle.
 */
export function TodayZone({ zone, onToggleAll, silenceLiveRegion = false }: TodayZoneProps) {
  const container = useRef<HTMLDivElement>(null);
  const body = zone.sections.find((section) => section.id === 'today');
  const rows = useMemo(() => body?.rows ?? [], [body]);
  const anchorKey = rows.find((row) => row.reason === ANCHOR_REASON)?.key ?? null;

  const hold = useTodayOrderHold(rows, anchorKey);
  useScrollToActive(container, anchorKey);

  // Read off the model's rows, not the held ones: what is unread is a fact
  // about the zone, and BC-17's hold is about the ORDER a pointer sees. The two
  // lists carry the same rows, but only one of them is the answer to "what
  // would Catch up clear".
  const unreadRoomIds = useMemo(() => unreadRoomIdsIn(rows), [rows]);

  const held = useMemo<SidebarZoneModel>(
    () => ({
      ...zone,
      sections: zone.sections.map((section) =>
        section.id === 'today' ? { ...section, rows: hold.rows } : section
      ),
    }),
    [zone, hold.rows]
  );

  return (
    // A wrapper rather than handlers on the zone itself: `SidebarZone` draws
    // every zone, and three of the four have no reason to know what a pointer
    // is doing. The `<section>` landmark and its `data-sidebar-zone` attribute
    // stay exactly where they were, one level in.
    <div ref={container} {...hold.handlers}>
      <SidebarZone
        zone={held}
        onToggleAll={onToggleAll}
        silenceLiveRegion={silenceLiveRegion}
        lead={<CatchUpAction roomIds={unreadRoomIds} />}
      />
    </div>
  );
}

/**
 * The rooms a Today row is asking you to read, de-duplicated.
 *
 * **Rooms, because rooms are what carry unread.** A session row's boldness is
 * not a cursor — `deriveUnreadSignal` is only ever fed a room's or a thread's
 * `unreadCount` — and a thread inherits the cursor of the room it lives in
 * (`select-today-items`), so two rows of one channel are one write. Handing a
 * caught-up room to the sweep would spend two requests writing the cursor it
 * already has.
 *
 * Exported so the count and the act come from the same list rather than from
 * two walks that could disagree about what "everything" means.
 *
 * @param rows - Today's rows, as the model emitted them.
 */
export function unreadRoomIdsIn(rows: readonly SidebarRowModel[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.unread.tier === 'none') continue;
    if (row.target.kind !== 'room') continue;
    ids.add(row.target.roomId);
  }
  return [...ids];
}

/** Props for {@link CatchUpAction}. */
export interface CatchUpActionProps {
  /** The rooms to clear, from {@link unreadRoomIdsIn}. */
  roomIds: readonly string[];
}

/**
 * The action, or nothing.
 *
 * Absent with nothing to clear, and absent under a pointer — chrome appears by
 * data volume, not by settings (BC-32, design-meta rule 8), and an action that
 * would do nothing is the loudest kind of nothing.
 *
 * @param props - The rooms this press would mark read.
 */
export function CatchUpAction({ roomIds }: CatchUpActionProps) {
  const isMobile = useIsMobile();
  const markRoomsRead = useMarkRoomsRead();
  if (!isMobile || roomIds.length === 0) return null;

  const count = roomIds.length;
  return (
    <div className="px-2 pt-0.5 pb-1">
      <button
        type="button"
        data-testid="today-catch-up"
        onClick={() => markRoomsRead(roomIds)}
        // The visible words open the accessible name, so a voice control that
        // hears "Catch up" reaches this button (WCAG 2.5.3, label in name); the
        // rest says how much it is about to do, which the words alone cannot.
        aria-label={`Catch up — mark ${count} unread ${count === 1 ? 'conversation' : 'conversations'} in Today as read`}
        className={cn(
          'text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-ring',
          // A thumb's target, the same 44px the rows under it are (P4 AC-4).
          'flex w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors duration-100 active:scale-[0.98]',
          TOUCH_TARGET_MIN_H
        )}
      >
        <CheckCheck className="size-4 shrink-0" aria-hidden />
        Catch up
        <span className="text-sidebar-foreground/50 ml-auto text-[11px] tabular-nums">{count}</span>
      </button>
    </div>
  );
}
