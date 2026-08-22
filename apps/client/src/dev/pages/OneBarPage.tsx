import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { ONE_BAR_SECTIONS } from '../playground-registry';
import { OneBarShowcases } from '../showcases/OneBarShowcases';

/**
 * The One Bar page — the single header row every route gets, and the tab strip
 * that fills its identity zone.
 *
 * Each bar is shown inside a 36px frame with the shell's hairline and gutters,
 * because a bar rendered without a box that can run out of room says nothing
 * about how it behaves when it does.
 */
export function OneBarPage() {
  return (
    <PlaygroundPageLayout
      title="One Bar"
      description="One header row per page: identity, state chips, page actions, and a fixed cluster of search, inbox and right-panel toggle that nothing may render past."
      sections={ONE_BAR_SECTIONS}
    >
      <OneBarShowcases />
    </PlaygroundPageLayout>
  );
}
