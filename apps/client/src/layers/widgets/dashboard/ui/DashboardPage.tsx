import { useCallback, useMemo } from 'react';
import { ScrollArea } from '@/layers/shared/ui';
import { useSlotContributions, isExtensionContributionId } from '@/layers/shared/model';
import {
  DeadLetterDetailSheet,
  FailedRunDetailSheet,
  OfflineAgentDetailSheet,
} from '@/layers/features/dashboard-attention';
import { useSearch, useNavigate } from '@tanstack/react-router';
import type { DashboardSearch } from '@/router';

/**
 * Dashboard page -- mission control overview composing feature sections.
 * Queries the extension registry's dashboard.sections slot and renders the
 * built-in contributions in priority order.
 *
 * Sections contributed by extensions render on the Activity tab instead, under
 * "From your extensions" — see `widgets/activity/ui/ExtensionSections.tsx`. The
 * slot id is unchanged; only where its extension half is drawn moved, so this
 * page filters them out to avoid drawing them twice.
 */
export function DashboardPage() {
  const search = useSearch({ strict: false }) as Partial<DashboardSearch>;
  const navigate = useNavigate();
  const sections = useSlotContributions('dashboard.sections');

  const visibleSections = useMemo(
    () =>
      sections.filter(
        (s) => !isExtensionContributionId(s.id) && (!s.visibleWhen || s.visibleWhen())
      ),
    [sections]
  );

  const closeDetail = useCallback(() => {
    void navigate({ to: '/', search: {} });
  }, [navigate]);

  return (
    <>
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:space-y-8 sm:px-6 sm:py-8">
          {visibleSections.map((section) => (
            <section.component key={section.id} />
          ))}
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
