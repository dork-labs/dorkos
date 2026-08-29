import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { ROOMS_SECTIONS } from '../playground-registry';
import { FileExplorerShowcases } from '../showcases/FileExplorerShowcases';
import { RoomDeliveryShowcases } from '../showcases/RoomDeliveryShowcases';
import { RoomsShowcases } from '../showcases/RoomsShowcases';
import { RoomThreadShowcases } from '../showcases/RoomThreadShowcases';

/** Room component showcase page for the dev playground. */
export function RoomsPage() {
  return (
    <PlaygroundPageLayout
      title="Rooms"
      description="The room sheet and everything in it — the roster, the loudness scale, the agent picker, and every state each of them has. Below that, the thread side panel: the reply row that opens it, the panel itself, and the arrival animations a live reply triggers. Then a room's own files: one explorer, read-only over a commit, with who last touched each path. Last, what a room says about delivery — its five notices, and the row that holds your words while they are in the air."
      sections={ROOMS_SECTIONS}
    >
      <RoomsShowcases />
      <FileExplorerShowcases />
      <RoomThreadShowcases />
      <RoomDeliveryShowcases />
    </PlaygroundPageLayout>
  );
}
