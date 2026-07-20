import type { ReactNode } from 'react';

interface PulseSectionProps {
  /** Quiet uppercase section label, e.g. "Needs attention". */
  label: string;
  /**
   * When true the section has nothing to show: it collapses to the calm,
   * one-line {@link allClear} message instead of vanishing, so Pulse always keeps
   * a body (research: `20260720_context-aware-right-inspector-panels` — promote
   * global content, never leave a dead panel).
   */
  empty: boolean;
  /** The calm one-line all-clear message shown when {@link empty}. */
  allClear: string;
  /**
   * Optional overflow link (e.g. "View all →") rendered at the right of the
   * label. Hidden while {@link empty} — there is nothing more to view.
   */
  action?: ReactNode;
  /** The section body — rendered only when not {@link empty}. */
  children?: ReactNode;
}

/**
 * One labelled section of the Pulse panel — a quiet uppercase label with an
 * optional overflow link, collapsing to a calm all-clear line when it has
 * nothing to show. The shared frame keeps every Pulse section visually
 * consistent (attention, activity) and guarantees the panel is never blank.
 *
 * @param props - The section label, empty/all-clear state, optional overflow
 *   action, and body.
 */
export function PulseSection({ label, empty, allClear, action, children }: PulseSectionProps) {
  return (
    <section>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          {label}
        </h3>
        {!empty && action}
      </div>
      {empty ? <p className="text-muted-foreground/70 text-xs">{allClear}</p> : children}
    </section>
  );
}
