import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { FeedbackListItem } from '@dorkos/shared/telemetry-events';

/** Query-key prefix for the "Product feedback" tracking list. */
export const MY_FEEDBACK_KEY = ['feedback', 'mine'] as const;

/**
 * Fetch this install's own feedback submissions for the "Product feedback"
 * tracking view (feedback-pipeline Part 4, decision 260803-205035).
 *
 * `Transport.listMyFeedback()` rejects on failure (unlike the send path's
 * honest `{ ok }`), so TanStack Query's own `isError`/`error` surfaces it —
 * the panel renders that as its error state rather than an empty list.
 */
export function useMyFeedback() {
  const transport = useTransport();
  return useQuery<FeedbackListItem[]>({
    queryKey: MY_FEEDBACK_KEY,
    queryFn: () => transport.listMyFeedback(),
  });
}
