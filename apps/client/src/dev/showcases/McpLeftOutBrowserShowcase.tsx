import { Switch } from '@/layers/shared/ui';
import { McpServerCard } from '@/layers/features/agent-settings';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/**
 * A browser DorkOS leaves out of every session (DOR-3207): on, as the person set it, but never
 * run, so the card says "Not used" and why. Shown at the same panel width as its siblings.
 */
export function McpLeftOutBrowserShowcase() {
  return (
    <>
      <ShowcaseLabel>
        Not used — a browser with a custom path or shared profile (DOR-3207)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-[340px]">
          <McpServerCard
            displayName="browser"
            rawName="browser"
            scope="agent"
            pluginName={null}
            status="not-used"
            sentence="DorkOS uses its own browser for agents. Custom browser paths aren't allowed."
            managed
            toggle={<Switch checked onCheckedChange={() => {}} aria-label="Enable browser" />}
          />
        </div>
      </ShowcaseDemo>
    </>
  );
}
