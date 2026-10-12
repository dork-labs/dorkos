import { createFileRoute } from '@tanstack/react-router';
import { TeamRoute } from '@/layers/widgets/team';
import { TeamComputerEntry } from '@/layers/features/agent-computer';
import { TeamHeader } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { teamSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/team')({
  staticData: { header: TeamHeader },
  validateSearch: zodValidator(teamSearchSchema),
  component: TeamWithComputer,
});

/** Keep the roster available beside the default-off computer experiment. */
function TeamWithComputer() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TeamComputerEntry />
      <div className="min-h-0 flex-1">
        <TeamRoute />
      </div>
    </div>
  );
}
