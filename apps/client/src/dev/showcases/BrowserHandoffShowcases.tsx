import { BrowserHandoffCardView, type HandoffStep } from '@/layers/features/browser-handoff';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const STEPS: Array<{ label: string; step: HandoffStep; canShowWindow?: boolean; error?: string }> =
  [
    { label: 'A check only a person can do', step: 'wall', canShowWindow: true },
    { label: 'A password page', step: 'sign-in' },
    { label: 'Sign-in window open', step: 'sign-in-open' },
    { label: 'Saving the sign-in', step: 'saving' },
    { label: 'Signed in', step: 'saved' },
    { label: 'Saving failed', step: 'failed' },
    { label: 'A password page in the Mac app’s built-in browser', step: 'panel-sign-in' },
    {
      label: 'A button’s call was refused',
      step: 'wall',
      canShowWindow: true,
      error: 'This handoff already ended.',
    },
  ];

const ignore = () => undefined;

/** Each step of the Agent browser's handoff card, held still. A live one needs a real wall. */
export function BrowserHandoffShowcases() {
  return (
    <PlaygroundSection
      title="Browser handoff card"
      description="An agent hands the Agent browser to a person and stops. The card sits above the composer, outside the transcript, because an agent can write a message that looks like a card but can't write into this slot."
    >
      {STEPS.map(({ label, step, canShowWindow, error }) => (
        <div key={label}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="w-full max-w-lg">
              <BrowserHandoffCardView
                site="northwind.example"
                agentName="Atlas"
                agentFolder="/home/sam/agents/atlas"
                step={step}
                canShowWindow={canShowWindow ?? false}
                busy={false}
                error={error ?? null}
                onContinue={ignore}
                onSignIn={ignore}
                onShowWindow={ignore}
                onStop={ignore}
              />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}
