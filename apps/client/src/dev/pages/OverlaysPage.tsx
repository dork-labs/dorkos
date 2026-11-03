import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { OVERLAYS_SECTIONS } from '../playground-registry';
import { OverlaySurfaceShowcases } from '../showcases/OverlaySurfaceShowcases';

/** Every surface above the page, side by side, for the dev playground. */
export function OverlaysPage() {
  return (
    <PlaygroundPageLayout
      title="Overlays"
      description="Menus, popovers, tooltips, dialogs, sheets and drawers on one surface."
      sections={OVERLAYS_SECTIONS}
    >
      <OverlaySurfaceShowcases />
    </PlaygroundPageLayout>
  );
}
