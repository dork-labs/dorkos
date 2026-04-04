import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui';
import {
  OnboardingFlow,
  SystemRequirementsStep,
  WelcomeStep,
  MeetDorkBotStep,
  AgentDiscoveryStep,
  TaskTemplatesStep,
  AdapterSetupStep,
  OnboardingComplete,
  OnboardingNavBar,
  ProgressCard,
  NoAgentsFound,
} from '@/layers/features/onboarding';
import { CandidateCard, BulkAddBar, CollapsibleImportedSection } from '@/layers/entities/discovery';
import type {
  DiscoveryCandidate,
  ExistingAgent,
  AgentPathEntry,
} from '@dorkos/shared/mesh-schemas';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';

// ── Mock data ────────────────────────────────────────────────

const MOCK_CANDIDATES: DiscoveryCandidate[] = [
  {
    path: '/Users/kai/projects/webapp/.claude',
    strategy: 'filesystem',
    hints: {
      suggestedName: 'webapp-agent',
      detectedRuntime: 'claude-code',
      inferredCapabilities: ['code-review', 'testing'],
      description: 'Web application development agent',
    },
    discoveredAt: '2026-03-17T10:30:00Z',
  },
  {
    path: '/Users/kai/projects/api-server/.cursor',
    strategy: 'filesystem',
    hints: {
      suggestedName: 'api-agent',
      detectedRuntime: 'cursor',
      inferredCapabilities: ['deployment'],
      description: 'API server maintenance agent',
    },
    discoveredAt: '2026-03-17T10:30:01Z',
  },
  {
    path: '/Users/kai/projects/ml-pipeline/.claude',
    strategy: 'filesystem',
    hints: {
      suggestedName: 'ml-agent',
      detectedRuntime: 'claude-code',
      inferredCapabilities: ['data-processing', 'monitoring'],
      description: 'ML pipeline orchestration agent',
    },
    discoveredAt: '2026-03-17T10:30:02Z',
  },
];

const MOCK_EXISTING_AGENTS: ExistingAgent[] = [
  {
    path: '/Users/kai/projects/dorkbot',
    name: 'dorkbot',
    runtime: 'claude-code',
    description: 'System agent',
  },
  {
    path: '/Users/kai/projects/blog',
    name: 'blog',
    runtime: 'cursor',
    description: 'Blog site project',
  },
];

const MOCK_AGENTS: AgentPathEntry[] = [
  {
    id: 'webapp-agent',
    name: 'webapp-agent',
    projectPath: '/Users/kai/projects/webapp',
  },
  {
    id: 'api-agent',
    name: 'api-agent',
    projectPath: '/Users/kai/projects/api-server',
  },
];

const noop = () => {};

const MOCK_REQUIREMENTS_SATISFIED: SystemRequirements = {
  runtimes: {
    'claude-code': {
      dependencies: [
        {
          name: 'Claude Code CLI',
          description: 'The Claude Code CLI powers agent sessions in DorkOS.',
          status: 'satisfied',
          version: '1.0.31',
        },
      ],
    },
  },
  allSatisfied: true,
};

const MOCK_REQUIREMENTS_MISSING: SystemRequirements = {
  runtimes: {
    'claude-code': {
      dependencies: [
        {
          name: 'Claude Code CLI',
          description: 'The Claude Code CLI powers agent sessions in DorkOS.',
          status: 'missing',
          installHint: 'curl -fsSL https://claude.ai/install.sh | bash',
          infoUrl: 'https://docs.anthropic.com/en/docs/claude-code',
        },
      ],
    },
  },
  allSatisfied: false,
};

// ── Showcases ────────────────────────────────────────────────

/** Comprehensive onboarding showcases — full flow, individual steps, and supporting components. */
export function OnboardingFlowShowcases() {
  return (
    <>
      <InteractiveFlowShowcase />
      <SystemRequirementsStepShowcase />
      <WelcomeStepShowcase />
      <MeetDorkBotStepShowcase />
      <AgentDiscoveryStepShowcase />
      <TaskTemplatesStepShowcase />
      <AdapterSetupStepShowcase />
      <OnboardingCompleteShowcase />
      <OnboardingNavBarShowcase />
      <ProgressCardShowcase />
      <NoAgentsFoundShowcase />
    </>
  );
}

