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
 */
export function HomeStatesShowcases() {
  return (
    <PlaygroundSection
      title="Day one and the quiet morning"
      description="Two honest answers on the home surface. A room with nothing in it offers openers on the composer — pressing one writes it into the box, and does not send it. A room with a history and nothing needing an answer says 'All quiet.' and, if there is a scheduled run ahead, names it. With nothing real ahead, the second sentence is left off rather than padded."
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
    </PlaygroundSection>
  );
}
