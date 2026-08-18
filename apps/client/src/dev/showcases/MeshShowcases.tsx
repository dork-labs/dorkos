import { useState } from 'react';
import { Search } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MeshEmptyState, TopologyPreview } from '@/layers/features/mesh/ui/MeshEmptyState';
import { OpenMeshSwitchRow, OpenMeshNoticeRow } from '@/layers/entities/mesh';

/** Mesh feature component showcases: MeshEmptyState, the mesh-wide switch. */
export function MeshShowcases() {
  const [switchOn, setSwitchOn] = useState(false);
  const [noticeOn, setNoticeOn] = useState(false);

  return (
    <>
      <PlaygroundSection
        title="MeshEmptyState"
        description="Empty state for the mesh panel with optional topology preview."
      >
        <ShowcaseLabel>With action CTA</ShowcaseLabel>
        <ShowcaseDemo>
          <MeshEmptyState
            icon={Search}
            headline="No agents discovered"
            description="Register an agent to start building your mesh network."
            action={{ label: 'Register Agent', onClick: () => {} }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With topology preview</ShowcaseLabel>
        <ShowcaseDemo>
          <MeshEmptyState
            icon={Search}
            headline="No agents discovered"
            description="Register an agent to start building your mesh network."
            action={{ label: 'Register Agent', onClick: () => {} }}
            preview={<TopologyPreview />}
          />
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
    </>
  );
}
