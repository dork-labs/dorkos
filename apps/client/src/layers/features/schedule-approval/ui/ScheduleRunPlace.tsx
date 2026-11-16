import type { TaskRunPlace } from '@dorkos/shared/types';
import { shortenHomePath } from '@/layers/shared/lib';

/**
 * The card's Where fact (DOR-4067): the folder the runs would stand in, as the
 * server read it with the run's own guard. Nothing is drawn when it sent none.
 *
 * @param place - The server's answer.
 * @param agentName - The agent the schedule runs as, when its name is known.
 */
export function ScheduleRunPlace({
  place,
  agentName,
}: {
  place: TaskRunPlace | undefined;
  agentName: string | null | undefined;
}) {
  if (!place) return null;
  const owner = agentName ? `${agentName}'s` : "The agent's";
  const where =
    place.kind === 'agent'
      ? `${owner} folder`
      : place.kind === 'agent_checkout'
        ? `A private copy of ${agentName ? owner : "the agent's"} project`
        : place.kind === 'folder'
          ? "DorkOS's default folder"
          : 'A fresh private folder';
  const path = place.kind === 'agent' || place.kind === 'folder' ? place.path : null;
  return (
    <div className="min-w-0 text-xs">
      <p data-slot="schedule-run-place" className="min-w-0 break-words">
        Where: {where}
      </p>
      {path && (
        <p
          data-slot="schedule-run-place-path"
          className="text-muted-foreground min-w-0 font-mono break-all"
        >
          {shortenHomePath(path)}
        </p>
      )}
    </div>
  );
}
