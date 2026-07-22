import { useEffect, useState } from 'react';

import { TOUR_ANCHORS, type TourStep } from '@/layers/shared/config';
import { Button } from '@/layers/shared/ui';
import { TourSpotlight } from '@/layers/shared/ui';

import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The three-step spike tour over real anchors rendered in this showcase. */
const SPIKE_STEPS: TourStep[] = [
  {
    anchor: TOUR_ANCHORS.dashboardComposer,
    caption: 'Step 1. This is the spotlight: a dimmed page, a cutout, and my caption beside it.',
    chipLabel: 'Next',
  },
  {
    anchor: TOUR_ANCHORS.yourAgents,
    caption:
      'Step 2. The cutout morphs to the next target. Press Esc or click outside to leave any time.',
    chipLabel: 'Next',
  },
  {
    anchor: TOUR_ANCHORS.navTasks,
    caption: 'Step 3. This target mounts a beat late to prove the anchor wait. Last step.',
    chipLabel: 'Got it',
  },
];

/** A tour whose anchor never mounts, to show the honest timeout-skip. */
const MISSING_ANCHOR_STEPS: TourStep[] = [
  {
    anchor: TOUR_ANCHORS.relayChannels,
    caption:
      'You should never see this: the anchor is absent, so the step skips after four seconds.',
  },
];

/**
 * Phase 0 spike (DOR-419): the living proof that `@reactour/tour`, behind our
 * `TourSpotlight` wrapper, clears the spike bar — deep-link-style async anchors
 * with timeout-skip (S1), a fully custom caption (S2), a mobile bottom sheet
 * (S3, resize the viewport under 768px), the accessibility bar (S4: Esc,
 * click-outside, focus trap, inert background, our aria-live announcer), and a
 * smooth cutout transition (S5). Drive it here against real anchors.
 */
export function TourSpotlightShowcases() {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [lateTargetMounted, setLateTargetMounted] = useState(false);

  // The third target mounts ~800ms after the tour starts, exercising the poll.
  useEffect(() => {
    if (steps === null) return;
    const id = setTimeout(() => setLateTargetMounted(true), 800);
    return () => clearTimeout(id);
  }, [steps]);

  const startTour = (next: TourStep[]) => {
    setActiveIndex(0);
    setLateTargetMounted(false);
    setSteps(next);
  };

  const endTour = () => setSteps(null);

  return (
    <PlaygroundSection
      title="Tour Spotlight"
      description="The DorkBot spotlight primitive over @reactour/tour: async anchors, custom caption, full a11y bar, reduced-motion and mobile branches."
    >
      <ShowcaseLabel>Run the three-step tour over real anchors</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => startTour(SPIKE_STEPS)}>Start tour</Button>
            <Button variant="outline" onClick={() => startTour(MISSING_ANCHOR_STEPS)}>
              Start tour with a missing anchor (timeout-skip)
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div
              data-testid={TOUR_ANCHORS.dashboardComposer}
              className="bg-card shadow-soft rounded-lg border p-4 text-sm"
            >
              Composer target
            </div>
            <div
              data-testid={TOUR_ANCHORS.yourAgents}
              className="bg-card shadow-soft rounded-lg border p-4 text-sm"
            >
              Your agents target
            </div>
            {lateTargetMounted ? (
              <div
                data-testid={TOUR_ANCHORS.navTasks}
                className="bg-card shadow-soft rounded-lg border p-4 text-sm"
              >
                Late target (mounts after 800ms)
              </div>
            ) : (
              <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                Late target not mounted yet…
              </div>
            )}
          </div>
        </div>
      </ShowcaseDemo>

      {steps !== null && (
        <TourSpotlight
          steps={steps}
          activeIndex={activeIndex}
          onAdvance={() => setActiveIndex((i) => i + 1)}
          onEnd={endTour}
        />
      )}
    </PlaygroundSection>
  );
}
