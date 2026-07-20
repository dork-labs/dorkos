import { PulseAttentionSection } from './PulseAttentionSection';
import { PulseActivitySection } from './PulseActivitySection';

/**
 * Pulse — the always-present global spine tab of the right inspector panel.
 *
 * The first tab on every route and the panel's no-selection fallback: contextual
 * tabs win when present, but where none apply Pulse fills the space so the shell
 * is never a dead panel (research: `20260720_context-aware-right-inspector-panels`,
 * the promote-global rule). Its body is a stack of capped teasers assembled from
 * existing dashboard models — this surface invents no new data source:
 *
 *  1. Needs attention — the top items that need the operator, deep-linked to
 *     their subjects, overflowing to the dashboard.
 *  2. Activity — a most-recent-first peek at recent activity, overflowing to
 *     /activity (Linear's state-vs-history split).
 *
 * Each section collapses to a calm one-line all-clear rather than vanishing, so
 * Pulse always has a body.
 *
 * Usage is intentionally omitted, not collapsed: the spend/context meters in the
 * status feature are session-scoped — their `UsageStatus` is derived from a
 * single session's SSE stream, and no honest off-session aggregate exists (the
 * server's usage-reporter is fire-and-forget telemetry, not a queryable total).
 * Honesty over completeness: we render nothing here rather than fake a number. A
 * real cross-session spend aggregate is the DOR-370 spend-meter decision to fund;
 * a Usage section joins Pulse when that data source lands.
 */
export function PulsePanel() {
  return (
    <div data-slot="pulse" className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <PulseAttentionSection />
      <PulseActivitySection />
    </div>
  );
}
