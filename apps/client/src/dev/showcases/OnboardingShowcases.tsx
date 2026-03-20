import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Button } from '@/layers/shared/ui';
import { WelcomeStep, DiscoveryCelebration } from '@/layers/features/onboarding';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

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

/** Onboarding feature component showcases: WelcomeStep, DiscoveryCelebration. */
export function OnboardingShowcases() {
  return (
    <>
      <PlaygroundSection
        title="WelcomeStep"
        description="Onboarding welcome screen with get-started and skip actions."
      >
        <ShowcaseDemo>
          <WelcomeStep onGetStarted={() => {}} onSkip={() => {}} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <DiscoveryCelebrationShowcase />
    </>
  );
}

function DiscoveryCelebrationShowcase() {
  const [remountKey, setRemountKey] = useState(0);

  return (
    <PlaygroundSection
      title="DiscoveryCelebration"
      description="Animated celebration after agent discovery. Use the button to replay."
    >
      <ShowcaseLabel>With 3 discovered candidates</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-3">
          <Button variant="outline" size="sm" onClick={() => setRemountKey((k) => k + 1)}>
            Replay animation
          </Button>
          <DiscoveryCelebration
            key={remountKey}
            candidates={MOCK_CANDIDATES}
            onComplete={() => {}}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
