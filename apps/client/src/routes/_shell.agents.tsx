import { createFileRoute, redirect } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { teamSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/agents')({
  // Nothing to show: this route only redirects, so it never renders a bar.
  staticData: { header: null },
  validateSearch: zodValidator(teamSearchSchema),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/team', search, replace: true });
  },
});
