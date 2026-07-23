import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui';
import {
  OnboardingFlow,
  SystemRequirementsStep,
  WelcomeStep,
  OnboardingNavBar,
  ProgressCard,
} from '@/layers/features/onboarding';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';

// ── Mock data ────────────────────────────────────────────────

const noop = () => {};

const CLAUDE_READY: SystemRequirements['runtimes']['x'] = {
  state: 'ready',
  dependencies: [
    {
      name: 'Claude Code CLI',
      description: 'The Claude Code CLI powers agent sessions in DorkOS.',
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

/** One runtime ready (Claude), two available to add — the common first run. */
const MOCK_REQUIREMENTS_ONE_READY: SystemRequirements = {
  runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_CONNECT, opencode: OPENCODE_INSTALL },
};

/** Everything connected — a pure success moment with no "more agents" count. */
const MOCK_REQUIREMENTS_ALL_READY: SystemRequirements = {
  runtimes: {
    'claude-code': CLAUDE_READY,
    codex: { ...CODEX_CONNECT, state: 'ready', connect: undefined },
  },
};

/** Nothing ready yet — the connect-your-first-agent gate. */
const MOCK_REQUIREMENTS_ZERO_READY: SystemRequirements = {
  runtimes: { codex: CODEX_CONNECT, opencode: OPENCODE_INSTALL },
};

// ── Showcases ────────────────────────────────────────────────

/** Comprehensive onboarding showcases — full flow, individual steps, and supporting components. */
export function OnboardingFlowShowcases() {
  return (
    <>
      <InteractiveFlowShowcase />
      <SystemRequirementsStepShowcase />
      <WelcomeStepShowcase />
      <OnboardingNavBarShowcase />
      <ProgressCardShowcase />
    </>
  );
}

// ── Full flow ────────────────────────────────────────────────

function InteractiveFlowShowcase() {
  const [flowKey, setFlowKey] = useState(0);

  return (
    <PlaygroundSection
      title="OnboardingFlow"
      description="Full interactive onboarding: Welcome, the ready-first setup check, then the scripted DorkBot conversation (personality, discovery, and the handoff composer). Rendered in a contained viewport."
    >
      <div className="mb-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setFlowKey((k) => k + 1)}>
          Restart flow
        </Button>
        <span className="text-muted-foreground text-xs">
          Some steps may show loading states due to mock transport
        </span>
      </div>
      <ShowcaseDemo>
        <div className="border-border bg-background relative h-[600px] overflow-hidden rounded-lg border">
          <OnboardingFlow key={flowKey} onComplete={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── Individual steps ─────────────────────────────────────────

function SystemRequirementsStepShowcase() {
  const [oneKey, setOneKey] = useState(0);
  const [allKey, setAllKey] = useState(0);
  const [zeroKey, setZeroKey] = useState(0);

  return (
    <PlaygroundSection
      title="SystemRequirementsStep"
      description="First-run setup check, ready-first. A brief scan animation, then one of three outcomes: at least one agent ready (a 'Get started' success moment with a quiet disclosure to add more), everything ready (no disclosure count), or nothing ready yet (connect cards that do the setup). Click Replay to restart the scan."
    >
      <ShowcaseLabel>At least one ready — Claude connected, two more available</ShowcaseLabel>
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => setOneKey((k) => k + 1)}>
          Replay
        </Button>
      </div>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[520px] items-center justify-center">
          <SystemRequirementsStep
            key={`one-${oneKey}`}
            onContinue={noop}
            renderConnect={renderRuntimeConnect}
            simulatedResult={MOCK_REQUIREMENTS_ONE_READY}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Everything ready — no "more agents" count</ShowcaseLabel>
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => setAllKey((k) => k + 1)}>
          Replay
        </Button>
      </div>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[420px] items-center justify-center">
          <SystemRequirementsStep
            key={`all-${allKey}`}
            onContinue={noop}
            renderConnect={renderRuntimeConnect}
            simulatedResult={MOCK_REQUIREMENTS_ALL_READY}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing ready yet — connect your first agent</ShowcaseLabel>
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => setZeroKey((k) => k + 1)}>
          Replay
        </Button>
      </div>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[560px] items-center justify-center">
          <SystemRequirementsStep
            key={`zero-${zeroKey}`}
            onContinue={noop}
            renderConnect={renderRuntimeConnect}
            simulatedResult={MOCK_REQUIREMENTS_ZERO_READY}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function WelcomeStepShowcase() {
  return (
    <PlaygroundSection
      title="WelcomeStep"
      description="Initial welcome screen with word-by-word heading animation, preview items, and Get Started / Skip actions."
    >
      <ShowcaseDemo responsive>
        <div className="flex min-h-[400px] items-center justify-center">
          <WelcomeStep onGetStarted={noop} onSkip={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ── Supporting components ────────────────────────────────────

function OnboardingNavBarShowcase() {
  return (
    <PlaygroundSection
      title="OnboardingNavBar"
      description="The conversation's slim nav bar — Back to the ready gate and Skip setup. No step dots (a conversation is not a dotted wizard)."
    >
      <ShowcaseDemo>
        <OnboardingNavBar onBack={noop} onSkip={noop} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ProgressCardShowcase() {
  return (
    <PlaygroundSection
      title="ProgressCard"
      description="Compact sidebar 'Getting started' card. Each row deep-links into a real surface (create an agent, schedule a task, add more agents)."
    >
      <ShowcaseDemo>
        <div className="mx-auto max-w-xs">
          <ProgressCard onDismiss={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
