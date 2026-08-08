import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { FEATURES_SECTIONS } from '../playground-registry';
import { AgentSidebarShowcases } from '../showcases/AgentSidebarShowcases';
import { JumpBackInShowcases } from '../showcases/JumpBackInShowcases';
import { AgentFleetShowcases } from '../showcases/AgentFleetShowcases';
import { RelayShowcases } from '../showcases/RelayShowcases';
import { AdapterWizardShowcases } from '../showcases/AdapterWizardShowcases';
import { MeshShowcases } from '../showcases/MeshShowcases';
import { TasksShowcases } from '../showcases/TasksShowcases';
import { PersonalityPickerShowcases } from '../showcases/PersonalityPickerShowcases';
import { PipPanelShowcases } from '../showcases/PipPanelShowcases';
import { ApprovalsShowcases } from '../showcases/ApprovalsShowcases';
import { TriageHeaderShowcases } from '../showcases/TriageHeaderShowcases';
import { ConnectionsShowcases } from '../showcases/ConnectionsShowcases';
import { McpServerCardShowcases } from '../showcases/McpServerCardShowcases';

/** Feature component showcase page for the dev playground. */
export function FeaturesPage() {
  return (
    <PlaygroundPageLayout
      title="Feature Components"
      description="Domain-specific components from Relay, Mesh, and Tasks features."
      sections={FEATURES_SECTIONS}
    >
      <PersonalityPickerShowcases />
      <AgentSidebarShowcases />
      <JumpBackInShowcases />
      <AgentFleetShowcases />
      <RelayShowcases />
      <AdapterWizardShowcases />
      <MeshShowcases />
      <TasksShowcases />
      <PipPanelShowcases />
      <ApprovalsShowcases />
      <TriageHeaderShowcases />
      <ConnectionsShowcases />
      <McpServerCardShowcases />
    </PlaygroundPageLayout>
  );
}
