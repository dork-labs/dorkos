import { useState } from 'react';
import { Search } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { EmptyState } from '@/layers/shared/ui';
import { TopologyPreview } from '@/layers/features/mesh';
import { OpenMeshSwitchRow, OpenMeshNoticeRow } from '@/layers/entities/mesh';
import { CandidateCard } from '@/layers/entities/discovery';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';

const FAILED_IMPORT_CANDIDATE: DiscoveryCandidate = {
  path: '/Users/kai/Projects/scout',
  strategy: 'codex',
  hints: {
    suggestedName: 'Scout',
    detectedRuntime: 'codex',
    inferredCapabilities: ['code-review', 'search'],
  },
  discoveredAt: '2026-09-08T00:00:00.000Z',
};

/** Mesh feature showcases for topology, visibility, and project import states. */
export function MeshShowcases() {
  const [switchOn, setSwitchOn] = useState(false);
  const [noticeOn, setNoticeOn] = useState(false);

  return (
    <>
      <PlaygroundSection
        title="TopologyPreview"
        description="The faded three-node sketch the Mesh panel shows above its empty state, so an empty panel still shows the shape of the thing it is missing. Rendered here inside the shared EmptyState that hosts it."
      >
        <ShowcaseLabel>In the empty state that uses it</ShowcaseLabel>
        <ShowcaseDemo>
          <EmptyState
            icon={Search}
            headline="No agents discovered"
            description="Register an agent to start building your mesh network."
            action={{ label: 'Register Agent', onClick: () => {} }}
            preview={<TopologyPreview />}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>On its own</ShowcaseLabel>
        <ShowcaseDemo>
          <TopologyPreview />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="OpenMeshSwitch"
        description="The mesh-wide 'Let all my agents talk to each other' switch — the Access view row, and the calmer notice the agent-creation flow shows when a new agent is about to land somewhere it cannot be reached."
      >
        <ShowcaseLabel>Access view row (drive it — off and on)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="w-full max-w-2xl">
            <OpenMeshSwitchRow checked={switchOn} onCheckedChange={setSwitchOn} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Access view row, mid-flight (disabled while the rule is written)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="w-full max-w-2xl">
            <OpenMeshSwitchRow checked onCheckedChange={() => {}} disabled />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Agent-creation notice</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="w-full max-w-2xl">
            <OpenMeshNoticeRow checked={noticeOn} onCheckedChange={setNoticeOn} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="CandidateCard — Import failed"
        description="A discovered project stays visible after an import fails, with a clear retry action."
      >
        <ShowcaseDemo responsive>
          <div className="max-w-2xl">
            <CandidateCard
              candidate={FAILED_IMPORT_CANDIDATE}
              registrationFailed
              onApprove={() => {}}
              onSkip={() => {}}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
