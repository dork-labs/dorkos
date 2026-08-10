/**
 * One zone — Now, Getting started, Today or Library.
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
import { SidebarSection } from './SidebarSection';

/** Props for {@link SidebarZone}. */
export interface SidebarZoneProps {
  /** The zone the model emitted. */
  zone: SidebarZoneModel;
  /** Fold or unfold every Library section at once — Alt/Option-click (BC-30). */
  onToggleAll: () => void;
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
export function SidebarZone({ zone, onToggleAll }: SidebarZoneProps) {
  const headingId = `sidebar-zone-${zone.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-sidebar-zone={zone.id}
      className={cn(
        'rounded-lg px-1 py-1',
        // Now and Getting started carry the one tint that asks for a look; the
        // calm zones sit on the panel itself.
        zone.id === 'now' || zone.id === 'getting-started' ? 'bg-sidebar-accent/40' : undefined
      )}
    >
      <h2
        id={headingId}
        className="text-sidebar-foreground/50 px-2 pt-1 pb-0.5 text-[11px] font-medium"
      >
        {zone.label}
      </h2>
      {/* Count changes only, and debounced by the fact that the count is all it
          carries: a verb or an unread change reaching a screen reader from here
          would turn a fleet of thirty agents into a siren (BC-11, R2). */}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {zone.liveRegionText ?? ''}
      </span>
      {zone.sections.map((section) => (
        <SidebarSection key={section.id} section={section} onToggleAll={onToggleAll} />
      ))}
    </section>
  );
}
