import type { DashboardSectionContribution } from '@/layers/shared/model';
import { NeedsAttentionSection } from '@/layers/features/dashboard-attention';
import { ActiveSessionsSection } from '@/layers/features/dashboard-sessions';
import { SystemStatusRow } from '@/layers/features/dashboard-status';
import { RecentActivityFeed } from '@/layers/features/dashboard-activity';
import { PromoSlot } from '@/layers/features/feature-promos';

/**
 * Built-in wrapper for PromoSlot that passes fixed props.
 * Dashboard sections are rendered as `<section.component />` with no props,
 * so the PromoSlot needs a wrapper to supply its `placement` and `maxUnits`.
 */
function PromoSlotWrapper() {
  return <PromoSlot placement="dashboard-main" maxUnits={4} />;
}

/** Built-in dashboard sections in priority order. */
export const DASHBOARD_SECTION_CONTRIBUTIONS: DashboardSectionContribution[] = [
  { id: 'needs-attention', component: NeedsAttentionSection, priority: 1 },
  { id: 'promo', component: PromoSlotWrapper, priority: 2 },
  { id: 'active-sessions', component: ActiveSessionsSection, priority: 3 },
  { id: 'system-status', component: SystemStatusRow, priority: 4 },
  { id: 'recent-activity', component: RecentActivityFeed, priority: 5 },
];
