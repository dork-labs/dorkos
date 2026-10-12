import { useState, type ReactNode } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui';
import {
  ConnectingStep,
  OnboardingFlow,
  OwnAiStep,
  ProgressCard,
  WelcomeStep,
  type DorkosConnectPhase,
  type FirstRunAccountLink,
  type FirstRunSlots,
} from '@/layers/features/onboarding';
import { DoeInferenceForm, renderRuntimeConnect } from '@/layers/features/runtime-connect';
import { FirstRunChips } from '@/layers/widgets/room-view';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';

// ── Mock data ────────────────────────────────────────────────

const noop = () => {};

const CLAUDE_READY: SystemRequirements['runtimes']['x'] = {
  state: 'ready',
  dependencies: [
    {
      name: 'Claude Code CLI',
      description: 'The Claude Code CLI powers agent chats in DorkOS.',
      status: 'satisfied',
      version: '1.0.31',
    },
    {
      name: 'Claude Code authentication',
      description: 'Signed in to Claude.',
      status: 'satisfied',
    },
  ],
};

const CODEX_CONNECT: SystemRequirements['runtimes']['x'] = {
  state: 'connect',
  connect: { kind: 'login', label: 'Connect Codex' },
  dependencies: [
    { name: 'Codex CLI', description: 'The Codex CLI binary.', status: 'satisfied' },
    {
      name: 'Codex authentication',
      description: 'ChatGPT OAuth or CODEX_API_KEY.',
      status: 'missing',
      installHint: 'codex login',
    },
  ],
};

const OPENCODE_INSTALL: SystemRequirements['runtimes']['x'] = {
  state: 'connect',
  connect: { kind: 'install', label: 'Install OpenCode' },
  dependencies: [
    {
      name: 'OpenCode CLI',
      description: 'The OpenCode binary.',
      status: 'missing',
      installHint: 'npm i -g opencode-ai',
    },
  ],
};

/** One AI app signed in (Claude Code), two more to add. */
const APPS_ONE_READY: SystemRequirements = {
  runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_CONNECT, opencode: OPENCODE_INSTALL },
};

/** Nothing signed in yet. */
const APPS_NONE_READY: SystemRequirements = {
  runtimes: { codex: CODEX_CONNECT, opencode: OPENCODE_INSTALL },
};

const PENDING = {
  userCode: 'DORK-2F7Q',
  verificationUri: 'https://dorkos.ai/activate',
  verificationUriComplete: 'https://dorkos.ai/activate?code=DORK-2F7Q',
};

/** A link that answers like the real one, without reaching anything. */
const MOCK_LINK: FirstRunAccountLink = {
  state: 'pending',
  pending: PENDING,
  starting: false,
  startError: null,
  start: async () => PENDING.userCode,
  cancel: async () => {},
  openBilling: noop,
  billingPending: false,
  billingNotice: null,
};

/** The flow's slots, with the link faked so nothing leaves the playground. */
const PLAYGROUND_SLOTS: FirstRunSlots = {
  renderAccountLink: (render) => render(MOCK_LINK),
  renderRuntimeConnect,
  renderOtherService: ({ onSave }) => <DoeInferenceForm onSave={onSave} />,
};

const CONNECTING_PHASES: ReadonlyArray<{ label: string; phase: DorkosConnectPhase }> = [
  { label: 'Starting — recording the path, asking for a code', phase: { kind: 'starting' } },
  {
    label: 'Waiting — the fallback for a blocked tab',
    phase: { kind: 'waiting', pending: PENDING },
  },
  { label: 'Finishing — approved, account getting ready', phase: { kind: 'finishing' } },
  { label: 'Needs a card', phase: { kind: 'needs-card' } },
  { label: 'Refused — outside the paid-plan countries', phase: { kind: 'refused' } },
  { label: 'Expired code', phase: { kind: 'expired' } },
  {
    label: 'Failed before a code came',
    phase: { kind: 'failed', message: 'Couldn’t reach DorkOS. Try again.' },
  },
];

// ── Showcases ────────────────────────────────────────────────

/** The first-run showcases: the whole flow, each screen and state, and the #team chips. */
export function OnboardingFlowShowcases() {
  return (
    <>
      <InteractiveFlowShowcase />
      <WelcomeStepShowcase />
      <ConnectingStepShowcase />
      <OwnAiStepShowcase />
      <FirstRunChipsShowcase />
      <ProgressCardShowcase />
    </>
  );
}

/** A tall, framed stage for one first-run screen. */
function Stage({ children, height = 'min-h-[560px]' }: { children: ReactNode; height?: string }) {
  return (
    <div className={`bg-background flex ${height} items-center justify-center rounded-lg py-8`}>
      {children}
    </div>
  );
}

