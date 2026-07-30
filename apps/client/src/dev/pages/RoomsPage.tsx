import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { ROOMS_SECTIONS } from '../playground-registry';
import { RoomsShowcases } from '../showcases/RoomsShowcases';

/** Room component showcase page for the dev playground. */
export function RoomsPage() {
  return (
    <PlaygroundPageLayout
      title="Rooms"
      description="The room sheet and everything in it — the roster, the loudness scale, the agent picker, and every state each of them has."
      sections={ROOMS_SECTIONS}
    >
      <RoomsShowcases />
    </PlaygroundPageLayout>
  );
}
