import { PageContainer, PageHeading } from '@/layers/shared/ui';
import { FeedbackRequestsPanel } from '@/layers/features/feedback-requests';

/**
 * "Your reports" page at `/feedback-requests` (feedback-pipeline
 * Part 4, design-decisions.md §7). Opens from the help menu — a parallel PR
 * (C) wires that entry point; this page owns the route and the view itself.
 */
export function FeedbackRequestsPage() {
  return (
    <PageContainer width="wide" scroll={false}>
      <header className="mb-6 shrink-0">
        {/* Not drawn (design decision E1): the bar overhead already says
            "Your reports". Kept for the outline — the bar's title is a
            `nav` landmark, not a heading. */}
        <PageHeading>Your reports</PageHeading>
        <p className="text-muted-foreground text-sm">
          What you’ve sent the DorkOS team, and where it stands.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <FeedbackRequestsPanel />
      </div>
    </PageContainer>
  );
}
