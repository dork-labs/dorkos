import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { ROOMS_SECTIONS } from '../playground-registry';
import { RoomsShowcases } from '../showcases/RoomsShowcases';
import { RoomThreadShowcases } from '../showcases/RoomThreadShowcases';

/** Room component showcase page for the dev playground. */
export function RoomsPage() {
  return (
    <PlaygroundPageLayout
      title="Rooms"
      description="The room sheet and everything in it — the roster, the loudness scale, the agent picker, and every state each of them has. Below that, the thread side panel: the reply row that opens it, the panel itself, and the arrival animations a live reply triggers."
      sections={ROOMS_SECTIONS}
    >
      <RoomsShowcases />
      <RoomThreadShowcases />
    </PlaygroundPageLayout>
  );
}
