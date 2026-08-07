import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { FEATURES_SECTIONS } from '../playground-registry';
import { AgentIdentityShowcases } from '../showcases/AgentIdentityShowcases';
import { AgentSidebarShowcases } from '../showcases/AgentSidebarShowcases';
import { AgentFleetShowcases } from '../showcases/AgentFleetShowcases';
import { TeamShowcases } from '../showcases/TeamShowcases';
import { RelayShowcases } from '../showcases/RelayShowcases';
import { AdapterWizardShowcases } from '../showcases/AdapterWizardShowcases';
import { MeshShowcases } from '../showcases/MeshShowcases';
import { TasksShowcases } from '../showcases/TasksShowcases';
import { PersonalityPickerShowcases } from '../showcases/PersonalityPickerShowcases';
import { PipPanelShowcases } from '../showcases/PipPanelShowcases';
import { ApprovalsShowcases } from '../showcases/ApprovalsShowcases';
import { ConnectionsShowcases } from '../showcases/ConnectionsShowcases';

/** Feature component showcase page for the dev playground. */
export function FeaturesPage() {
  return (
    <PlaygroundPageLayout
      title="Feature Components"
      description="Domain-specific components from Relay, Mesh, and Tasks features."
      sections={FEATURES_SECTIONS}
    >
      <PersonalityPickerShowcases />
      <AgentIdentityShowcases />
      <TeamShowcases />
      <AgentSidebarShowcases />
      <AgentFleetShowcases />
      <RelayShowcases />
      <AdapterWizardShowcases />
      <MeshShowcases />
      <TasksShowcases />
      <PipPanelShowcases />
      <ApprovalsShowcases />
      <ConnectionsShowcases />
    </PlaygroundPageLayout>
  );
}
