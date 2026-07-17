import { useFleetContextRollup } from '@/layers/entities/session';

/**
 * A quiet fleet-level context summary bar (spec §8b), modeled on
 * `RelayHealthBar`'s `border-b px-3 py-1.5 text-xs` shell + severity-dot idiom.
 * Fed by {@link useFleetContextRollup}, it answers "which of my agents are
 * close to their context ceiling?" at a glance:
 *
 * - **All healthy** — "All sessions have room." (a resolvable reading exists
 *   and nothing is near full or freshly compacted).
 * - **Under pressure** — "{n} near full · {m} auto-compacted", where
 *   `n = warning + critical` and `m = autoCompacted`, DROPPING a clause whose
 *   count is 0.
 * - **Nothing to say** — hidden entirely (no known readings AND nothing near
 *   full or compacted); never renders "0 near full".
 *
 * The whole-runtime-failure case is already surfaced by the ADR-0310
 * `warnings[]` block in `SessionsView`, so the bar does not re-report it.
 * Placement-agnostic: it renders its own row and can sit anywhere.
 */
export function FleetContextBar() {
  const { known, warning, critical, autoCompacted } = useFleetContextRollup();
  const nearFull = warning + critical;

  // Nothing to say ⇒ no bar. Never render a "0 near full" line.
  if (known === 0 && nearFull === 0 && autoCompacted === 0) return null;

  const hasPressure = nearFull > 0 || autoCompacted > 0;

  // Dot reflects the hottest signal: red for any at-the-ceiling session, amber
  // for near-full pressure, muted for compaction-only, emerald when all healthy.
  const dotColor = !hasPressure
    ? 'bg-emerald-500'
    : critical > 0
      ? 'bg-red-500'
      : nearFull > 0
        ? 'bg-amber-500'
        : 'bg-muted-foreground/40';

  const message = !hasPressure
    ? 'All sessions have room.'
    : [
        nearFull > 0 ? `${nearFull} near full` : null,
        autoCompacted > 0 ? `${autoCompacted} auto-compacted` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <div
      className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 text-xs"
      data-testid="fleet-context-bar"
    >
      <span className={`size-2 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
      <span className="truncate">{message}</span>
    </div>
  );
}
