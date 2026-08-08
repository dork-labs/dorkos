import type { DashboardSectionContribution } from '@/layers/shared/model';
import { PendingApprovalsSection } from '@/layers/features/approvals';
import { NeedsAttentionSection } from '@/layers/features/dashboard-attention';
import { RecentActivityFeed } from '@/layers/features/dashboard-activity';
import { DashboardComposerSection } from '../ui/DashboardComposerSection';

/**
 * Built-in dashboard sections in priority order (lower number renders first).
 *
 * Three sections were retired rather than hidden — the promo grid (the promo
 * registry itself stays, and so does its sidebar placement), "Your agents", and
 * the System Status row. Their jobs moved: the team roster to `/team` and the
 * sidebar, system health to the surfaces each card linked to, and the weekly
 * sparkline to the Activity tab. `dashboard-contributions.test.ts` keeps them
 * from coming back.
 */
export const DASHBOARD_SECTION_CONTRIBUTIONS: DashboardSectionContribution[] = [
  { id: 'composer', component: DashboardComposerSection, priority: 1 },
  // Approvals outrank attention items: an agent is blocked until you answer.
  { id: 'pending-approvals', component: PendingApprovalsSection, priority: 2 },
  { id: 'needs-attention', component: NeedsAttentionSection, priority: 3 },
  { id: 'recent-activity', component: RecentActivityFeed, priority: 4 },
];
