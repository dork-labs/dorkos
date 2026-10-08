import { createFileRoute } from '@tanstack/react-router';
import { TeamRoute } from '@/layers/widgets/team';
import { TeamHeader } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { teamSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/team')({
  staticData: { header: TeamHeader },
  validateSearch: zodValidator(teamSearchSchema),
  component: TeamRoute,
});
