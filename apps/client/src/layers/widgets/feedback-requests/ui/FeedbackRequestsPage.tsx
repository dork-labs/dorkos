import { PageContainer } from '@/layers/shared/ui';
import { FeedbackRequestsPanel } from '@/layers/features/feedback-requests';

/**
 * "Feedback & requests" page at `/feedback-requests` (feedback-pipeline
 * Part 4, design-decisions.md §7). Opens from the help menu — a parallel PR
 * (C) wires that entry point; this page owns the route and the view itself.
 */
export function FeedbackRequestsPage() {
  return (
    <PageContainer width="wide" scroll={false}>
      <header className="mb-6 shrink-0">
        <h1 className="text-xl font-semibold">Product feedback</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What you&apos;ve sent the DorkOS team, and where it stands.
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <FeedbackRequestsPanel />
      </div>
    </PageContainer>
  );
}
