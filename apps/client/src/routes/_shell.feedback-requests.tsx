import { createFileRoute } from '@tanstack/react-router';
import { FeedbackRequestsPage } from '@/layers/widgets/feedback-requests';
import { FeedbackRequestsBar } from '../app/route-headers';

export const Route = createFileRoute('/_shell/feedback-requests')({
  staticData: { header: FeedbackRequestsBar },
  component: FeedbackRequestsPage,
});
