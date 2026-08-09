import { PromptSuggestionChips } from '@/layers/shared/ui';
import { HOME_STARTER_CHIPS } from '@/layers/widgets/home';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/**
 * The one chip row this app has, in both the sizes it comes in.
 *
 * It lives on the Components page rather than under Chat because it is a
 * `shared/ui` primitive with two callers: chat's model-offered follow-ups and
 * the home surface's day-one openers. Filed under Chat, the second caller had
 * nowhere to be looked at, and "is this the same chip?" had no answer you could
 * see.
 */
export function PromptSuggestionChipsShowcases() {
  return (
    <PlaygroundSection
      title="PromptSuggestionChips"
      description="One-press lines that put words in a composer. Compact follows an answer already on screen (chat's model-offered follow-ups); comfortable is the only thing worth pressing on the screen it appears on (the home surface's day-one openers), so it is a 36px target with room for the words. At most four are drawn, and anything longer than the row's cap truncates with the full text on hover."
    >
      <ShowcaseLabel>Compact — chat follow-ups</ShowcaseLabel>
      <ShowcaseDemo>
        <PromptSuggestionChips
          suggestions={['Run the tests', 'Review the changes', 'Commit this work']}
          onChipClick={() => {}}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Comfortable — the day-one openers, as home draws them</ShowcaseLabel>
      <ShowcaseDemo>
        <PromptSuggestionChips
          suggestions={HOME_STARTER_CHIPS}
          onChipClick={() => {}}
          ariaLabel="Ways to start"
          size="comfortable"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Long lines truncate — the full text stays on hover</ShowcaseLabel>
      <ShowcaseDemo>
        <PromptSuggestionChips
          suggestions={[
            'Can you refactor the authentication module to use JWT tokens instead?',
            'Show me the test coverage report for the shared package',
            'Deploy to staging',
            'Fix the TypeScript errors in the relay package',
          ]}
          onChipClick={() => {}}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>A fifth line is not drawn — four is the row</ShowcaseLabel>
      <ShowcaseDemo>
        <PromptSuggestionChips
          suggestions={['One', 'Two', 'Three', 'Four', 'Five (not drawn)']}
          onChipClick={() => {}}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Single suggestion</ShowcaseLabel>
      <ShowcaseDemo>
        <PromptSuggestionChips suggestions={['Run the tests']} onChipClick={() => {}} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
