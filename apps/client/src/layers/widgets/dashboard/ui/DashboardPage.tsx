import { useCallback } from 'react';
import { ScrollArea } from '@/layers/shared/ui';
import {
  NeedsAttentionSection,
  DeadLetterDetailSheet,
  FailedRunDetailSheet,
  OfflineAgentDetailSheet,
} from '@/layers/features/dashboard-attention';
import { ActiveSessionsSection } from '@/layers/features/dashboard-sessions';
import { SystemStatusRow } from '@/layers/features/dashboard-status';
import { RecentActivityFeed } from '@/layers/features/dashboard-activity';
import { useSearch, useNavigate } from '@tanstack/react-router';
import type { DashboardSearch } from '@/router';

/**
 * Dashboard page — mission control overview composing feature sections.
 * Answers questions in priority order:
 * 1. Does anything need my attention?
 * 2. What is active right now?
 * 3. Is the system healthy?
 *
 * Orchestrator widget that composes feature-level sections in a scrollable container.
 * Reads `?detail=` and `?itemId=` search params to open detail Sheets.
 */
export function DashboardPage() {
  const search = useSearch({ strict: false }) as Partial<DashboardSearch>;
  const navigate = useNavigate();

  const closeDetail = useCallback(() => {
    void navigate({ to: '/', search: {} });
  }, [navigate]);

  return (
    <>
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:space-y-8 sm:px-6 sm:py-8">
          <NeedsAttentionSection />
          <ActiveSessionsSection />
          <SystemStatusRow />
          <RecentActivityFeed />
        </div>
      </ScrollArea>

      <DeadLetterDetailSheet
        open={search.detail === 'dead-letter'}
        itemId={search.itemId}
        onClose={closeDetail}
      />
      <FailedRunDetailSheet
        open={search.detail === 'failed-run'}
        itemId={search.itemId}
        onClose={closeDetail}
      />
      <OfflineAgentDetailSheet open={search.detail === 'offline-agent'} onClose={closeDetail} />
    </>
  );
}
