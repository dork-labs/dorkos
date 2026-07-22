import type { DashboardSectionContribution } from '@/layers/shared/model';
import { NeedsAttentionSection } from '@/layers/features/dashboard-attention';
import { SystemStatusRow } from '@/layers/features/dashboard-status';
import { RecentActivityFeed } from '@/layers/features/dashboard-activity';
import { PromoSlot } from '@/layers/features/feature-promos';
import { DashboardComposerSection } from '../ui/DashboardComposerSection';

/**
 * Built-in wrapper for PromoSlot that passes fixed props.
 * Dashboard sections are rendered as `<section.component />` with no props,
 * so the PromoSlot needs a wrapper to supply its `placement` and `maxUnits`.
 */
function PromoSlotWrapper() {
  return <PromoSlot placement="dashboard-main" maxUnits={4} />;
}

/** Built-in dashboard sections in priority order (lower number renders first). */
export const DASHBOARD_SECTION_CONTRIBUTIONS: DashboardSectionContribution[] = [
  { id: 'composer', component: DashboardComposerSection, priority: 1 },
  { id: 'needs-attention', component: NeedsAttentionSection, priority: 2 },
  { id: 'promo', component: PromoSlotWrapper, priority: 3 },
  { id: 'system-status', component: SystemStatusRow, priority: 5 },
  { id: 'recent-activity', component: RecentActivityFeed, priority: 6 },
];
