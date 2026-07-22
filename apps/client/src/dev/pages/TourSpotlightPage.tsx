import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { TOUR_SPOTLIGHT_SECTIONS } from '../playground-registry';
import { TourSpotlightShowcases } from '../showcases/TourSpotlightShowcases';

/** Living documentation for the DorkBot spotlight primitive (DOR-419 spike). */
export function TourSpotlightPage() {
  return (
    <PlaygroundPageLayout
      title="Tour Spotlight"
      description="The DorkBot living-tour spotlight primitive: async anchors, custom caption, and the full accessibility bar over @reactour/tour."
      sections={TOUR_SPOTLIGHT_SECTIONS}
    >
      <TourSpotlightShowcases />
    </PlaygroundPageLayout>
  );
}
