import { ScrollArea } from '@/layers/shared/ui';
import { NeedsAttentionSection } from '@/layers/features/dashboard-attention';
import { ActiveSessionsSection } from '@/layers/features/dashboard-sessions';
import { SystemStatusRow } from '@/layers/features/dashboard-status';
import { RecentActivityFeed } from '@/layers/features/dashboard-activity';

/**
 * Dashboard page — mission control overview composing feature sections.
 * Answers questions in priority order:
 * 1. Does anything need my attention?
 * 2. What is active right now?
 * 3. Is the system healthy?
 *
 * Orchestrator widget that composes feature-level sections in a scrollable container.
 */
export function DashboardPage() {
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <NeedsAttentionSection />
        <ActiveSessionsSection />
        <SystemStatusRow />
        <RecentActivityFeed />
      </div>
    </ScrollArea>
  );
}
