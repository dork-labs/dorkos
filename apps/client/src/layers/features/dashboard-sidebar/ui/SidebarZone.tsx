/**
 * One zone — Heads up, Getting started, Today or Library.
 *
 * A zone is a **landmark, never an accordion** (BC-2): its label is a heading,
 * it has no collapse state in the model and no toggle in the DOM, and a zone
 * with nothing to say is absent from `model.zones` entirely rather than
 * rendering an empty box (BC-1).
 *
 * @module features/dashboard-sidebar/ui/SidebarZone
 */
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
export function SidebarZone({ zone, onToggleAll, allClear = false }: SidebarZoneProps) {
  const headingId = `sidebar-zone-${zone.id}`;
  const liveRegionText = useLiveRegionText(zone.liveRegionText);
  return (
    <section
      aria-labelledby={headingId}
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
      {/* **`/70`, not `/50`, and the number is a measurement.** On the zone
          tint in the light theme a 50% label composites to #7d7d7d on #e3e3e3 —
          3.2:1, under the 4.5:1 the design system requires of every label
          (spec R1, design-system §Accessibility). 70% lands at #545454, which
          clears it, and the dark theme was never the tight side. Caught by the
          showcase's axe gate once this component was drawn there; the previous
          gate measured a hand-rolled heading instead of this one. */}
      <h2
        id={headingId}
        className="text-sidebar-foreground/70 px-2 pt-1 pb-0.5 text-[11px] font-medium"
      >
        {zone.label}
      </h2>
      {/* Count changes only, held for a second before it is published: a verb or
          an unread change reaching a screen reader from here would turn a fleet
          of thirty agents into a siren (BC-11, R2). */}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {liveRegionText}
      </span>
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
