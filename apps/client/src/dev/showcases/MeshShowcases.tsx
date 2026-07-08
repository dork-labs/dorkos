import { Search } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MeshEmptyState, TopologyPreview } from '@/layers/features/mesh/ui/MeshEmptyState';

/** Mesh feature component showcases: MeshEmptyState. */
export function MeshShowcases() {
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
    </>
  );
}
