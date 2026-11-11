import { useState } from 'react';
import type { LocalBrowserHandoffOutcome } from '@dorkos/shared/local-browser';
import {
  BrowserHandoffCardView,
  BrowserHandoffReceipt,
  BrowserHandoffSlot,
  type HandoffStep,
} from '@/layers/features/browser-handoff';
import { Button } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

const STEPS: Array<{
  label: string;
  step: HandoffStep;
  canShowWindow?: boolean;
  error?: string;
  moves?: boolean;
  site?: string;
}> = [
  { label: 'A check only a person can do', step: 'wall', canShowWindow: true },
  { label: 'A password page', step: 'sign-in' },
  {
    label: 'A long site, which wraps in the title and never in a button',
    step: 'sign-in',
    site: 'accounts.northwind-travel.example',
  },
  { label: 'A password page in the Mac app’s panel', step: 'sign-in', moves: true },
  { label: 'Sign-in window open', step: 'sign-in-open' },
  { label: 'Saving the sign-in', step: 'saving' },
  { label: 'Signed in', step: 'saved' },
  { label: 'Saving failed', step: 'failed' },
  { label: 'The window closed', step: 'window-closed' },
  {
    label: 'A button’s call was refused',
    step: 'wall',
    canShowWindow: true,
    error: 'This handoff already ended.',
  },
];

/** What the card becomes once the handoff ends (DOR-3112). */
const ENDINGS: Array<{ label: string; outcome: LocalBrowserHandoffOutcome }> = [
  { label: 'Ended: handed back (Continue, or the person resumed)', outcome: 'handed-back' },
  { label: 'Ended: Stop task', outcome: 'stopped' },
  { label: 'Ended: the person disconnected the window', outcome: 'window-closed' },
];

const ignore = () => undefined;

/** The card settling into its receipt, replayable, as the chat's card does it (DOR-3112). */
function SettleDemo() {
  const [ended, setEnded] = useState(false);
  return (
    <div className="flex w-full max-w-lg flex-col gap-3">
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        data-slot="browser-handoff-settle-toggle"
        onClick={() => setEnded((was) => !was)}
      >
        {ended ? 'Replay' : 'Continue'}
      </Button>
      <BrowserHandoffSlot
        card={
          ended
            ? null
            : {
                key: 'demo-card',
                node: (
                  <BrowserHandoffCardView
                    site="northwind.example"
                    agentName="Atlas"
                    agentFolder="/home/sam/agents/atlas"
                    step="wall"
                    canShowWindow
                    busy={false}
                    error={null}
                    onContinue={() => setEnded(true)}
                    onSignIn={ignore}
                    onOpenWindow={ignore}
                    onShowWindow={ignore}
                    onStop={() => setEnded(true)}
                  />
                ),
              }
        }
        receipt={
          ended
            ? {
                key: 'demo-receipt',
                node: <BrowserHandoffReceipt agentName="Atlas" outcome="handed-back" />,
              }
            : null
        }
      />
    </div>
  );
}

/** Each step of the Agent browser's handoff card, held still. A live one needs a real wall. */
export function BrowserHandoffShowcases() {
  return (
    <PlaygroundSection
      title="Browser handoff card"
      description="An agent hands the Agent browser to a person and stops. The card sits above the composer, outside the transcript, because an agent can write a message that looks like a card but can't write into this slot."
    >
      {STEPS.map(({ label, step, canShowWindow, error, moves, site }) => (
        <div key={label}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="w-full max-w-lg">
              <BrowserHandoffCardView
                site={site ?? 'northwind.example'}
                agentName="Atlas"
                agentFolder="/home/sam/agents/atlas"
                step={step}
                canShowWindow={canShowWindow ?? false}
                movesToOwnWindow={moves ?? false}
                sharedProfile={step === 'sign-in'}
                busy={false}
                error={error ?? null}
                onContinue={ignore}
                onSignIn={ignore}
                onOpenWindow={ignore}
                onShowWindow={ignore}
                onStop={ignore}
              />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
      <div>
        <ShowcaseLabel>Settling into the receipt: press Continue, then Replay</ShowcaseLabel>
        <ShowcaseDemo>
          <SettleDemo />
        </ShowcaseDemo>
      </div>
      {ENDINGS.map(({ label, outcome }) => (
        <div key={label}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <div className="w-full max-w-lg">
              <BrowserHandoffReceipt agentName="Atlas" outcome={outcome} />
            </div>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}
