import { BrowserChrome } from '@/layers/shared/ui';
import { BrowserStatusPill, type BrowserPillState } from '@/layers/features/local-browser';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Made-up: an agent asked two minutes before this fixed "now". */
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const ASKED_AT = '2026-11-15T11:58:00.000Z';

/** Every pill state the chrome can show, with made-up sites and a made-up agent. */
const STATES: { label: string; state: BrowserPillState }[] = [
  { label: 'P1 · Atlas is using the page (the seam turns orange)', state: { kind: 'driving' } },
  { label: 'P2 · Paused', state: { kind: 'paused' } },
  {
    label: 'P3 · Your turn: the one orange pill, naming the real site',
    state: {
      kind: 'your-turn',
      site: 'northwind.example',
      reason: 'password',
      handoffId: 'demo',
      askedAt: ASKED_AT,
    },
  },
  { label: 'P4 · You took the page', state: { kind: 'you' } },
  { label: 'P5 · Handed back (for 4 seconds)', state: { kind: 'handed-back' } },
  { label: 'P6 · Only you', state: { kind: 'only-you' } },
  { label: 'P7 · In another chat', state: { kind: 'elsewhere' } },
  {
    label: 'P8 · Paused for a sign-in elsewhere',
    state: { kind: 'paused-sign-in', sessionId: 'demo-chat' },
  },
  { label: 'P9 · Waiting for a page', state: { kind: 'waiting' } },
];

/** Every action a state can offer, all doing nothing here. */
const NOOP_ACTIONS = {
  onTakeOver: () => {},
  onPause: () => {},
  onResume: () => {},
  onHandBack: () => {},
  onSeeRequest: () => {},
  onShowSignIn: () => {},
};

/** One chrome at a fixed width with the pill in its place, over a blank page. */
function PillDemo({ state, width }: { state: BrowserPillState; width: number }) {
  return (
    <div
      className="bg-background overflow-hidden rounded-lg border"
      style={{ width, maxWidth: '100%' }}
    >
      <BrowserChrome
        url="https://www.northwind.example/pricing"
        canBack={false}
        canForward={false}
        onReload={() => {}}
        onSubmit={() => {}}
        agentDriving={state.kind === 'driving'}
        status={<BrowserStatusPill state={state} agentName="Atlas" now={NOW} {...NOOP_ACTIONS} />}
      />
      <div className="bg-muted/20 h-16" />
    </div>
  );
}

/**
 * The Agent browser's status pill (DOR-4428): who has the page, and the agent's
 * controls in its popover (a sheet on a phone). Press any pill to open it.
 */
export function BrowserStatusPillShowcases() {
  return (
    <PlaygroundSection
      title="Browser status pill"
      description="Who has the Agent browser's page, P1 to P9, with Take over, Pause, Resume and Hand back in its popover."
    >
      {STATES.map(({ label, state }) => (
        <div key={state.kind} data-pill-demo={state.kind}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <PillDemo state={state} width={640} />
          </ShowcaseDemo>
        </div>
      ))}
      <ShowcaseLabel>Narrow (400px): the icon alone, except Your turn</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2">
          <PillDemo state={{ kind: 'driving' }} width={400} />
          <PillDemo state={STATES[2]!.state} width={400} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
