import type { TaskRunPlace } from '@dorkos/shared/types';
import { shortenHomePath } from '@/layers/shared/lib';

/** The headline for one place, naming the agent when its name is known. */
function placeLabel(place: TaskRunPlace, agentName: string | null | undefined): string {
  const owner = agentName ? `${agentName}'s` : "the agent's";
  switch (place.kind) {
    case 'agent':
      return agentName ? `${owner} folder` : "The agent's folder";
    case 'agent_checkout':
      return `A private copy of ${owner} project`;
    case 'folder':
      return place.of === 'default' ? "DorkOS's default folder" : 'The folder DorkOS runs in';
    case 'private':
      return 'A fresh private folder';
  }
}

/**
 * The card's Where fact (DOR-4067): the folder the runs would stand in, as the
 * server read it with the run's own folder chain and guard. Nothing is drawn
 * when it sent none.
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
  const path = place.kind === 'agent' || place.kind === 'folder' ? place.path : null;
  const unmade = place.kind === 'agent_checkout' && !place.ready;
  return (
    <div className="min-w-0 text-xs">
      <p data-slot="schedule-run-place" className="min-w-0 break-words">
        Where: {placeLabel(place, agentName)}
      </p>
      {path && (
        <p
          data-slot="schedule-run-place-path"
          className="text-muted-foreground min-w-0 font-mono break-all"
        >
          {shortenHomePath(path)}
        </p>
      )}
      {unmade && (
        <p data-slot="schedule-run-place-note" className="text-muted-foreground min-w-0">
          Not made yet. Until it is, runs use {agentName ? `${agentName}'s` : "the agent's"} folder.
        </p>
      )}
    </div>
  );
}
