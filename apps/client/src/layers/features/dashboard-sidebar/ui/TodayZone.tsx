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
 * @module features/dashboard-sidebar/ui/TodayZone
 */
import { useMemo, useRef } from 'react';
import type { SidebarZoneModel } from '../model/build-sidebar-model';
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
}

/**
 * Draw Today.
 *
 * @param props - The zone and the all-sections toggle.
 */
export function TodayZone({ zone, onToggleAll }: TodayZoneProps) {
  const container = useRef<HTMLDivElement>(null);
  const body = zone.sections.find((section) => section.id === 'today');
  const rows = useMemo(() => body?.rows ?? [], [body]);
  const anchorKey = rows.find((row) => row.reason === ANCHOR_REASON)?.key ?? null;

  const hold = useTodayOrderHold(rows, anchorKey);
  useScrollToActive(container, anchorKey);

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
      <SidebarZone zone={held} onToggleAll={onToggleAll} />
    </div>
  );
}
