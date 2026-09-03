import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { PulsePanel } from '@/layers/widgets/pulse';

/**
 * `PulsePanel` in its all-clear fallback state.
 *
 * The real component, unseeded: every hook it reads through — attention
 * signals, pending approvals and schedules, recent sessions, dashboard
 * activity — answers empty against the playground's ambient transport, which
 * is exactly the state each section falls back to when nothing needs the
 * operator. Showcasing the POPULATED state would mean seeding six data
 * sources across TanStack Query and a global Zustand session-list store
 * (`useAttentionSignals` alone joins approvals, parked schedules, recent
 * sessions, live session lifecycle, pending interactions and the mesh
 * roster) — mutating that store here would leak into any other section
 * mounted on the same page, so it is left to a future pass rather than
 * risking a misleading or flaky demo.
 */
export function PulsePanelShowcase() {
  return (
    <PlaygroundSection
      title="PulsePanel"
      description="The always-present global spine tab of the right inspector panel — the first tab on every route and the panel's no-selection fallback. Two capped teasers, each collapsing to a calm one-line all-clear rather than vanishing."
    >
      <ShowcaseDemo>
        <div className="bg-background h-80 max-w-sm overflow-hidden rounded-lg border">
          <PulsePanel />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