function InteractiveFlowShowcase() {
  const [flowKey, setFlowKey] = useState(0);
  return (
    <PlaygroundSection
      title="OnboardingFlow"
      description="The whole first run: Welcome, then Continue with DorkOS (the link is faked here), Use my own AI, or Continue without an account. Rendered in a contained viewport."
    >
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => setFlowKey((k) => k + 1)}>
          Restart flow
        </Button>
      </div>
      <ShowcaseDemo>
        <div className="border-border bg-background relative h-[640px] overflow-hidden rounded-lg border">
          <OnboardingFlow key={flowKey} onComplete={noop} slots={PLAYGROUND_SLOTS} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function WelcomeStepShowcase() {
  return (
    <PlaygroundSection
      title="WelcomeStep"
      description="The first screen: the mark, the two lines, Continue with DorkOS with who can buy a plan under it, and two quiet ways round. No scan, no animation hold, no vendor names."
    >
      <ShowcaseDemo responsive>
        <Stage>
          <WelcomeStep onContinueWithDorkos={noop} onUseOwnAi={noop} onContinueWithout={noop} />
        </Stage>
      </ShowcaseDemo>
      <ShowcaseLabel>Setting up “Continue without an account”</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Stage>
          <WelcomeStep
            onContinueWithDorkos={noop}
            onUseOwnAi={noop}
            onContinueWithout={noop}
            busy="none"
          />
        </Stage>
      </ShowcaseDemo>
      <ShowcaseLabel>A pick that failed</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Stage>
          <WelcomeStep
            onContinueWithDorkos={noop}
            onUseOwnAi={noop}
            onContinueWithout={noop}
            error="Setup is only available on this computer."
          />
        </Stage>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ConnectingStepShowcase() {
  return (
    <PlaygroundSection
      title="ConnectingStep"
      description="Continue with DorkOS while the person finishes in the browser. It moves on by itself once the account is ready; every other state offers one way forward."
    >
      {CONNECTING_PHASES.map(({ label, phase }) => (
        <div key={phase.kind}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo responsive>
            <Stage height="min-h-[440px]">
              <ConnectingStep
                phase={phase}
                link={MOCK_LINK}
                onRetry={noop}
                onCancel={noop}
                onUseOwnAi={noop}
              />
            </Stage>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}

const OWN_AI_ROWS = [
  { row: undefined, label: 'The list, nothing open' },
  { row: 'openai', label: 'An OpenAI API key' },
  { row: 'anthropic', label: 'An Anthropic API key' },
  { row: 'openrouter', label: 'An OpenRouter key' },
  { row: 'local', label: 'A model on this computer' },
  { row: 'custom', label: 'Other service' },
] as const;

function OwnAiStepShowcase() {
  return (
    <PlaygroundSection
      title="OwnAiStep"
      description="Use my own AI: one list, the DorkOS engine first. Saving records the pick and lands in #team. The AI-app rows run on a simulated scan here, so nothing writes your own default."
    >
      {OWN_AI_ROWS.map(({ row, label }) => (
        <div key={label}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo responsive>
            <Stage>
              <OwnAiStep
                onBack={noop}
                onSaved={noop}
                slots={PLAYGROUND_SLOTS}
                initialRow={row}
                simulatedApps={{ requirements: APPS_ONE_READY, defaultRuntime: 'claude-code' }}
              />
            </Stage>
          </ShowcaseDemo>
        </div>
      ))}
      <ShowcaseLabel>An AI app you sign in to — one signed in</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Stage height="min-h-[760px]">
          <OwnAiStep
            onBack={noop}
            onSaved={noop}
            slots={PLAYGROUND_SLOTS}
            initialRow="agent-app"
            simulatedApps={{ requirements: APPS_ONE_READY, defaultRuntime: 'claude-code' }}
          />
        </Stage>
      </ShowcaseDemo>
      <ShowcaseLabel>An AI app you sign in to — none signed in yet</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Stage height="min-h-[760px]">
          <OwnAiStep
            onBack={noop}
            onSaved={noop}
            slots={PLAYGROUND_SLOTS}
            initialRow="agent-app"
            simulatedApps={{ requirements: APPS_NONE_READY }}
          />
        </Stage>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** DorkBot's first-run welcome, drawn plainly so the chips have something to sit under. */
function WelcomePreview({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-1 px-[var(--msg-padding-x)] pb-3 text-sm">
      <p className="font-medium">DorkBot</p>
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

function FirstRunChipsShowcase() {
  return (
    <PlaygroundSection
      title="FirstRunChips"
      description="The strip under DorkBot's first-run welcome in #team, until the person posts. With AI connected a chip is the first message to DorkBot; with no AI yet it offers the two ways to connect."
    >
      <ShowcaseLabel>Agents ready — first jobs</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <WelcomePreview
          lines={[
            'Hi Dorian. Your agents run on DorkOS. Usage is in Settings.',
            'Want a first tool? Pick one below, or tell me what you need.',
          ]}
        />
        <FirstRunChips roomId="playground-team" mode="starters" />
      </ShowcaseDemo>
      <ShowcaseLabel>No AI yet — the two ways to connect</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <WelcomePreview
          lines={['Hi there. Agents need AI to reply. Connect DorkOS or your own.']}
        />
        <FirstRunChips roomId="playground-team" mode="connect" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ProgressCardShowcase() {
  return (
    <PlaygroundSection
      title="ProgressCard"
      description="Compact sidebar 'Getting started' card. Each row deep-links into a real surface (create an agent, schedule a task, add more agents). After a first run that set up an AI, the 'Join the DorkOS community' offer sits above the rows; it is hidden here because the playground names no official space."
    >
      <ShowcaseDemo>
        <div className="mx-auto max-w-xs">
          <ProgressCard onDismiss={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