// ── Full flow ────────────────────────────────────────────────

function InteractiveFlowShowcase() {
  const [flowKey, setFlowKey] = useState(0);

  return (
    <PlaygroundSection
      title="OnboardingFlow"
      description="Full interactive onboarding flow. Click through each step — Welcome, System Requirements (3s scan), Meet DorkBot, Project Import, Tasks, and Complete. Rendered in a contained viewport."
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
  const [happyKey, setHappyKey] = useState(0);
  const [sadKey, setSadKey] = useState(0);

  return (
    <PlaygroundSection
      title="SystemRequirementsStep"
      description="System requirements check — three-phase experience: scanning animation (3s), progressive row-by-row reveal with scan-to-result transitions, then celebration (confetti) or install guidance. Click Replay to restart the full animation."
    >
      <ShowcaseLabel>Happy path — all requirements satisfied</ShowcaseLabel>
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => setHappyKey((k) => k + 1)}>
          Replay
        </Button>
      </div>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[450px] items-center justify-center">
          <SystemRequirementsStep
            key={`happy-${happyKey}`}
            onContinue={noop}
            simulatedResult={MOCK_REQUIREMENTS_SATISFIED}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Unhappy path — missing dependency</ShowcaseLabel>
      <div className="mb-3">
        <Button variant="outline" size="sm" onClick={() => setSadKey((k) => k + 1)}>
          Replay
        </Button>
      </div>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[550px] items-center justify-center">
          <SystemRequirementsStep
            key={`sad-${sadKey}`}
            onContinue={noop}
            simulatedResult={MOCK_REQUIREMENTS_MISSING}
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

function MeetDorkBotStepShowcase() {
  return (
    <PlaygroundSection
      title="MeetDorkBotStep"
      description="DorkBot personality customization with trait sliders, avatar breathing animation, and live preview text. Sliders are fully interactive."
    >
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-2xl px-4 py-4">
          <MeetDorkBotStep onStepComplete={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function AgentDiscoveryStepShowcase() {
  return (
    <PlaygroundSection
      title="AgentDiscoveryStep"
      description="Project import step with auto-scan. The live component shows the scanning state (mock transport has no real scan results). Static showcases below demonstrate all visual states."
    >
      <ShowcaseLabel>Live — scanning state (auto-scan, mock transport)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[300px] flex-col px-4 py-4">
          <AgentDiscoveryStep onStepComplete={noop} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>State: existing + new projects (Option A layout)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[300px] flex-col items-center px-4 py-4">
          <div className="w-full shrink-0 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Projects Found</h2>
            <p className="text-muted-foreground mt-3 shrink-0 text-center text-sm">
              Adding a project lets you manage it from DorkOS — assign agents, schedule tasks, and
              connect to Slack, Telegram, and more.
            </p>
          </div>
          <div className="mt-4 w-full space-y-3">
            <BulkAddBar count={MOCK_CANDIDATES.length} onAddAll={noop} />
            {MOCK_CANDIDATES.map((candidate) => (
              <CandidateCard
                key={candidate.path}
                candidate={candidate}
                onApprove={noop}
                onSkip={noop}
              />
            ))}
            <CollapsibleImportedSection agents={MOCK_EXISTING_AGENTS} />
          </div>
          <div className="mt-4 flex shrink-0 flex-col items-center gap-2 border-t pt-4">
            <Button size="lg">Continue</Button>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>State: all projects already imported</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[200px] flex-col items-center px-4 py-4">
          <div className="w-full shrink-0 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Projects Found</h2>
            <p className="text-muted-foreground mt-3 shrink-0 text-center text-sm">
              Adding a project lets you manage it from DorkOS — assign agents, schedule tasks, and
              connect to Slack, Telegram, and more.
            </p>
          </div>
          <div className="mt-4 w-full">
            <CollapsibleImportedSection agents={MOCK_EXISTING_AGENTS} />
          </div>
          <div className="mt-4 flex shrink-0 flex-col items-center gap-2 border-t pt-4">
            <Button size="lg">Continue</Button>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>State: error</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex min-h-[150px] flex-col items-center px-4 py-4">
          <div className="w-full shrink-0 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Searching your machine...
            </h2>
          </div>
          <div className="border-destructive/30 bg-destructive/5 text-destructive mt-6 shrink-0 rounded-lg border px-4 py-3 text-sm">
            Failed to scan directories: EACCES permission denied
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function TaskTemplatesStepShowcase() {
  return (
    <PlaygroundSection
      title="TaskTemplatesStep"
      description="Task schedule template selection. Shown with mock agents — the template list loads from the mock transport."
    >
      <ShowcaseLabel>With 2 agents</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="min-h-[300px] py-4">
          <TaskTemplatesStep onStepComplete={noop} agents={MOCK_AGENTS} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>With 1 agent (auto-resolved)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="min-h-[200px] py-4">
          <TaskTemplatesStep onStepComplete={noop} agents={[MOCK_AGENTS[0]]} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function AdapterSetupStepShowcase() {
  return (
    <PlaygroundSection
      title="AdapterSetupStep"
      description="Adapter connection step showing available communication channels (Telegram, Slack, Webhook). Currently not in the active flow but fully implemented."
    >
      <ShowcaseDemo responsive>
        <div className="py-4">
          <AdapterSetupStep onStepComplete={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function OnboardingCompleteShowcase() {
  return (
    <PlaygroundSection
      title="OnboardingComplete"
      description="Completion screen with word-by-word heading animation, step summary cards, and confetti. Fires confetti on mount."
    >
      <OnboardingCompleteInner />
    </PlaygroundSection>
  );
}

function OnboardingCompleteInner() {
  const [remountKey, setRemountKey] = useState(0);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRemountKey((k) => k + 1)}
        className="mb-3"
      >
        Replay animation
      </Button>
      <ShowcaseDemo>
        <div className="flex min-h-[400px] items-center justify-center">
          <OnboardingComplete key={remountKey} onComplete={noop} />
        </div>
      </ShowcaseDemo>
    </>
  );
}

// ── Supporting components ────────────────────────────────────

function OnboardingNavBarShowcase() {
  const [step, setStep] = useState(1);

  return (
    <PlaygroundSection
      title="OnboardingNavBar"
      description="Step navigation bar with Back, animated step indicator dots, and Skip / Skip all controls. Click Back/Skip to cycle through steps."
    >
      <ShowcaseLabel>{`3 steps, current: ${step}`}</ShowcaseLabel>
      <ShowcaseDemo>
        <OnboardingNavBar
          totalSteps={3}
          currentStep={step}
          onBack={() => setStep((s) => Math.max(0, s - 1))}
          onSkip={() => setStep((s) => Math.min(2, s + 1))}
          onSkipAll={noop}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>5 steps, current: 0</ShowcaseLabel>
      <ShowcaseDemo>
        <OnboardingNavBar
          totalSteps={5}
          currentStep={0}
          onBack={noop}
          onSkip={noop}
          onSkipAll={noop}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ProgressCardShowcase() {
  return (
    <PlaygroundSection
      title="ProgressCard"
      description="Compact sidebar card showing remaining onboarding steps. Renders with the current onboarding state from the mock transport."
    >
      <ShowcaseDemo>
        <div className="mx-auto max-w-xs">
          <ProgressCard onStepClick={noop} onDismiss={noop} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function NoAgentsFoundShowcase() {
  return (
    <PlaygroundSection
      title="NoAgentsFound"
      description="Fallback form shown when discovery finds zero projects. Includes directory picker, name input, and persona textarea."
    >
      <ShowcaseDemo responsive>
        <NoAgentsFound onAgentCreated={noop} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
