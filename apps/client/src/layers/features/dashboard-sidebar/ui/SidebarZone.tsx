/**
 * One zone — Heads up, Getting started, Today or Library.
 *
 * A zone is a **landmark with no chrome of its own** (D1, superseding BC-2's
 * "never an accordion"): it draws no heading, holds no collapse state and has no
 * toggle in the DOM — its name reaches assistive tech through `aria-label`, and
 * what an operator SEES is the section header inside it, which is the same
 * header every section in the panel wears. A zone with nothing to say is absent
 * from `model.zones` entirely rather than rendering an empty box (BC-1).
 *
 * @module features/dashboard-sidebar/ui/SidebarZone
 */
import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';
import type { SidebarZoneModel } from '../model/build-sidebar-model';
import { useLiveRegionText } from '../model/use-live-region-text';
import { AllClearBeat } from './AllClearBeat';
import { SidebarSection } from './SidebarSection';

/** Props for {@link SidebarZone}. */
export interface SidebarZoneProps {
  /** The zone the model emitted. */
  zone: SidebarZoneModel;
  /** Fold or unfold every Library section at once — Alt/Option-click (BC-30). */
  onToggleAll: () => void;
  /**
   * Draw the all-clear beat in place of this zone's sections (BC-50).
   *
   * Only ever true for `now`, and only while the beat is playing. It is a prop
   * rather than something this component works out, because "the last item just
   * resolved" is a transition between two models and a component handed one
   * model cannot see it.
   */
  allClear?: boolean;
  /**
   * Content between the zone's heading and its sections — a bulk action that
   * belongs to the whole zone, or something composed from a layer this one
   * cannot import.
   *
   * A slot rather than two more props, because the two things that need it are
   * unrelated and both are about the zone as a whole rather than about any row
   * in it: Today's "Catch up" (P4 AC-4) and Now's inline approvals, which are a
   * feature this feature may not reach into and so arrive from the widget above
   * (FSD — `features ← widgets`).
   */
  lead?: ReactNode;
  /**
   * Something above this zone is already announcing its count, so this zone
   * must not.
   *
   * The phone cockpit is the one caller. Its panels are `inert` whenever they
   * are put away — which is most of the time, and always while the operator is
   * in a conversation — so a live region inside one is out of the accessibility
   * tree exactly when the count changes matter most. The bottom bar's badge is
   * what carries the number there, and its announcement lives beside it, out in
   * the open. Two regions saying the same number is the siren BC-11 exists to
   * prevent, so the inner one stands down rather than being drawn twice.
   */
  silenceLiveRegion?: boolean;
}

/**
 * A zone's heading, its live region, and its sections.
 *
 * **Separation is tint, never a line.** Each zone is one step of the
 * `--sidebar-accent` ramp; there is no border anywhere in this component, and
 * `--muted` is deliberately absent because it is lighter than the panel in
 * light mode and darker in dark, so two zones tinted with it would separate in
 * opposite directions between themes (spec R1).
 *
 * @param props - The zone and the all-sections toggle.
 */
export function SidebarZone({
  zone,
  onToggleAll,
  allClear = false,
  lead,
  silenceLiveRegion = false,
}: SidebarZoneProps) {
  const liveRegionText = useLiveRegionText(zone.liveRegionText);
  return (
    <section
      // **Named, not headed.** The visible `<h2>` is gone (D1): three levels in
      // a 272px panel put zone labels, section headers and rows on three
      // different x, and "Library" named nothing an operator recognised. The
      // region keeps its name for assistive tech — `ZONE_LABEL.library` is now
      // an accessible name that is never painted, the same pattern DOR-1155
      // used for `now` (label only, never the id).
      aria-label={zone.label}
      data-sidebar-zone={zone.id}
      className={cn(
        // **No horizontal padding.** The sidebar pays its 16px left inset in
        // exactly two places — 8 on the panel and 8 on the row — and a zone
        // that added its own 4 put every row in the panel at 20px. Vertical
        // room only; separation between zones is tint and whitespace, never a
        // third helping of inset (design-decisions §11, spec R1).
        'rounded-lg py-1',
        // Heads up and Getting started carry the one tint that asks for a look; the
        // calm zones sit on the panel itself.
        zone.id === 'now' || zone.id === 'getting-started' ? 'bg-sidebar-accent/40' : undefined
      )}
    >
      {/* Count changes only, held for a second before it is published: a verb or
          an unread change reaching a screen reader from here would turn a fleet
          of thirty agents into a siren (BC-11, R2). */}
      {!silenceLiveRegion && (
        <span aria-live="polite" aria-atomic="true" className="sr-only">
          {liveRegionText}
        </span>
      )}
      {lead}
      {allClear ? (
        <AllClearBeat />
      ) : (
        zone.sections.map((section) => (
          <SidebarSection key={section.id} section={section} onToggleAll={onToggleAll} />
        ))
      )}
    </section>
  );
}
