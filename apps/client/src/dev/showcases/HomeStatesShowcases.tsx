import { useState } from 'react';
import { QuietSuggestionView } from '@/layers/features/feature-promos';
import { HOME_STARTER_CHIPS, QuietStateLine, RoomStarterChips } from '@/layers/widgets/home';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * Frozen at module load: `Date.now()` during render is impure
 * (`react-hooks/purity`), and a sentence whose clock drifts on every re-render is
 * harder to read than one that does not.
 */
const TOMORROW_MORNING = (() => {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
})();

/**
 * The two states a real cockpit only reaches at the two moments you cannot ask
 * for: its first morning, and a morning when nothing happened.
 *
 * Day one goes the instant somebody says something, and a quiet morning goes the
 * instant anything needs answering — so neither survives long enough to be
 * looked at properly on a machine that is actually being used. Drawn here from
 * props, with the forward look written out by hand: in the app it is only ever
 * read off a real scheduled run, and there is no run to read here.
 *
 * The quiet morning is drawn four ways, because DorkBot may add one suggestion
 * beneath it (spec D5.3) and that second line has to hold up both over a bare
 * "All quiet." and under a forward look naming a real run.
 */
export function HomeStatesShowcases() {
  return (
    <PlaygroundSection
      title="Day one and the quiet morning"
      description="Two honest answers on the home surface. A room with nothing in it offers openers on the composer — pressing one writes it into the box, and does not send it. A room with a history and nothing needing an answer says 'All quiet.' and, if there is a scheduled run ahead, names it. With nothing real ahead, the second sentence is left off rather than padded — and that is the one place DorkBot may offer a single suggestion instead."
    >
      <ShowcaseLabel>Day one: the openers, above the composer</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <RoomStarterChips roomId="playground-room" />
          <p className="text-muted-foreground mt-3 px-4 text-xs sm:px-6">
            Composer sits here. A press fills it — {HOME_STARTER_CHIPS.length} openers, no wizard.
          </p>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Quiet, with something ahead</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <QuietStateLine
            forwardLook={`Next up: Morning standup runs tomorrow at ${TOMORROW_MORNING}.`}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Quiet, with nothing ahead — two words, and it stops</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full">
          <QuietStateLine forwardLook={null} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Quiet, plus DorkBot&rsquo;s one suggestion underneath — press either side
      </ShowcaseLabel>
      <ShowcaseDemo>
        <QuietSuggestionDemo forwardLook={null} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        The same suggestion under a real run — a second line, quieter than the first
      </ShowcaseLabel>
      <ShowcaseDemo>
        <QuietSuggestionDemo
          forwardLook={`Next up: Morning standup runs tomorrow at ${TOMORROW_MORNING}.`}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The suggestion, drivable: press the action, press the dismiss, and see what a
 * reader sees — with and without a run ahead of it.
 *
 * Drawn from the presentational half with copy written out by hand, because the
 * wired one only speaks to somebody who qualifies for a feature they have not
 * set up, which the machine running the playground usually does not. Dismissing
 * here resets on reload and touches no stored preference; in the app the answer
 * is remembered and the line does not come back — on this surface or on the
 * sidebar card behind it.
 *
 * @param props - The forward look to draw above the suggestion, or `null`.
 */
function QuietSuggestionDemo({ forwardLook }: { forwardLook: string | null }) {
  const [dismissed, setDismissed] = useState(false);
  const [taken, setTaken] = useState(false);

  return (
    <div className="w-full">
      <QuietStateLine
        forwardLook={forwardLook}
        suggestion={
          dismissed ? null : (
            <QuietSuggestionView
              suggestion={{
                question: 'Want your agents working without you at the keyboard?',
                action: 'Set up a schedule',
              }}
              promoTitle="Run agents on a schedule"
              onAccept={() => setTaken(true)}
              onDismiss={() => setDismissed(true)}
            />
          )
        }
      />
      <p className="text-muted-foreground mt-3 px-4 text-xs sm:px-6">
        {dismissed
          ? 'Dismissed. In the app that answer is remembered, and this line does not come back.'
          : taken
            ? 'Accepted — in the app this opens the schedules dialog.'
            : 'One suggestion at a time, and only if this install qualifies for it.'}
      </p>
    </div>
  );
}
