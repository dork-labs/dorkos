'use client';

import { STAGE_TREATMENTS, type StageTreatment } from './stage-treatment';

interface TreatmentToggleProps {
  /** The ending currently playing. */
  value: StageTreatment;
  /** Switch to the other one. */
  onChange: (next: StageTreatment) => void;
}

/**
 * A corner switch for comparing the stage's two endings.
 *
 * Furniture, not product: it exists so the two treatments can be judged
 * against each other on the same scroll, in the same session, and it comes off
 * the page with whichever one loses. It says so out loud in its label rather
 * than pretending to be a setting.
 *
 * Two real buttons, not a styled div: the choice has to be reachable by
 * keyboard, and `aria-pressed` is what tells a screen reader which of the two
 * is currently on without inventing a widget role for a pair of buttons.
 *
 * It sits at `z-[120]`, above the cookie banner's 110 and the pill nav's 100.
 * Furniture a consent banner can bury is furniture nobody can use on a phone,
 * which is the width the comparison most needs to happen at.
 */
export function TreatmentToggle({ value, onChange }: TreatmentToggleProps) {
  return (
    <div
      role="group"
      aria-label="Stage ending (comparison only)"
      className="border-border-warm bg-cream-primary/90 fixed bottom-4 left-4 z-[120] flex gap-0.5 rounded-full border p-0.5 shadow-sm backdrop-blur"
    >
      {STAGE_TREATMENTS.map((treatment) => {
        const active = treatment === value;
        return (
          <button
            key={treatment}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(treatment)}
            className={`focus-visible:ring-brand-orange text-2xs rounded-full px-3 py-1 font-mono tracking-[0.12em] uppercase transition-colors focus-visible:ring-2 focus-visible:outline-none ${
              active ? 'bg-charcoal text-cream-primary' : 'text-warm-gray hover:text-charcoal'
            }`}
          >
            {treatment}
          </button>
        );
      })}
    </div>
  );
}
